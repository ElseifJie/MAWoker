import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRepositories } from "../packages/db/src/index.js";

const databaseUrl = process.env.TEST_POSTGRES_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

/**
 * A11: a live-but-slow worker whose lease expired must lose the job to the
 * taker-over — and once the row-level lease generation moved, the old
 * execution can no longer write checkpoints, outcomes, or renew its lease.
 */
describeWithPostgres("Job lease generation in real PostgreSQL", () => {
  const schemaName = `t15_lease_${randomUUID().replaceAll("-", "")}`;
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({
      connectionString: databaseUrl,
      max: 2,
      options: `-c search_path=${schemaName} -c statement_timeout=15000`,
    });
    await pool.query(`create schema "${schemaName}"`);
    // The generated migrations hardcode the "public". schema prefix; scope
    // every statement to the isolated schema instead (same approach as the
    // Task 09 quota gate).
    const migrationsDirectory = resolve(
      import.meta.dirname,
      "../packages/db/migrations",
    );
    const names = (await readdir(migrationsDirectory))
      .filter((name) => /^\d{4}_/.test(name))
      .sort();
    // Some migrations (0022) rely on transaction-scoped temporary tables,
    // so each file runs inside one transaction on a dedicated connection.
    const connection = await pool.connect();
    try {
      for (const name of names) {
        const migration = (
          await readFile(resolve(migrationsDirectory, name), "utf8")
        ).replaceAll('"public".', `"${schemaName}".`);
        await connection.query("begin");
        for (const statement of migration.split("--> statement-breakpoint")) {
          if (statement.trim()) await connection.query(statement);
        }
        await connection.query("commit");
      }
    } finally {
      connection.release();
    }
  });

  afterAll(async () => {
    await pool.query(`drop schema if exists "${schemaName}" cascade`);
    await pool.end();
  });

  it("takes over an expired lease and blocks every stale-owner state write", async () => {
    const repositories = createRepositories(drizzle(pool));
    const ownerId = randomUUID();
    const sessionId = randomUUID();
    await pool.query(
      `insert into users (id, auth_subject, email) values ($1, $2, $3)`,
      [ownerId, `subject-${ownerId}`, `${ownerId}@example.com`],
    );
    await pool.query(
      `insert into background_jobs
        (id, owner_user_id, type, status, priority, payload, run_after)
       values ($1, $2, 'delete_session', 'pending', 80,
               $3::jsonb, now())`,
      [sessionId, ownerId, JSON.stringify({ sessionId, completed: {} })],
    );

    // The slow worker claims the job and stalls past the lease window.
    const [first] = await repositories.jobs.claim({
      workerId: "slow-worker",
      limit: 1,
      types: ["delete_session"],
    });
    expect(first).toBeDefined();
    expect(first.leaseGeneration).toBe(1);
    await pool.query(
      `update background_jobs set locked_at = now() - interval '10 minutes'
        where id = $1`,
      [sessionId],
    );

    // A second worker takes the expired lease over: the generation moves.
    const [second] = await repositories.jobs.claim({
      workerId: "fast-worker",
      limit: 1,
      types: ["delete_session"],
    });
    expect(second).toBeDefined();
    expect(second.lockedBy).toBe("fast-worker");
    expect(second.leaseGeneration).toBe(2);

    // The stale owner's heartbeat cannot renew the moved lease...
    await expect(
      repositories.jobs.heartbeat({
        items: [{ id: sessionId, leaseGeneration: first.leaseGeneration }],
        workerId: "slow-worker",
      }),
    ).resolves.toBe(0);
    // ...while the current owner's does.
    await expect(
      repositories.jobs.heartbeat({
        items: [{ id: sessionId, leaseGeneration: second.leaseGeneration }],
        workerId: "fast-worker",
      }),
    ).resolves.toBe(1);

    // Every stale-owner state write is a no-op: no checkpoint...
    await expect(
      repositories.jobs.updatePayload(
        sessionId,
        "slow-worker",
        { sessionId, completed: { nonRunningObserved: true } },
        first.leaseGeneration,
      ),
    ).rejects.toThrow();
    // ...no completion...
    await repositories.jobs.succeed(
      sessionId,
      "slow-worker",
      first.leaseGeneration,
    );
    const stillRunning = await pool.query<{ status: string }>(
      `select status::text from background_jobs where id = $1`,
      [sessionId],
    );
    expect(stillRunning.rows[0]!.status).toBe("running");
    // ...and no retry accounting: the stale owner cannot even fail the job.
    await repositories.jobs.retry(
      sessionId,
      "slow-worker",
      "STALE_WRITE",
      true,
      first.leaseGeneration,
    );
    const afterRetry = await pool.query<{
      status: string;
      last_error: string | null;
    }>(`select status::text, last_error from background_jobs where id = $1`, [
      sessionId,
    ]);
    expect(afterRetry.rows[0]!.status).toBe("running");
    expect(afterRetry.rows[0]!.last_error).toBeNull();

    // The current owner completes the job normally.
    await repositories.jobs.succeed(
      sessionId,
      "fast-worker",
      second.leaseGeneration,
    );
    const done = await pool.query<{ status: string }>(
      `select status::text from background_jobs where id = $1`,
      [sessionId],
    );
    expect(done.rows[0]!.status).toBe("succeeded");
  });
});

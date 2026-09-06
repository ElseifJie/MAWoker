import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRepositories } from "../packages/db/src/index.js";

const databaseUrl = process.env.TEST_POSTGRES_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("background job contention in real PostgreSQL", () => {
  const schemaName = `task2_contention_${randomUUID().replaceAll("-", "")}`;
  let administrationPool: Pool;
  let workerPool: Pool;

  beforeAll(async () => {
    administrationPool = new Pool({ connectionString: databaseUrl });
    await administrationPool.query(`create schema "${schemaName}"`);

    workerPool = new Pool({
      connectionString: databaseUrl,
      max: 3,
      options: `-c search_path=${schemaName}`,
    });
    await workerPool.query(
      `create table background_jobs (
        id uuid primary key,
        owner_user_id uuid,
        type text not null,
        status text not null default 'pending',
        priority integer not null default 100,
        payload jsonb not null default '{}'::jsonb,
        attempts integer not null default 0,
        max_attempts integer not null default 10,
        run_after timestamptz not null default now(),
        locked_at timestamptz,
        locked_by text,
        last_error text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )`,
    );
  });

  afterAll(async () => {
    await workerPool?.end();
    if (administrationPool) {
      await administrationPool.query(
        `drop schema if exists "${schemaName}" cascade`,
      );
      await administrationPool.end();
    }
  });

  it("skips a row locked by another backend and leaves it claimable", async () => {
    const highPriorityId = randomUUID();
    const nextPriorityId = randomUUID();
    const now = new Date();
    await workerPool.query(
      `insert into background_jobs
        (id, type, priority, run_after, created_at)
       values ($1, 'delete_session', 10, $3, $3),
              ($2, 'cleanup_upload', 20, $3, $3)`,
      [highPriorityId, nextPriorityId, now],
    );

    const locker = await workerPool.connect();
    await locker.query("begin");
    await locker.query(
      `select id from background_jobs where id = $1 for update`,
      [highPriorityId],
    );

    try {
      const repositories = createRepositories(drizzle(workerPool));
      const claimedWhileLocked = await repositories.jobs.claim({
        workerId: "worker-1",
        limit: 1,
        now,
      });

      expect(claimedWhileLocked.map(({ id }) => id)).toEqual([nextPriorityId]);
    } finally {
      await locker.query("rollback");
      locker.release();
    }

    const repositories = createRepositories(drizzle(workerPool));
    const claimedAfterRelease = await repositories.jobs.claim({
      workerId: "worker-2",
      limit: 1,
      now,
    });
    expect(claimedAfterRelease.map(({ id }) => id)).toEqual([highPriorityId]);
  });
});

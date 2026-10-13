import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRepositories } from "../packages/db/src/index.js";

const databaseUrl = process.env.TEST_POSTGRES_URL;
(databaseUrl ? describe : describe.skip)(
  "session delivery PostgreSQL races",
  () => {
    const schema = `a3_delivery_${randomUUID().replaceAll("-", "")}`;
    let pool: Pool;
    beforeAll(async () => {
      pool = new Pool({
        connectionString: databaseUrl,
        max: 4,
        options: `-c search_path=${schema} -c statement_timeout=15000`,
      });
      await pool.query(`create schema "${schema}"`);
      const directory = resolve(
        import.meta.dirname,
        "../packages/db/migrations",
      );
      const connection = await pool.connect();
      try {
        for (const name of (await readdir(directory))
          .filter((name) => /^\d{4}_.*\.sql$/.test(name))
          .sort()) {
          const migration = (
            await readFile(resolve(directory, name), "utf8")
          ).replaceAll('"public".', `"${schema}".`);
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
      if (pool) {
        await pool.query(`drop schema if exists "${schema}" cascade`);
        await pool.end();
      }
    });

    async function fixture() {
      const userId = randomUUID(),
        sessionId = randomUUID(),
        agentId = randomUUID();
      const artifactId = randomUUID(),
        driveId = randomUUID();
      await pool.query(
        "insert into users(id,auth_subject,email) values($1,$2,$3)",
        [userId, userId, `${userId}@example.com`],
      );
      await pool.query(
        "insert into personal_agents(id,owner_user_id,ark_agent_id,name,model_id,system_prompt,ark_version,status) values($1,$2,'agent','Agent','model','prompt','1','active')",
        [agentId, userId],
      );
      await pool.query(
        "insert into sessions(id,owner_user_id,personal_agent_id,ark_session_id,agent_kind,ark_agent_id,agent_version,environment_id,title,status) values($1,$2,$3,$4,'personal','agent','1','env','Task','idle')",
        [sessionId, userId, agentId, `ark-${sessionId}`],
      );
      await pool.query(
        "insert into drive_files(id,owner_user_id,origin,tos_object_key,name,mime_type,size_bytes,source_session_id,deletion_state) values($1,$2,'artifact',$3,'report.txt','text/plain',6,$4,'none')",
        [driveId, userId, `tenants/${userId}/report`, sessionId],
      );
      await pool.query(
        "insert into artifacts(id,owner_user_id,session_id,ark_file_id,drive_file_id,name,mime_type,size_bytes,generated_at) values($1,$2,$3,'file',$4,'report.txt','text/plain',6,now())",
        [artifactId, userId, sessionId, driveId],
      );
      const repositories = createRepositories(drizzle(pool));
      const now = new Date();
      const observation = {
        boundaryEventId: "end",
        inputEventId: "input",
        outcome: "completed" as const,
        summary: "Completed",
        expectedNames: ["report.txt"],
        startedAt: now,
        endedAt: now,
        usageState: "pending" as const,
      };
      await repositories.sessionDelivery.recordObservations(
        userId,
        sessionId,
        [observation],
        { now, upstreamStatus: "idle", retryWindowMs: 300_000 },
      );
      const [job] = await repositories.jobs.claim({
        workerId: `worker-${sessionId}`,
        limit: 1,
        types: ["reconcile_session"],
      });
      return {
        repositories,
        userId,
        sessionId,
        artifactId,
        driveId,
        job: job!,
        now,
        observation,
      };
    }

    async function blocked(pid: number) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (
          (
            await pool.query(
              "select cardinality(pg_blocking_pids($1))>0 blocked",
              [pid],
            )
          ).rows[0]?.blocked
        )
          return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error("Expected PostgreSQL lock wait");
    }

    it("does not publish completion while a referenced artifact enters deletion", async () => {
      const f = await fixture();
      const deletion = await pool.connect(),
        finisher = await pool.connect();
      let finishing: Promise<unknown> | undefined;
      let release!: () => void;
      let ready!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const deleted = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const deleting = drizzle(deletion).transaction(async (transaction) => {
        await createRepositories(transaction).artifacts.requestDelete(
          f.artifactId,
          f.userId,
          f.now,
        );
        ready();
        await held;
      });
      try {
        await deleted;
        const pid = (await finisher.query("select pg_backend_pid() pid"))
          .rows[0]!.pid;
        finishing = createRepositories(
          drizzle(finisher),
        ).sessionDelivery.finishSync(
          f.userId,
          f.job.id,
          f.job.lockedBy!,
          f.job.leaseGeneration,
          {
            now: f.now,
            artifactState: "synced",
            artifactIds: [f.artifactId],
            errorCode: null,
          },
        );
        void finishing.catch(() => {});
        await blocked(pid);
        release();
        await deleting;
        expect(await finishing).toBe(false);
        expect(
          await f.repositories.sessionDelivery.listNotifications(f.userId, 20),
        ).toEqual([]);
      } finally {
        release();
        await deleting;
        await finishing?.catch(() => {});
        deletion.release();
        finisher.release();
      }
    });

    it("rolls back a cancelled observation write after the session lock becomes available", async () => {
      const f = await fixture();
      const locker = await pool.connect(),
        writer = await pool.connect();
      const controller = new AbortController();
      let writing: Promise<unknown> | undefined;
      try {
        await locker.query("begin");
        await locker.query("select id from sessions where id=$1 for update", [
          f.sessionId,
        ]);
        const pid = (await writer.query("select pg_backend_pid() pid")).rows[0]!
          .pid;
        writing = createRepositories(
          drizzle(writer),
        ).sessionDelivery.recordObservations(
          f.userId,
          f.sessionId,
          [{ ...f.observation, boundaryEventId: "cancelled" }],
          {
            now: f.now,
            upstreamStatus: "idle",
            retryWindowMs: 300_000,
            signal: controller.signal,
          },
        );
        void writing.catch(() => {});
        await blocked(pid);
        controller.abort();
        await locker.query("commit");
        await expect(writing).rejects.toThrow();
        expect(
          (
            await f.repositories.sessionDelivery.listTurns(
              f.userId,
              f.sessionId,
            )
          ).map((t) => t.boundaryEventId),
        ).toEqual(["end"]);
      } finally {
        await locker.query("rollback");
        await writing?.catch(() => {});
        locker.release();
        writer.release();
      }
    });
    it("serializes paused retry with observation upsert without a turn/job deadlock", async () => {
      const f = await fixture();
      const discoveryConnection = await pool.connect(),
        pauseConnection = await pool.connect();
      let pausing: Promise<unknown> | undefined;
      try {
        await drizzle(discoveryConnection).transaction(async (transaction) => {
          await transaction.execute(
            sql`select id from sessions where id=${f.sessionId} for update`,
          );
          await transaction.execute(
            sql`update session_turns set updated_at=now() where id=${f.job.id}`,
          );
          const pid = (
            await pauseConnection.query("select pg_backend_pid() pid")
          ).rows[0]!.pid;
          pausing = createRepositories(drizzle(pauseConnection)).jobs.retry(
            f.job.id,
            f.job.lockedBy!,
            "ARTIFACT_SYNC_PAUSED",
            false,
            f.job.leaseGeneration,
          );
          void pausing.catch(() => {});
          await blocked(pid);
          await createRepositories(
            transaction,
          ).sessionDelivery.recordObservations(
            f.userId,
            f.sessionId,
            [f.observation],
            { now: f.now, upstreamStatus: "idle", retryWindowMs: 300_000 },
          );
        });
        await expect(pausing).resolves.toBeUndefined();
        expect(
          (
            await pool.query(
              "select status,attempts from background_jobs where id=$1",
              [f.job.id],
            )
          ).rows[0],
        ).toMatchObject({ status: "pending", attempts: 0 });
      } finally {
        await pausing?.catch(() => {});
        discoveryConnection.release();
        pauseConnection.release();
      }
    });
  },
);

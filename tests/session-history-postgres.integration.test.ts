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
  "session history PostgreSQL contention",
  () => {
    const schema = `a2_history_${randomUUID().replaceAll("-", "")}`;
    let pool: Pool;
    let userId: string;
    let sessionId: string;
    const uncachedSessionId = randomUUID();
    const emptySessionId = randomUUID();

    beforeAll(async () => {
      pool = new Pool({
        connectionString: databaseUrl,
        max: 4,
        options: `-c search_path=${schema} -c statement_timeout=15000`,
      });
      await pool.query(`create schema "${schema}"`);
      const connection = await pool.connect();
      try {
        const directory = resolve(
          import.meta.dirname,
          "../packages/db/migrations",
        );
        for (const name of (await readdir(directory))
          .filter((name) => /^\d{4}_.*\.sql$/.test(name))
          .sort()) {
          if (name.startsWith("0028_")) {
            userId = randomUUID();
            sessionId = randomUUID();
            const agentId = randomUUID();
            await connection.query(
              "insert into users(id,auth_subject,email) values ($1,$2,$3)",
              [userId, userId, `${userId}@example.com`],
            );
            await connection.query(
              "insert into personal_agents(id,owner_user_id,ark_agent_id,name,model_id,system_prompt,ark_version,status) values ($1,$2,'agent','Agent','model','Prompt','1','active')",
              [agentId, userId],
            );
            for (const id of [sessionId, uncachedSessionId, emptySessionId])
              await connection.query(
                "insert into sessions(id,owner_user_id,personal_agent_id,ark_session_id,agent_kind,ark_agent_id,agent_name,agent_version,environment_id,title) values ($1,$2,$3,$4,'personal','agent','Agent','1','env','Task')",
                [id, userId, agentId, `ark-${id}`],
              );
            await connection.query(
              "insert into session_events(session_id,event_id,source_type,type,occurred_at,payload) values ($1,'legacy-one','agent.message','message',now(),'{}'),($1,'legacy-two','agent.message','message',now(),'{}'),($2,'uncached','agent.message','message',now(),'{}')",
              [sessionId, uncachedSessionId],
            );
            await connection.query(
              "insert into session_event_cursors(session_id,history_backfilled_at) values ($1,now()),($2,null)",
              [sessionId, emptySessionId],
            );
          }
          await connection.query("begin");
          const migration = (
            await readFile(resolve(directory, name), "utf8")
          ).replaceAll('"public".', `"${schema}".`);
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
    const event = (eventId: string) => ({
      eventId,
      sourceType: "agent.message",
      type: "message",
      occurredAt: new Date("2026-01-01"),
      payload: { content: eventId },
    });

    async function waitForBlocked(pid: number) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const result = await pool.query(
          "select cardinality(pg_blocking_pids($1)) > 0 as blocked",
          [pid],
        );
        if (result.rows[0]?.blocked) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Backend ${pid} did not reach the expected lock wait`);
    }

    it("backfills only persisted legacy event checkpoints without certifying old complete flags", async () => {
      const repository = createRepositories(drizzle(pool)).sessionLifecycle;
      for (const id of [sessionId, uncachedSessionId]) {
        const maximum = await pool.query(
          "select max(local_sequence)::text as sequence from session_events where session_id=$1",
          [id],
        );
        expect(await repository.historyState(userId, id)).toMatchObject({
          persistedSequence: maximum.rows[0]!.sequence,
          complete: false,
          repairRequired: true,
          scannedAt: null,
        });
      }
      expect(
        await repository.historyState(userId, emptySessionId),
      ).toMatchObject({
        persistedSequence: "0",
        complete: false,
      });
    });

    it("rolls back a timed out candidate reservation after a real cursor lock wait", async () => {
      const now = new Date("2030-01-01");
      await pool.query(
        "update session_event_cursors set history_next_attempt_at=$1,history_attempted_at=null",
        [new Date("2050-01-01")],
      );
      await pool.query(
        "update session_event_cursors set history_next_attempt_at=null where session_id=$1",
        [sessionId],
      );
      const controller = new AbortController();
      const connection = await pool.connect();
      let selection: Promise<unknown> | undefined;
      let pid: number | undefined;
      try {
        await drizzle(pool).transaction(async (transaction) => {
          await transaction.execute(
            sql`select session_id from session_event_cursors where session_id=${sessionId} for update`,
          );
          selection = drizzle(connection).transaction(async (transaction) => {
            pid = (
              await transaction.execute<{ pid: number }>(
                sql`select pg_backend_pid() as pid`,
              )
            ).rows[0]!.pid;
            return createRepositories(
              transaction,
            ).sessionLifecycle.listHistoryReconcilable({
              now,
              limit: 1,
              cooldownMs: 1000,
              signal: controller.signal,
            });
          });
          void selection.catch(() => {});
          while (pid === undefined)
            await new Promise((resolve) => setTimeout(resolve, 1));
          await waitForBlocked(pid);
          controller.abort();
        });
        await expect(selection).rejects.toThrow();
        expect(
          (
            await pool.query(
              "select history_attempted_at as attempted,history_next_attempt_at as next from session_event_cursors where session_id=$1",
              [sessionId],
            )
          ).rows,
        ).toEqual([{ attempted: null, next: null }]);
      } finally {
        await selection?.catch(() => {});
        connection.release();
      }
    });

    it.each(["append", "begin", "invalidate", "complete", "finish", "reserve"])(
      "does not deadlock projection against the %s cursor writer",
      async (writer) => {
        const repository = createRepositories(drizzle(pool)).sessionLifecycle;
        const generation = await repository.beginHistoryScan(userId, sessionId);
        await pool.query(
          "update session_event_cursors set history_next_attempt_at=null where session_id=$1",
          [sessionId],
        );
        const projectionConnection = await pool.connect();
        let projection: Promise<unknown> | undefined;
        let pid!: number;
        try {
          await drizzle(pool).transaction(async (transaction) => {
            await transaction.execute(
              sql`select id from sessions where id=${sessionId} for update`,
            );
            projection = drizzle(projectionConnection).transaction(
              async (transaction) => {
                const result = await transaction.execute<{ pid: number }>(
                  sql`select pg_backend_pid() as pid`,
                );
                pid = result.rows[0]!.pid;
                return createRepositories(
                  transaction,
                ).sessionLifecycle.projectEvent(userId, sessionId, {
                  eventId: `contention-${writer}`,
                  observedAt: new Date("2026-01-01"),
                  status: "idle",
                });
              },
            );
            // Attach a rejection handler before PostgreSQL's deadlock detector runs.
            void projection.catch(() => {});
            while (pid === undefined)
              await new Promise((resolve) => setTimeout(resolve, 1));
            await waitForBlocked(pid);
            const owned = createRepositories(transaction).sessionLifecycle;
            if (writer === "append")
              await owned.appendEvents(userId, sessionId, [
                event("contention"),
              ]);
            else if (writer === "begin")
              await owned.beginHistoryScan(userId, sessionId);
            else if (writer === "invalidate")
              await owned.invalidateHistory(userId, sessionId, generation);
            else if (writer === "complete")
              await owned.markHistoryBackfilled(userId, sessionId, generation);
            else if (writer === "finish")
              await owned.finishHistoryAttempt(userId, sessionId, {
                now: new Date("2030-01-01"),
                succeeded: false,
                cooldownMs: 1000,
                maxBackoffMs: 8000,
              });
            else
              await owned.listHistoryReconcilable({
                now: new Date("2030-01-01"),
                limit: 1,
                cooldownMs: 1000,
              });
          });
          await expect(projection).resolves.toBe(false);
        } finally {
          await projection?.catch(() => {});
          projectionConnection.release();
        }
      },
    );

    it("does not let an incremental reader skip an earlier uncommitted batch", async () => {
      const repository = createRepositories(drizzle(pool)).sessionLifecycle;
      await repository.appendEvents(userId, sessionId, [event("baseline")]);
      const baseline = await repository.historyState(userId, sessionId);
      let release!: () => void;
      let ready!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const written = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const transaction = drizzle(pool).transaction(async (transaction) => {
        await createRepositories(transaction).sessionLifecycle.appendEvents(
          userId,
          sessionId,
          [event("held")],
        );
        ready();
        await held;
      });
      let append: Promise<void> | undefined;
      try {
        await written;
        let settled = false;
        append = repository
          .appendEvents(userId, sessionId, [event("later")])
          .then(() => {
            settled = true;
          });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(settled).toBe(false);
        expect(
          await repository.listEventsAfter(
            userId,
            sessionId,
            baseline.persistedSequence,
            10,
          ),
        ).toEqual([]);
        expect(
          (await repository.historyState(userId, sessionId)).persistedSequence,
        ).toBe(baseline.persistedSequence);
        release();
        await transaction;
        await append;
        expect(
          (
            await repository.listEventsAfter(
              userId,
              sessionId,
              baseline.persistedSequence,
              10,
            )
          ).map((event) => event.eventId),
        ).toEqual(["held", "later"]);
      } finally {
        release();
        await transaction;
        await append;
      }
    });

    it("rejects stale completion after another backend invalidates or starts a newer scan", async () => {
      const first = createRepositories(drizzle(pool)).sessionLifecycle;
      const second = createRepositories(drizzle(pool)).sessionLifecycle;
      const generation = await first.beginHistoryScan(userId, sessionId);
      await second.invalidateHistory(userId, sessionId);
      expect(
        await first.markHistoryBackfilled(userId, sessionId, generation),
      ).toBe(false);
      const newer = await second.beginHistoryScan(userId, sessionId);
      await expect(
        first.appendEvents(userId, sessionId, [event("stale")], generation),
      ).rejects.toMatchObject({ code: "EVENT_HISTORY_SCAN_STALE" });
      expect(await second.markHistoryBackfilled(userId, sessionId, newer)).toBe(
        true,
      );
    });

    it("fences stale history projections before they can overwrite a newer scan", async () => {
      const repository = createRepositories(drizzle(pool)).sessionLifecycle;
      const older = await repository.beginHistoryScan(userId, sessionId);
      const newer = await repository.beginHistoryScan(userId, sessionId);
      await repository.projectEvent(userId, sessionId, {
        eventId: "new-status",
        observedAt: new Date("2030-01-01"),
        status: "idle",
      });
      await repository.markHistoryBackfilled(userId, sessionId, newer);
      await expect(
        repository.projectEvent(
          userId,
          sessionId,
          {
            eventId: "stale-status",
            observedAt: new Date("2030-01-02"),
            status: "terminated",
          },
          { scanGeneration: older },
        ),
      ).rejects.toMatchObject({ code: "EVENT_HISTORY_SCAN_STALE" });
      expect(
        (
          await pool.query("select status from sessions where id=$1", [
            sessionId,
          ])
        ).rows,
      ).toEqual([{ status: "idle" }]);
      expect(await repository.historyState(userId, sessionId)).toMatchObject({
        complete: true,
        scanGeneration: newer,
      });
    });

    it.each(["begin", "append", "complete", "project", "finish"])(
      "rolls back a cancelled %s write after a real database lock wait",
      async (writer) => {
        const repository = createRepositories(drizzle(pool)).sessionLifecycle;
        const generation = await repository.beginHistoryScan(userId, sessionId);
        const controller = new AbortController();
        const connection = await pool.connect();
        let write: Promise<unknown> | undefined;
        let pid: number | undefined;
        try {
          await drizzle(pool).transaction(async (transaction) => {
            await transaction.execute(
              sql`select id from sessions where id=${sessionId} for update`,
            );
            write = drizzle(connection).transaction(async (transaction) => {
              pid = (
                await transaction.execute<{ pid: number }>(
                  sql`select pg_backend_pid() as pid`,
                )
              ).rows[0]!.pid;
              const owned = createRepositories(transaction).sessionLifecycle;
              if (writer === "begin")
                return owned.beginHistoryScan(
                  userId,
                  sessionId,
                  controller.signal,
                );
              if (writer === "append")
                return owned.appendEvents(
                  userId,
                  sessionId,
                  [event("cancelled-append")],
                  generation,
                  controller.signal,
                );
              if (writer === "complete")
                return owned.markHistoryBackfilled(
                  userId,
                  sessionId,
                  generation,
                  controller.signal,
                );
              if (writer === "finish")
                return owned.finishHistoryAttempt(userId, sessionId, {
                  now: new Date("2040-01-01"),
                  succeeded: true,
                  cooldownMs: 1000,
                  maxBackoffMs: 8000,
                  signal: controller.signal,
                });
              return owned.projectEvent(
                userId,
                sessionId,
                {
                  eventId: "cancelled-projection",
                  observedAt: new Date("2040-01-01"),
                  status: "terminated",
                },
                { scanGeneration: generation, signal: controller.signal },
              );
            });
            void write.catch(() => {});
            while (pid === undefined)
              await new Promise((resolve) => setTimeout(resolve, 1));
            await waitForBlocked(pid);
            controller.abort();
          });
          await expect(write).rejects.toThrow();
          expect(
            await repository.historyState(userId, sessionId),
          ).toMatchObject({
            complete: false,
            scanGeneration: generation,
          });
          expect(
            await pool
              .query(
                "select event_id from session_events where session_id=$1 and event_id='cancelled-append'",
                [sessionId],
              )
              .then((result) => result.rows),
          ).toEqual([]);
          expect(
            (
              await pool.query("select status from sessions where id=$1", [
                sessionId,
              ])
            ).rows,
          ).toEqual([{ status: "idle" }]);
        } finally {
          await write?.catch(() => {});
          connection.release();
        }
      },
    );
  },
);

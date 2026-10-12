import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createMemoryRepository,
  createRepositories,
  type MemoryState,
} from "../packages/db/src/index.js";
import type { SessionRecord } from "../packages/domain/src/sessions.js";

const databaseUrl = process.env.TEST_POSTGRES_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("personal memory contention in real PostgreSQL", () => {
  const schemaName = `memory_contention_${randomUUID().replaceAll("-", "")}`;
  let administrationPool: Pool;
  let workerPool: Pool;

  beforeAll(async () => {
    administrationPool = new Pool({ connectionString: databaseUrl, max: 1 });
    await administrationPool.query(`create schema "${schemaName}"`);
    workerPool = new Pool({
      connectionString: databaseUrl,
      max: 3,
      options: `-c search_path=${schemaName} -c statement_timeout=15000`,
    });
    // Only the columns read/written by memory and create/message admission.
    // Text states deliberately avoid migrations and global enum dependencies.
    await workerPool.query(`
      create table users (
        id uuid primary key,
        role text not null default 'user',
        status text not null default 'active'
      );
      create table user_memory_stores (
        user_id uuid primary key references users(id),
        fixed_store_id text unique,
        state jsonb not null,
        revision integer not null default 0,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create table sessions (
        id uuid primary key,
        owner_user_id uuid not null references users(id),
        ark_session_id text not null,
        memory_store_id text,
        agent_kind text not null default 'personal',
        platform_agent_id uuid,
        personal_agent_id uuid,
        ark_agent_id text not null default 'ark-agent',
        agent_name text not null default 'Agent',
        agent_version text not null default '1',
        environment_id text not null default 'environment',
        title text not null default '',
        status text not null default 'idle',
        last_error_code text,
        error_recoverable boolean,
        archived_at timestamptz,
        pinned_at timestamptz,
        deletion_state text not null default 'none',
        last_event_at timestamptz,
        message_in_flight_count integer not null default 0,
        message_start_pending boolean not null default false,
        message_unknown_outcome boolean not null default false,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create table quota_policies (
        key text primary key,
        personal_agent_limit integer not null,
        concurrent_session_limit integer not null,
        daily_session_limit integer not null,
        monthly_token_limit bigint not null
      );
      create table user_quota_overrides (
        user_id uuid primary key,
        personal_agent_limit integer,
        concurrent_session_limit integer,
        daily_session_limit integer,
        monthly_token_limit bigint
      );
      create table quota_reservations (
        id uuid primary key,
        user_id uuid not null,
        status text not null default 'active',
        expires_at timestamptz not null,
        created_at timestamptz not null
      );
      create table usage_ledger (
        user_id uuid not null,
        metric_type text not null,
        quantity bigint not null,
        recorded_at timestamptz not null
      );
      create table background_jobs (
        id uuid primary key,
        owner_user_id uuid,
        type text not null,
        status text not null,
        priority integer not null,
        payload jsonb not null,
        attempts integer not null,
        run_after timestamptz not null
      );
      insert into quota_policies values ('default', 10, 10, 100, 100000);
    `);
  });

  afterAll(async () => {
    await workerPool?.end();
    if (administrationPool) {
      try {
        await administrationPool.query(
          `drop schema if exists "${schemaName}" cascade`,
        );
      } finally {
        await administrationPool.end();
      }
    }
  });

  async function addUser() {
    const userId = randomUUID();
    await workerPool.query("insert into users (id) values ($1)", [userId]);
    return userId;
  }

  async function activate(userId: string): Promise<MemoryState> {
    const repository = createMemoryRepository(drizzle(workerPool));
    const { state } = await repository.reserve(userId);
    await repository.save(userId, 0, {
      ...state,
      status: "active",
      storeId: `store:${userId}`,
    });
    return (await repository.get(userId))!;
  }

  async function backendId(client: PoolClient): Promise<number> {
    const result = await client.query<{ pid: number }>(
      "select pg_backend_pid() as pid",
    );
    return result.rows[0].pid;
  }

  async function expectBlocked(waiter: number, blocker: number | number[]) {
    // Observe an actual PostgreSQL lock wait, not a scheduling-dependent sleep.
    await expect
      .poll(
        async () => {
          const result = await administrationPool.query<{ blocked: boolean }>(
            "select $2::integer[] && pg_blocking_pids($1::integer) as blocked",
            [waiter, Array.isArray(blocker) ? blocker : [blocker]],
          );
          return result.rows[0].blocked;
        },
        { timeout: 10_000, interval: 20 },
      )
      .toBe(true);
  }

  function session(userId: string, storeId: string | null): SessionRecord {
    const id = randomUUID();
    const now = new Date();
    return {
      id,
      ownerUserId: userId,
      arkSessionId: `pending:${id}`,
      memoryStoreId: storeId,
      agentKind: "personal",
      platformAgentId: null,
      personalAgentId: randomUUID(),
      arkAgentId: "ark-agent",
      agentName: "Agent",
      agentVersion: "1",
      environmentId: "environment",
      createAttemptedAt: null,
      modelId: null,
      configSnapshot: null,
      configSnapshotState: "unverified",
      configSnapshotErrorCode: null,
      title: "",
      status: "idle",
      lastErrorCode: null,
      errorRecoverable: null,
      archivedAt: null,
      pinnedAt: null,
      deletionState: "none",
      lastEventAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  it("reserves exactly one durable intent across distinct connections", async () => {
    const userId = await addUser();
    const first = await workerPool.connect();
    const second = await workerPool.connect();
    let competing: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      const firstPid = await backendId(first);
      const secondPid = await backendId(second);
      expect(firstPid).not.toBe(secondPid);
      await first.query("begin");
      const winner = await createMemoryRepository(drizzle(first)).reserve(
        userId,
      );
      competing = Promise.allSettled([
        createMemoryRepository(drizzle(second)).reserve(userId),
      ]);
      await expectBlocked(secondPid, firstPid);
      await first.query("commit");
      const [loser] = await competing;
      expect(winner.created).toBe(true);
      expect(loser).toEqual({
        status: "fulfilled",
        value: { created: false, state: winner.state },
      });
      const stored = await second.query(
        "select revision, fixed_store_id, state from user_memory_stores where user_id = $1",
        [userId],
      );
      expect(stored.rows).toEqual([
        { revision: 0, fixed_store_id: null, state: winner.state },
      ]);
    } finally {
      await first.query("rollback");
      await competing;
      first.release();
      second.release();
    }
  });

  it("allows exactly one CAS winner across distinct connections", async () => {
    const userId = await addUser();
    const active = await activate(userId);
    const locker = await workerPool.connect();
    const first = await workerPool.connect();
    const second = await workerPool.connect();
    let competing: Promise<PromiseSettledResult<void>[]> | undefined;
    try {
      const lockerPid = await backendId(locker);
      const firstPid = await backendId(first);
      const secondPid = await backendId(second);
      expect(new Set([lockerPid, firstPid, secondPid]).size).toBe(3);
      await locker.query("begin");
      await locker.query(
        "select user_id from user_memory_stores where user_id = $1 for update",
        [userId],
      );
      const candidates = [1, 2].map((policyEpoch) => ({
        ...active,
        policyEpoch,
        storeId: `winner:${userId}:${policyEpoch}`,
      }));
      competing = Promise.allSettled(
        [first, second].map((client, index) =>
          createMemoryRepository(drizzle(client)).save(
            userId,
            active.revision,
            candidates[index],
          ),
        ),
      );
      await expectBlocked(firstPid, [lockerPid, secondPid]);
      await expectBlocked(secondPid, [lockerPid, firstPid]);
      await locker.query("commit");
      const results = await competing;
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        results.find((result) => result.status === "rejected"),
      ).toMatchObject({
        reason: { code: "MEMORY_CONFLICT" },
      });
      const winner =
        candidates[
          results.findIndex((result) => result.status === "fulfilled")
        ];
      const stored = await locker.query(
        "select revision, fixed_store_id, state from user_memory_stores where user_id = $1",
        [userId],
      );
      expect(stored.rows).toEqual([
        {
          revision: 2,
          fixed_store_id: winner.storeId,
          state: { ...winner, revision: 2 },
        },
      ]);
    } finally {
      await locker.query("rollback");
      await competing;
      locker.release();
      first.release();
      second.release();
    }
  });

  it.each(["create", "message"] as const)(
    "serializes draining with real %s admission in both user-lock orders",
    async (operation) => {
      for (const drainFirst of [false, true]) {
        const userId = await addUser();
        const active = await activate(userId);
        const record = session(userId, active.storeId);
        if (operation === "message") {
          await workerPool.query(
            `insert into sessions (id, owner_user_id, ark_session_id, memory_store_id)
             values ($1, $2, $3, $4)`,
            [record.id, userId, `ark:${record.id}`, active.storeId],
          );
        }
        const holder = await workerPool.connect();
        const waiter = await workerPool.connect();
        const observer = createMemoryRepository(drizzle(workerPool));
        const heldDb = drizzle(holder);
        const waitingDb = drizzle(waiter);
        const release = Promise.withResolvers<void>();
        const ready = Promise.withResolvers<void>();
        let holding: Promise<PromiseSettledResult<unknown>[]> | undefined;
        let waiting: Promise<PromiseSettledResult<unknown>[]> | undefined;
        const admit = (db: unknown) => {
          const lifecycle = createRepositories(db).sessionLifecycle;
          return operation === "create"
            ? lifecycle.prepareCreate(record)
            : lifecycle.beginMessage(userId, record.id);
        };
        const drain = (db: unknown) =>
          createMemoryRepository(db).save(userId, active.revision, {
            ...active,
            status: "draining",
          });
        try {
          const holderPid = await backendId(holder);
          const waiterPid = await backendId(waiter);
          expect(holderPid).not.toBe(waiterPid);
          holding = Promise.allSettled([
            heldDb
              .transaction(async (transaction) => {
                await transaction.execute(
                  sql`select id from users where id = ${userId} for update`,
                );
                if (drainFirst) await drain(transaction);
                else await admit(transaction);
                ready.resolve();
                await release.promise;
              })
              .catch((error: unknown) => {
                ready.reject(error);
                throw error;
              }),
          ]);
          await ready.promise;
          waiting = Promise.allSettled([
            drainFirst ? admit(waitingDb) : drain(waitingDb),
          ]);
          await expectBlocked(waiterPid, holderPid);
          // Neither the uncommitted drain nor admission is visible yet.
          expect(await observer.get(userId)).toEqual(active);
          expect(await observer.sessions(userId)).toEqual(
            operation === "create"
              ? []
              : [
                  {
                    id: record.id,
                    arkSessionId: `ark:${record.id}`,
                    memoryStoreId: active.storeId,
                    pending: false,
                  },
                ],
          );
          release.resolve();
          expect(await holding).toEqual([
            { status: "fulfilled", value: undefined },
          ]);
          const [result] = await waiting;
          if (drainFirst) {
            expect(result).toMatchObject({
              status: "rejected",
              reason: { code: "MEMORY_BUSY" },
            });
          } else {
            expect(result).toEqual({ status: "fulfilled", value: undefined });
          }
          expect(await observer.get(userId)).toEqual({
            ...active,
            status: "draining",
            revision: 2,
          });
          const found = await observer.sessions(userId);
          if (operation === "create" && drainFirst) expect(found).toEqual([]);
          else
            expect(found).toMatchObject([
              { id: record.id, pending: !drainFirst },
            ]);
          await expect(admit(waitingDb)).rejects.toMatchObject({
            code: "MEMORY_BUSY",
          });
        } finally {
          release.resolve();
          await holding;
          await waiting;
          holder.release();
          waiter.release();
        }
      }
    },
  );

  it("queries every pending marker including an unknown outcome on an idle session", async () => {
    const userId = await addUser();
    const otherUserId = await addUser();
    const fixtures = [
      {
        inFlight: 0,
        start: false,
        unknown: false,
        ark: "ark:idle",
        deletion: "none",
        pending: false,
      },
      {
        inFlight: 1,
        start: false,
        unknown: false,
        ark: "ark:flight",
        deletion: "none",
        pending: true,
      },
      {
        inFlight: 0,
        start: true,
        unknown: false,
        ark: "ark:start",
        deletion: "none",
        pending: true,
      },
      {
        inFlight: 0,
        start: false,
        unknown: true,
        ark: "ark:unknown",
        deletion: "none",
        pending: true,
      },
      {
        inFlight: 0,
        start: false,
        unknown: false,
        ark: "pending:create",
        deletion: "none",
        pending: true,
      },
      {
        inFlight: 0,
        start: false,
        unknown: false,
        ark: "ark:deleting",
        deletion: "pending",
        pending: true,
      },
      {
        inFlight: 0,
        start: false,
        unknown: false,
        ark: "ark:failed",
        deletion: "deletion_failed",
        pending: true,
      },
      {
        inFlight: 0,
        start: false,
        unknown: false,
        ark: "ark:deleted",
        deletion: "deleted",
        pending: true,
      },
    ];
    const expected = [];
    for (const [index, fixture] of fixtures.entries()) {
      const id = randomUUID();
      const memoryStoreId = index === 0 ? null : `store:${userId}`;
      await workerPool.query(
        `insert into sessions
         (id, owner_user_id, ark_session_id, memory_store_id, status,
          message_in_flight_count, message_start_pending, message_unknown_outcome,
          deletion_state, archived_at, created_at)
         values ($1, $2, $3, $4, 'idle', $5, $6, $7, $8, now(),
                 '2026-01-01'::timestamptz + $9 * interval '1 second')`,
        [
          id,
          userId,
          fixture.ark,
          memoryStoreId,
          fixture.inFlight,
          fixture.start,
          fixture.unknown,
          fixture.deletion,
          index,
        ],
      );
      expected.push({
        id,
        arkSessionId: fixture.ark,
        memoryStoreId,
        pending: fixture.pending,
      });
    }
    await workerPool.query(
      `insert into sessions (id, owner_user_id, ark_session_id, message_unknown_outcome)
       values ($1, $2, 'ark:other', true)`,
      [randomUUID(), otherUserId],
    );
    const repository = createMemoryRepository(drizzle(workerPool));
    expect(await repository.sessions(userId)).toEqual(expected);
    expect(await repository.sessions(await addUser())).toEqual([]);
  });
});

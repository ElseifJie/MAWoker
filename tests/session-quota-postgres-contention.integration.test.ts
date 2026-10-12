import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  QuotaExceededError,
  createRepositories,
} from "../packages/db/src/index.js";

const databaseUrl = process.env.TEST_POSTGRES_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("Session quota ledger in real PostgreSQL", () => {
  const schemaName = `task09_quota_${randomUUID().replaceAll("-", "")}`;
  const ownerId = randomUUID();
  const realSessionId = randomUUID();
  const pendingSessionId = randomUUID();
  const releasedReservationId = randomUUID();
  let administrationPool: Pool;
  let workerPool: Pool;

  beforeAll(async () => {
    administrationPool = new Pool({ connectionString: databaseUrl, max: 1 });
    await administrationPool.query(`create schema "${schemaName}"`);
    workerPool = new Pool({
      connectionString: databaseUrl,
      max: 4,
      options: `-c search_path=${schemaName} -c statement_timeout=15000`,
    });
    await workerPool.query(`
      create type quota_reservation_status as enum
        ('active', 'consumed', 'released');
      create type usage_metric_type as enum
        ('input_tokens', 'output_tokens', 'runtime_ms', 'tool_calls');
      create table users (
        id uuid primary key,
        role text not null default 'user',
        status text not null default 'active'
      );
      create table sessions (
        id uuid primary key,
        owner_user_id uuid not null references users(id),
        ark_session_id text not null,
        status text not null default 'idle',
        deletion_state text not null default 'none',
        created_at timestamptz not null default now(),
        unique (owner_user_id, ark_session_id)
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
        user_id uuid not null references users(id),
        status quota_reservation_status not null default 'active',
        expires_at timestamptz not null,
        created_at timestamptz not null default now(),
        resolved_at timestamptz
      );
      create table usage_ledger (
        id uuid primary key,
        user_id uuid not null references users(id),
        ark_session_id text not null,
        ark_event_id text not null,
        metric_type usage_metric_type not null,
        quantity bigint not null,
        recorded_at timestamptz not null default now(),
        constraint usage_ledger_session_owner_fk
          foreign key (user_id, ark_session_id)
          references sessions(owner_user_id, ark_session_id)
          on delete cascade,
        unique (user_id, ark_session_id, ark_event_id, metric_type)
      );
    `);
    await workerPool.query(`insert into users (id) values ($1)`, [ownerId]);
    await workerPool.query(
      `insert into quota_policies
         (key, personal_agent_limit, concurrent_session_limit,
          daily_session_limit, monthly_token_limit)
       values ('default', 10, 2, 1, 1000)`,
    );
    await workerPool.query(
      `insert into sessions
         (id, owner_user_id, ark_session_id, created_at)
       values ($2, $1, 'ark-session-real', '2026-10-12T00:00:00Z'),
              ($3, $1, $4, '2026-10-12T00:00:01Z')`,
      [ownerId, realSessionId, pendingSessionId, `pending:${pendingSessionId}`],
    );
    await workerPool.query(
      `insert into quota_reservations
         (id, user_id, status, expires_at, created_at, resolved_at)
       values ($2, $1, 'active', '2026-10-12T00:00:02Z',
               '2026-10-12T00:00:01Z', null),
              ($3, $1, 'released', '2026-10-11T00:00:00Z',
               '2026-10-11T00:00:00Z', '2026-10-11T00:00:01Z')`,
      [ownerId, pendingSessionId, releasedReservationId],
    );
    await workerPool.query(
      `insert into usage_ledger
         (id, user_id, ark_session_id, ark_event_id, metric_type, quantity)
       values ($2, $1, 'ark-session-real', 'event-before-migration',
               'input_tokens', 17)`,
      [ownerId, randomUUID()],
    );

    const migration = await readFile(
      resolve(
        import.meta.dirname,
        "../packages/db/migrations/0022_sparkling_preak.sql",
      ),
      "utf8",
    );
    expect(migration).not.toMatch(/alter\s+type[\s\S]*add\s+value/i);
    const scopedMigration = migration.replaceAll(
      '"public".',
      `"${schemaName}".`,
    );
    const connection = await workerPool.connect();
    try {
      await connection.query("begin");
      for (const statement of scopedMigration.split(
        "--> statement-breakpoint",
      )) {
        if (statement.trim()) await connection.query(statement);
      }
      await connection.query("commit");
    } catch (error) {
      await connection.query("rollback");
      throw error;
    } finally {
      connection.release();
    }
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

  it("migrates owner anchors without changing historical ledger usage", async () => {
    const reservations = await workerPool.query<{
      id: string;
      ark_session_id: string;
      status: string;
    }>(
      `select id, ark_session_id, status::text
         from quota_reservations
        order by created_at`,
    );
    expect(reservations.rows).toEqual([
      {
        id: releasedReservationId,
        ark_session_id: `pending:${releasedReservationId}`,
        status: "released",
      },
      {
        id: realSessionId,
        ark_session_id: "ark-session-real",
        status: "consumed",
      },
      {
        id: pendingSessionId,
        ark_session_id: `pending:${pendingSessionId}`,
        status: "unknown_outcome",
      },
    ]);
    const ledger = await workerPool.query<{
      rows: number;
      input_tokens: string;
    }>(
      `select count(*)::integer as rows,
              coalesce(sum(quantity) filter (
                where metric_type = 'input_tokens'
              ), 0)::bigint as input_tokens
         from usage_ledger`,
    );
    expect(ledger.rows).toEqual([{ rows: 1, input_tokens: "17" }]);
  });

  it("allows exactly one contender to claim the last UTC daily slot", async () => {
    const contenderId = randomUUID();
    await workerPool.query(`insert into users (id) values ($1)`, [contenderId]);
    const repositories = createRepositories(drizzle(workerPool));
    const now = new Date("2026-10-12T12:00:00.000Z");
    const attempts = await Promise.allSettled(
      [randomUUID(), randomUUID()].map((reservationId) =>
        repositories.quotas.reserveSession({
          userId: contenderId,
          reservationId,
          expiresAt: new Date(now.getTime() + 60_000),
          now,
        }),
      ),
    );

    expect(
      attempts.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = attempts.find(({ status }) => status === "rejected");
    expect(rejected).toMatchObject({
      reason: expect.any(QuotaExceededError),
    });
  });
});

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
    await workerPool.query(
      `create type agent_status as enum
        ('provisioning', 'active', 'disabled', 'failed', 'deleting')`,
    );
    await workerPool.query(
      `create table users (
        id uuid primary key,
        role text not null,
        status text not null default 'active'
      )`,
    );
    await workerPool.query(
      `create table platform_agents (
        id uuid primary key,
        ark_agent_id text not null unique,
        name text not null,
        description text not null default '',
        model_id text not null,
        system_prompt text not null,
        ark_version text not null,
        status agent_status not null default 'active',
        created_by uuid not null references users(id),
        updated_by uuid not null references users(id),
        last_error_code text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )`,
    );
    await workerPool.query(
      `create table user_default_agents (
        user_id uuid primary key references users(id),
        platform_agent_id uuid not null references platform_agents(id),
        assigned_by uuid not null references users(id),
        assigned_at timestamptz not null default now()
      )`,
    );
    await workerPool.query(
      `create table sessions (
        id uuid primary key,
        owner_user_id uuid not null references users(id),
        platform_agent_id uuid not null references platform_agents(id)
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
    const staleLock = new Date(now.getTime() - 10 * 60 * 1_000);
    await workerPool.query(
      `insert into background_jobs
        (id, type, status, priority, attempts, run_after, locked_at, locked_by,
         created_at)
       values ($1, 'delete_session', 'running', 10, 1, $3, $4,
               'crashed-worker', $3),
              ($2, 'cleanup_upload', 'pending', 20, 0, $3, null, null, $3)`,
      [highPriorityId, nextPriorityId, now, staleLock],
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
    expect(claimedAfterRelease).toMatchObject([
      {
        id: highPriorityId,
        attempts: 2,
        lockedBy: "worker-2",
      },
    ]);
  });

  it.each([
    {
      reference: "assignment",
      lock: "for update",
      insert: `insert into user_default_agents
        (user_id, platform_agent_id, assigned_by) values ($1, $2, $3)`,
    },
    {
      reference: "session",
      lock: "for key share",
      insert: `insert into sessions
        (id, owner_user_id, platform_agent_id) values ($1, $3, $2)`,
    },
  ])(
    "waits for a concurrent $reference writer and observes its reference",
    async ({ reference, lock, insert }) => {
      const adminId = randomUUID();
      const userId = randomUUID();
      const agentId = randomUUID();
      await workerPool.query(
        `insert into users (id, role) values ($1, 'admin'), ($2, 'user')`,
        [adminId, userId],
      );
      await workerPool.query(
        `insert into platform_agents
          (id, ark_agent_id, name, model_id, system_prompt, ark_version,
           created_by, updated_by)
         values ($1, $2, 'Agent', 'model-a', 'Prompt', '1', $3, $3)`,
        [agentId, `ark-${agentId}`, adminId],
      );

      const writer = await workerPool.connect();
      try {
        await writer.query("begin");
        await writer.query(
          `select id from platform_agents
            where id = $1 and status = 'active' ${lock}`,
          [agentId],
        );
        await writer.query(
          insert,
          reference === "assignment"
            ? [userId, agentId, adminId]
            : [randomUUID(), agentId, userId],
        );

        const repositories = createRepositories(drizzle(workerPool));
        let settled = false;
        const deletion = repositories.platformAgents
          .beginDelete(agentId, adminId)
          .then((result) => {
            settled = true;
            return result;
          });

        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(settled).toBe(false);
        await writer.query("commit");

        await expect(deletion).resolves.toMatchObject({
          agent: { id: agentId, status: "active" },
          references: {
            assignments: reference === "assignment" ? 1 : 0,
            sessions: reference === "session" ? 1 : 0,
          },
        });
      } finally {
        await writer.query("rollback");
        writer.release();
      }
    },
  );
});

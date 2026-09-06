import { describe, expect, it } from "vitest";
import { InMemoryArkGateway } from "../packages/ark-client/src/index.js";
import { createRepositories } from "../packages/db/src/index.js";
import {
  PersonalAgentQuotaExceededError,
  UserAgentService,
  type UserAgentRepository,
} from "../packages/domain/src/index.js";
import { createTestDatabase, id } from "./support/test-database.js";

async function seedUsers(
  client: Awaited<ReturnType<typeof createTestDatabase>>["client"],
) {
  const adminId = id();
  const userId = id();
  const otherUserId = id();
  await client.query(
    `insert into users (id, auth_subject, email, role)
     values ($1, $2, 'admin@example.com', 'admin'),
            ($3, $4, 'user@example.com', 'user'),
            ($5, $6, 'other@example.com', 'user')`,
    [
      adminId,
      `admin-${adminId}`,
      userId,
      `user-${userId}`,
      otherUserId,
      `other-${otherUserId}`,
    ],
  );
  await client.query(
    `insert into quota_policies
      (key, personal_agent_limit, concurrent_session_limit,
       daily_session_limit, monthly_token_limit)
     values ('default', 2, 2, 20, 1000)`,
  );
  return { adminId, userId, otherUserId };
}

describe("user Agent database integration", () => {
  it("lists only assigned active platform and owned personal Agents", async () => {
    const database = await createTestDatabase();
    const { adminId, userId, otherUserId } = await seedUsers(database.client);
    const assignedId = id();
    const unassignedId = id();
    const personalId = id();
    const otherPersonalId = id();
    await database.client.query(
      `insert into platform_agents
        (id, ark_agent_id, name, model_id, system_prompt, ark_version, status,
         created_by, updated_by)
       values
        ($1, 'ark-assigned', 'Assigned', 'model-a', 'Prompt', '2', 'active', $3, $3),
        ($2, 'ark-unassigned', 'Unassigned', 'model-a', 'Prompt', '4', 'active', $3, $3)`,
      [assignedId, unassignedId, adminId],
    );
    await database.client.query(
      `insert into user_default_agents (user_id, platform_agent_id, assigned_by)
       values ($1, $2, $3)`,
      [userId, assignedId, adminId],
    );
    await database.client.query(
      `insert into personal_agents
        (id, owner_user_id, ark_agent_id, name, model_id, system_prompt,
         ark_version, status)
       values
        ($1, $2, 'ark-mine', 'Mine', 'model-a', 'Prompt', '3', 'failed'),
        ($3, $4, 'ark-other', 'Other', 'model-a', 'Prompt', '1', 'active')`,
      [personalId, userId, otherPersonalId, otherUserId],
    );

    const repositories = createRepositories(database.db);
    await expect(
      repositories.userAgents.listAvailable(userId),
    ).resolves.toEqual([
      expect.objectContaining({
        id: assignedId,
        kind: "platform",
        editable: false,
        arkVersion: "2",
      }),
      expect.objectContaining({
        id: personalId,
        kind: "personal",
        editable: true,
        status: "failed",
        arkVersion: "3",
      }),
    ]);
    await database.close();
  });

  it("resolves the latest available Session deterministically then the default", async () => {
    const database = await createTestDatabase();
    const { adminId, userId } = await seedUsers(database.client);
    const platformId = id();
    const personalId = id();
    await database.client.query(
      `insert into platform_agents
        (id, ark_agent_id, name, model_id, system_prompt, ark_version, status,
         created_by, updated_by)
       values ($1, 'ark-platform', 'Platform', 'model-a', 'Prompt', '1',
               'active', $2, $2)`,
      [platformId, adminId],
    );
    await database.client.query(
      `insert into user_default_agents (user_id, platform_agent_id, assigned_by)
       values ($1, $2, $3)`,
      [userId, platformId, adminId],
    );
    await database.client.query(
      `insert into personal_agents
        (id, owner_user_id, ark_agent_id, name, model_id, system_prompt,
         ark_version, status)
       values ($1, $2, 'ark-personal', 'Personal', 'model-a', 'Prompt', '1',
               'active')`,
      [personalId, userId],
    );
    const repositories = createRepositories(database.db);

    await expect(
      repositories.userAgents.findRecentAvailable(userId),
    ).resolves.toBeUndefined();
    await expect(
      repositories.userAgents.findDefaultActive(userId),
    ).resolves.toBe(platformId);

    const createdAt = new Date("2026-09-06T00:00:00Z");
    const lowerSessionId = "00000000-0000-4000-8000-000000000010";
    const higherSessionId = "00000000-0000-4000-8000-000000000020";
    await database.client.query(
      `insert into sessions
        (id, owner_user_id, ark_session_id, agent_kind, platform_agent_id,
         personal_agent_id, ark_agent_id, agent_version, environment_id,
         created_at)
       values ($1, $3, 'ark-session-platform', 'platform', $4, null,
               'ark-platform', '1', 'environment-1', $5),
              ($2, $3, 'ark-session-personal', 'personal', null, $6,
               'ark-personal', '1', 'environment-1', $5)`,
      [
        lowerSessionId,
        higherSessionId,
        userId,
        platformId,
        createdAt,
        personalId,
      ],
    );

    await expect(
      repositories.userAgents.findRecentAvailable(userId),
    ).resolves.toBe(personalId);
    await database.client.query(
      `update personal_agents set status = 'disabled' where id = $1`,
      [personalId],
    );
    await expect(
      repositories.userAgents.findRecentAvailable(userId),
    ).resolves.toBe(platformId);
    await database.close();
  });

  it("enforces personal Agent quota atomically and preserves Session snapshots", async () => {
    const database = await createTestDatabase();
    const { userId } = await seedUsers(database.client);
    await database.client.query(
      `update quota_policies set personal_agent_limit = 1 where key = 'default'`,
    );
    const repositories = createRepositories(database.db);
    const ark = new InMemoryArkGateway();
    const generatedIds = [id(), id()];
    const service = new UserAgentService({
      repository: repositories.userAgents as UserAgentRepository,
      ark,
      modelAllowlist: ["model-a"],
      createId: () => generatedIds.shift()!,
    });
    const context = { userId, requestId: "req-db" };
    const created = await service.create(
      {
        name: "Personal",
        description: "",
        modelId: "model-a",
        systemPrompt: "Prompt",
      },
      context,
    );
    await expect(
      service.create(
        {
          name: "Over quota",
          description: "",
          modelId: "model-a",
          systemPrompt: "Prompt",
        },
        context,
      ),
    ).rejects.toBeInstanceOf(PersonalAgentQuotaExceededError);

    const sessionId = id();
    await database.client.query(
      `insert into sessions
        (id, owner_user_id, ark_session_id, agent_kind, personal_agent_id,
         ark_agent_id, agent_version, environment_id)
       values ($1, $2, $3, 'personal', $4, $5, $6, 'environment-1')`,
      [
        sessionId,
        userId,
        `ark-session-${sessionId}`,
        created.id,
        created.arkAgentId,
        created.arkVersion,
      ],
    );
    const updated = await service.update(
      created.id,
      { name: "Version two", arkVersion: created.arkVersion },
      context,
    );
    const session = await database.client.query<{
      ark_agent_id: string;
      agent_version: string;
    }>(`select ark_agent_id, agent_version from sessions where id = $1`, [
      sessionId,
    ]);

    expect(updated.arkVersion).toBe("2");
    await expect(
      service.resolveForNewSession(userId, created.id),
    ).resolves.toMatchObject({ arkVersion: "2" });
    expect(session.rows[0]).toEqual({
      ark_agent_id: created.arkAgentId,
      agent_version: "1",
    });
    await database.close();
  });

  it("does not charge definite failed version-0 creates against quota", async () => {
    const database = await createTestDatabase();
    const { userId } = await seedUsers(database.client);
    await database.client.query(
      `update quota_policies set personal_agent_limit = 1 where key = 'default'`,
    );
    const failedId = id();
    await database.client.query(
      `insert into personal_agents
        (id, owner_user_id, ark_agent_id, name, model_id, system_prompt,
         ark_version, status, last_error_code)
       values ($1, $2, $3, 'Failed', 'model-a', 'Prompt', '0', 'failed',
               'ARK_UNAVAILABLE')`,
      [failedId, userId, `pending:${failedId}`],
    );
    const repositories = createRepositories(database.db);

    await expect(
      repositories.userAgents.createProvisioning({
        id: id(),
        ownerUserId: userId,
        name: "Retry",
        description: "",
        modelId: "model-a",
        systemPrompt: "Prompt",
      }),
    ).resolves.toMatchObject({ status: "provisioning", arkVersion: "0" });
    await database.close();
  });

  it("atomically fails definite create jobs but retains unknown outcomes against quota", async () => {
    const database = await createTestDatabase();
    const { userId } = await seedUsers(database.client);
    await database.client.query(
      `update quota_policies set personal_agent_limit = 1 where key = 'default'`,
    );
    const ark = new InMemoryArkGateway();
    const definiteId = id();
    const unknownId = id();
    const generatedIds = [definiteId, unknownId, id()];
    const repositories = createRepositories(database.db);
    const service = new UserAgentService({
      repository: repositories.userAgents as UserAgentRepository,
      ark,
      modelAllowlist: ["model-a"],
      createId: () => generatedIds.shift()!,
    });
    const context = { userId, requestId: "req-create-outcomes" };
    const input = {
      name: "Personal",
      description: "",
      modelId: "model-a",
      systemPrompt: "Prompt",
    };

    ark.failNext("createAgent", "unavailable");
    await expect(service.create(input, context)).rejects.toMatchObject({
      category: "unavailable",
    });
    const definite = await database.client.query<{
      agent_status: string;
      job_status: string;
      last_error: string;
    }>(
      `select pa.status as agent_status, job.status as job_status,
              job.last_error
         from personal_agents pa
         join background_jobs job on job.id = pa.id
        where pa.id = $1`,
      [definiteId],
    );
    expect(definite.rows[0]).toEqual({
      agent_status: "failed",
      job_status: "failed",
      last_error: "ARK_UNAVAILABLE",
    });
    await expect(
      repositories.userAgents.markProvisioned(definiteId, userId, {
        arkAgentId: "ark-late-worker",
        arkVersion: "1",
      }),
    ).rejects.toThrow("Personal Agent create reconciliation is terminal");
    await expect(
      repositories.userAgents.findOwned(userId, definiteId),
    ).resolves.toMatchObject({
      status: "failed",
      arkVersion: "0",
      arkAgentId: `pending:${definiteId}`,
    });

    ark.failNext("createAgent", "connection_failure");
    await expect(service.create(input, context)).rejects.toMatchObject({
      category: "unknown_write_outcome",
    });
    const unknown = await database.client.query<{
      agent_status: string;
      job_status: string;
    }>(
      `select pa.status as agent_status, job.status as job_status
         from personal_agents pa
         join background_jobs job on job.id = pa.id
        where pa.id = $1`,
      [unknownId],
    );
    expect(unknown.rows[0]).toEqual({
      agent_status: "provisioning",
      job_status: "pending",
    });
    await expect(service.create(input, context)).rejects.toBeInstanceOf(
      PersonalAgentQuotaExceededError,
    );
    await database.close();
  });

  it("charges failed create reconciliation rows with a durable Ark identity", async () => {
    const database = await createTestDatabase();
    const { userId } = await seedUsers(database.client);
    await database.client.query(
      `update quota_policies set personal_agent_limit = 1 where key = 'default'`,
    );
    const personalId = id();
    const repositories = createRepositories(database.db);
    await repositories.userAgents.createProvisioning({
      id: personalId,
      ownerUserId: userId,
      name: "Personal",
      description: "",
      modelId: "model-a",
      systemPrompt: "Prompt",
    });

    await expect(
      repositories.userAgents.markCreatePersistenceFailure(personalId, userId, {
        arkAgentId: "ark-created",
        arkVersion: "7",
      }),
    ).resolves.toMatchObject({
      arkAgentId: "ark-created",
      arkVersion: "7",
      status: "failed",
      lastErrorCode: "DB_PERSISTENCE_FAILED",
    });
    await expect(
      repositories.userAgents.createProvisioning({
        id: id(),
        ownerUserId: userId,
        name: "Over quota",
        description: "",
        modelId: "model-a",
        systemPrompt: "Prompt",
      }),
    ).resolves.toBeUndefined();
    await database.close();
  });

  it("durably enqueues create and pre-Ark update reconciliation intents", async () => {
    const database = await createTestDatabase();
    const { userId } = await seedUsers(database.client);
    const personalId = id();
    const repositories = createRepositories(database.db);

    await repositories.userAgents.createProvisioning({
      id: personalId,
      ownerUserId: userId,
      name: "Personal",
      description: "",
      modelId: "model-a",
      systemPrompt: "Prompt",
    });
    const createJob = await database.client.query<{
      type: string;
      status: string;
      payload: Record<string, unknown>;
    }>(
      `select type, status, payload
         from background_jobs
        where id = $1`,
      [personalId],
    );
    expect(createJob.rows[0]).toEqual({
      type: "reconcile_personal_agent",
      status: "pending",
      payload: { operation: "create", personalAgentId: personalId },
    });

    await repositories.userAgents.markProvisioned(personalId, userId, {
      arkAgentId: "ark-personal",
      arkVersion: "1",
    });
    await repositories.userAgents.saveUpdateIntent(
      personalId,
      userId,
      {
        name: "Recovered",
        description: "",
        modelId: "model-a",
        systemPrompt: "Prompt",
      },
      "1",
    );
    const updateJob = await database.client.query<{
      status: string;
      payload: Record<string, unknown>;
    }>(
      `select status, payload
         from background_jobs
        where id = $1`,
      [personalId],
    );
    expect(updateJob.rows[0]).toEqual({
      status: "pending",
      payload: {
        operation: "update",
        personalAgentId: personalId,
        configuration: {
          name: "Recovered",
          description: "",
          modelId: "model-a",
          systemPrompt: "Prompt",
        },
        arkVersion: "1",
      },
    });
    await database.close();
  });

  it("requeues personal Agent reconciliation and stops after the final retry", async () => {
    const database = await createTestDatabase();
    const { userId } = await seedUsers(database.client);
    const personalId = id();
    const repositories = createRepositories(database.db);
    await repositories.userAgents.createProvisioning({
      id: personalId,
      ownerUserId: userId,
      name: "Personal",
      description: "",
      modelId: "model-a",
      systemPrompt: "Prompt",
    });
    const firstNow = new Date("2100-01-01T00:00:00Z");
    const [first] = await repositories.jobs.claim({
      workerId: "worker-1",
      limit: 1,
      now: firstNow,
      types: ["reconcile_personal_agent"],
    });
    expect(first).toMatchObject({ id: personalId, attempts: 1 });

    await repositories.jobs.retry(
      personalId,
      "worker-1",
      "temporary",
      false,
      firstNow,
    );
    const pending = await database.client.query<{
      status: string;
      last_error: string;
    }>(
      `select status, last_error
         from background_jobs
        where id = $1`,
      [personalId],
    );
    expect(pending.rows[0]).toEqual({
      status: "pending",
      last_error: "temporary",
    });

    const [second] = await repositories.jobs.claim({
      workerId: "worker-2",
      limit: 1,
      now: new Date("2100-01-01T00:05:00Z"),
      types: ["reconcile_personal_agent"],
    });
    expect(second).toMatchObject({ id: personalId, attempts: 2 });
    await repositories.jobs.retry(personalId, "worker-2", "permanent", true);
    const failed = await database.client.query<{
      status: string;
      last_error: string;
    }>(
      `select status, last_error
         from background_jobs
        where id = $1`,
      [personalId],
    );
    expect(failed.rows[0]).toEqual({
      status: "failed",
      last_error: "permanent",
    });
    await database.close();
  });

  it("reclaims a running job only after its lease expires", async () => {
    const database = await createTestDatabase();
    const { userId } = await seedUsers(database.client);
    const personalId = id();
    const repositories = createRepositories(database.db);
    await repositories.userAgents.createProvisioning({
      id: personalId,
      ownerUserId: userId,
      name: "Personal",
      description: "",
      modelId: "model-a",
      systemPrompt: "Prompt",
    });
    const firstNow = new Date("2100-01-01T00:00:00Z");
    await repositories.jobs.claim({
      workerId: "crashed-worker",
      limit: 1,
      now: firstNow,
      types: ["reconcile_personal_agent"],
    });

    await expect(
      repositories.jobs.claim({
        workerId: "early-worker",
        limit: 1,
        now: new Date("2100-01-01T00:04:59.999Z"),
        types: ["reconcile_personal_agent"],
      }),
    ).resolves.toEqual([]);
    await expect(
      repositories.jobs.claim({
        workerId: "recovery-worker",
        limit: 1,
        now: new Date("2100-01-01T00:05:00Z"),
        types: ["reconcile_personal_agent"],
      }),
    ).resolves.toMatchObject([
      {
        id: personalId,
        status: "running",
        attempts: 2,
        lockedBy: "recovery-worker",
      },
    ]);
    await database.close();
  });

  it("fails an exhausted stale-running job instead of stranding it", async () => {
    const database = await createTestDatabase();
    const { userId } = await seedUsers(database.client);
    const personalId = id();
    const repositories = createRepositories(database.db);
    await repositories.userAgents.createProvisioning({
      id: personalId,
      ownerUserId: userId,
      name: "Personal",
      description: "",
      modelId: "model-a",
      systemPrompt: "Prompt",
    });
    await database.client.query(
      `update background_jobs set max_attempts = 1 where id = $1`,
      [personalId],
    );
    await repositories.jobs.claim({
      workerId: "crashed-worker",
      limit: 1,
      now: new Date("2100-01-01T00:00:00Z"),
      types: ["reconcile_personal_agent"],
    });

    await expect(
      repositories.jobs.claim({
        workerId: "recovery-worker",
        limit: 1,
        now: new Date("2100-01-01T00:05:00Z"),
        types: ["reconcile_personal_agent"],
      }),
    ).resolves.toEqual([]);
    const job = await database.client.query<{
      status: string;
      locked_at: Date | null;
      locked_by: string | null;
    }>(
      `select status, locked_at, locked_by
         from background_jobs
        where id = $1`,
      [personalId],
    );
    expect(job.rows[0]).toEqual({
      status: "failed",
      locked_at: null,
      locked_by: null,
    });
    await database.close();
  });

  it("atomically rejects deletion while a Session references the personal Agent", async () => {
    const database = await createTestDatabase();
    const { userId } = await seedUsers(database.client);
    const personalId = id();
    const sessionId = id();
    await database.client.query(
      `insert into personal_agents
        (id, owner_user_id, ark_agent_id, name, model_id, system_prompt,
         ark_version, status)
       values ($1, $2, 'ark-personal', 'Personal', 'model-a', 'Prompt', '1',
               'active')`,
      [personalId, userId],
    );
    await database.client.query(
      `insert into sessions
        (id, owner_user_id, ark_session_id, agent_kind, personal_agent_id,
         ark_agent_id, agent_version, environment_id)
       values ($1, $2, $3, 'personal', $4, 'ark-personal', '1',
               'environment-1')`,
      [sessionId, userId, `ark-session-${sessionId}`, personalId],
    );
    const repositories = createRepositories(database.db);

    await expect(
      repositories.userAgents.beginDelete(personalId, userId),
    ).resolves.toMatchObject({
      agent: { id: personalId, status: "active" },
      previousStatus: "active",
      references: { sessions: 1 },
    });
    await expect(
      repositories.userAgents.findOwned(userId, personalId),
    ).resolves.toMatchObject({ status: "active" });
    await database.close();
  });

  it("preserves create reconciliation when deletion races provisioning", async () => {
    const database = await createTestDatabase();
    const { userId } = await seedUsers(database.client);
    const personalId = id();
    const repositories = createRepositories(database.db);
    await repositories.userAgents.createProvisioning({
      id: personalId,
      ownerUserId: userId,
      name: "Personal",
      description: "",
      modelId: "model-a",
      systemPrompt: "Prompt",
    });

    await expect(
      repositories.userAgents.beginDelete(personalId, userId),
    ).resolves.toMatchObject({
      conflict: "create_reconciliation_pending",
      agent: {
        status: "provisioning",
        arkAgentId: `pending:${personalId}`,
      },
    });
    const unresolved = await database.client.query<{
      agent_status: string;
      job_status: string;
      payload: Record<string, unknown>;
    }>(
      `select pa.status as agent_status, job.status as job_status, job.payload
         from personal_agents pa
         join background_jobs job on job.id = pa.id
        where pa.id = $1`,
      [personalId],
    );
    expect(unresolved.rows[0]).toEqual({
      agent_status: "provisioning",
      job_status: "pending",
      payload: { operation: "create", personalAgentId: personalId },
    });

    await repositories.userAgents.markCreatePersistenceFailure(
      personalId,
      userId,
      {
        arkAgentId: "ark-reconciled",
        arkVersion: "1",
      },
    );
    await expect(
      repositories.userAgents.beginDelete(personalId, userId),
    ).resolves.toMatchObject({
      conflict: "create_reconciliation_pending",
      agent: {
        status: "failed",
        arkAgentId: "ark-reconciled",
      },
    });

    await repositories.userAgents.markProvisioned(personalId, userId, {
      arkAgentId: "ark-reconciled",
      arkVersion: "1",
    });
    await expect(
      repositories.userAgents.beginDelete(personalId, userId),
    ).resolves.toMatchObject({
      agent: { status: "deleting", arkAgentId: "ark-reconciled" },
      previousStatus: "active",
    });
    const reconciled = await database.client.query<{
      agent_status: string;
      job_status: string;
      payload: Record<string, unknown>;
    }>(
      `select pa.status as agent_status, job.status as job_status, job.payload
         from personal_agents pa
         join background_jobs job on job.id = pa.id
        where pa.id = $1`,
      [personalId],
    );
    expect(reconciled.rows[0]).toEqual({
      agent_status: "deleting",
      job_status: "pending",
      payload: { operation: "delete", personalAgentId: personalId },
    });
    await database.close();
  });
});

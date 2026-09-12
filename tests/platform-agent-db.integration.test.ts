import { describe, expect, it } from "vitest";
import { InMemoryArkGateway } from "../packages/ark-client/src/index.js";
import { createRepositories } from "../packages/db/src/index.js";
import {
  AgentReferencedError,
  PlatformAgentService,
  type PlatformAgentRepository,
} from "../packages/domain/src/index.js";
import { createTestDatabase, id } from "./support/test-database.js";

describe("platform Agent database integration", () => {
  it("atomically enqueues monthly quota interrupts after an admin limit reduction", async () => {
    const database = await createTestDatabase();
    const adminId = id();
    const userId = id();
    const agentId = id();
    const sessionId = id();
    await database.client.query(
      `insert into users (id, auth_subject, email, role)
       values ($1, $2, 'admin@example.com', 'admin'),
              ($3, $4, 'user@example.com', 'user')`,
      [adminId, `admin-${adminId}`, userId, `user-${userId}`],
    );
    await database.client.query(
      `insert into quota_policies
         (key, personal_agent_limit, concurrent_session_limit,
          daily_session_limit, monthly_token_limit)
       values ('default', 10, 2, 25, 1000)`,
    );
    await database.client.query(
      `insert into personal_agents
         (id, owner_user_id, ark_agent_id, name, model_id, system_prompt,
          ark_version, status)
       values ($1, $2, 'ark-agent-quota', 'Agent', 'model-a', 'Prompt',
               '1', 'active')`,
      [agentId, userId],
    );
    await database.client.query(
      `insert into sessions
         (id, owner_user_id, ark_session_id, agent_kind, personal_agent_id,
          ark_agent_id, agent_version, environment_id, status)
       values ($1, $2, 'ark-session-quota', 'personal', $3,
               'ark-agent-quota', '1', 'environment-1', 'rescheduled')`,
      [sessionId, userId, agentId],
    );
    await database.client.query(
      `insert into usage_ledger
         (id, user_id, ark_session_id, ark_event_id, metric_type, quantity)
       values ($1, $2, 'ark-session-quota', 'event-usage',
               'input_tokens', 100)`,
      [id(), userId],
    );
    const repositories = createRepositories(database.db);
    const service = new PlatformAgentService({
      repository: repositories.platformAgents as PlatformAgentRepository,
      ark: new InMemoryArkGateway(),
      modelAllowlist: ["model-a"],
      createId: id,
      passwordHasher: {
        hash: async (password: string) => `hashed:${password}`,
      },
    });

    await service.updateUserQuota(
      userId,
      {
        personalAgentLimit: 10,
        concurrentSessionLimit: 2,
        dailySessionLimit: 25,
        monthlyTokenLimit: 50,
      },
      { adminId, requestId: "req-reduce-quota" },
    );

    const jobs = await database.client.query<{
      user_id: string;
      session_id: string;
      status: string;
    }>(
      `select user_id, session_id, status
         from quota_interrupt_jobs`,
    );
    expect(jobs.rows).toEqual([
      { user_id: userId, session_id: sessionId, status: "pending" },
    ]);
    const interruptAudits = await database.client.query<{
      action: string;
      resource_id: string;
      owner_user_id: string;
      metadata: Record<string, unknown> | null;
    }>(
      `select action, resource_id, owner_user_id, metadata
         from audit_logs where action = 'quota_interrupt.enqueue'`,
    );
    expect(interruptAudits.rows).toEqual([
      {
        action: "quota_interrupt.enqueue",
        resource_id: sessionId,
        owner_user_id: userId,
        metadata: {
          monthStart: expect.any(String),
          reason: "monthly_token_limit",
        },
      },
    ]);
    await database.close();
  });

  it("checks references and transitions to deleting in one repository operation", async () => {
    const database = await createTestDatabase();
    const adminId = id();
    const userId = id();
    await database.client.query(
      `insert into users (id, auth_subject, email, role)
       values ($1, $2, 'admin@example.com', 'admin'),
              ($3, $4, 'user@example.com', 'user')`,
      [adminId, `admin-${adminId}`, userId, `user-${userId}`],
    );
    const repositories = createRepositories(database.db);
    const service = new PlatformAgentService({
      repository: repositories.platformAgents as PlatformAgentRepository,
      ark: new InMemoryArkGateway(),
      modelAllowlist: ["model-a"],
      createId: id,
      passwordHasher: {
        hash: async (password: string) => `hashed:${password}`,
      },
    });
    const context = { adminId, requestId: "req-delete" };
    const agent = await service.create(
      {
        name: "Agent",
        description: "",
        modelId: "model-a",
        systemPrompt: "Prompt",
      },
      context,
    );
    await service.assignDefault(userId, agent.id, context);

    await expect(
      repositories.platformAgents.beginDelete(agent.id, adminId),
    ).resolves.toMatchObject({
      agent: { id: agent.id, status: "active" },
      references: { assignments: 1, sessions: 0 },
    });
    await expect(
      repositories.platformAgents.findById(agent.id),
    ).resolves.toMatchObject({
      status: "active",
    });

    await database.client.query(
      `delete from user_default_agents where user_id = $1`,
      [userId],
    );
    await expect(
      repositories.platformAgents.beginDelete(agent.id, adminId),
    ).resolves.toMatchObject({
      agent: { id: agent.id, status: "deleting", updatedBy: adminId },
      references: { assignments: 0, sessions: 0 },
    });
    await database.close();
  });

  it("assigns defaults transactionally without changing existing Session snapshots", async () => {
    const database = await createTestDatabase();
    const adminId = id();
    const userId = id();
    await database.client.query(
      `insert into users (id, auth_subject, email, role)
       values ($1, $2, 'admin@example.com', 'admin'),
              ($3, $4, 'user@example.com', 'user')`,
      [adminId, `admin-${adminId}`, userId, `user-${userId}`],
    );
    const repositories = createRepositories(database.db);
    const service = new PlatformAgentService({
      repository: repositories.platformAgents as PlatformAgentRepository,
      ark: new InMemoryArkGateway(),
      modelAllowlist: ["model-a"],
      createId: id,
      passwordHasher: {
        hash: async (password: string) => `hashed:${password}`,
      },
    });
    const context = { adminId, requestId: "req-db" };
    const first = await service.create(
      {
        name: "First",
        description: "",
        modelId: "model-a",
        systemPrompt: "First prompt",
      },
      context,
    );
    const second = await service.create(
      {
        name: "Second",
        description: "",
        modelId: "model-a",
        systemPrompt: "Second prompt",
      },
      context,
    );

    await service.assignDefault(userId, first.id, context);
    const sessionId = id();
    await database.client.query(
      `insert into sessions
        (id, owner_user_id, ark_session_id, agent_kind, platform_agent_id,
         ark_agent_id, agent_version, environment_id)
       values ($1, $2, $3, 'platform', $4, $5, $6, 'environment-1')`,
      [
        sessionId,
        userId,
        `ark-session-${sessionId}`,
        first.id,
        first.arkAgentId,
        first.arkVersion,
      ],
    );

    await service.assignDefault(userId, second.id, context);
    const assignment = await repositories.defaultAgents.findForUser(userId);
    const session = await database.client.query<{
      platform_agent_id: string;
      ark_agent_id: string;
      agent_version: string;
    }>(
      `select platform_agent_id, ark_agent_id, agent_version
         from sessions where id = $1`,
      [sessionId],
    );

    expect(assignment?.platformAgentId).toBe(second.id);
    expect(session.rows[0]).toEqual({
      platform_agent_id: first.id,
      ark_agent_id: first.arkAgentId,
      agent_version: first.arkVersion,
    });
    await expect(service.delete(first.id, context)).rejects.toBeInstanceOf(
      AgentReferencedError,
    );
    await database.close();
  });

  it("rejects disabled Agent assignment and records minimized audits", async () => {
    const database = await createTestDatabase();
    const adminId = id();
    const userId = id();
    await database.client.query(
      `insert into users (id, auth_subject, email, role)
       values ($1, $2, 'admin@example.com', 'admin'),
              ($3, $4, 'user@example.com', 'user')`,
      [adminId, `admin-${adminId}`, userId, `user-${userId}`],
    );
    await database.client.query(
      `insert into quota_policies
         (key, personal_agent_limit, concurrent_session_limit,
          daily_session_limit, monthly_token_limit)
       values ('default', 10, 2, 25, 1000)`,
    );
    await database.client.query(
      `insert into user_quota_overrides
         (user_id, personal_agent_limit, concurrent_session_limit,
          daily_session_limit, monthly_token_limit, updated_by)
       values ($1, 3, 1, 5, 500, $2)`,
      [userId, adminId],
    );
    const repositories = createRepositories(database.db);
    const service = new PlatformAgentService({
      repository: repositories.platformAgents as PlatformAgentRepository,
      ark: new InMemoryArkGateway(),
      modelAllowlist: ["model-a"],
      createId: id,
      passwordHasher: {
        hash: async (password: string) => `hashed:${password}`,
      },
    });
    const context = { adminId, requestId: "req-audit" };
    const agent = await service.create(
      {
        name: "Agent",
        description: "Description",
        modelId: "model-a",
        systemPrompt: "secret prompt",
      },
      context,
    );
    await service.update(agent.id, { status: "disabled" }, context);

    await expect(
      service.assignDefault(userId, agent.id, context),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    expect(await service.listUsers()).toEqual({
      users: expect.arrayContaining([
        {
          id: adminId,
          email: "admin@example.com",
          role: "admin",
          status: "active",
          hasPassword: false,
          defaultAgentId: null,
          createdAt: expect.any(Date),
          quota: {
            personalAgentLimit: 10,
            concurrentSessionLimit: 2,
            dailySessionLimit: 25,
            monthlyTokenLimit: 1000,
          },
        },
        {
          id: userId,
          email: "user@example.com",
          role: "user",
          status: "active",
          hasPassword: false,
          defaultAgentId: null,
          createdAt: expect.any(Date),
          quota: {
            personalAgentLimit: 3,
            concurrentSessionLimit: 1,
            dailySessionLimit: 5,
            monthlyTokenLimit: 500,
          },
        },
      ]),
      nextCursor: null,
    });
    await expect(
      service.updateUserQuota(
        userId,
        {
          personalAgentLimit: 3,
          concurrentSessionLimit: 1,
          dailySessionLimit: 5,
          monthlyTokenLimit: 500,
        },
        context,
      ),
    ).resolves.toEqual({
      userId,
      personalAgentLimit: 3,
      concurrentSessionLimit: 1,
      dailySessionLimit: 5,
      monthlyTokenLimit: 500,
      inherited: {
        personalAgentLimit: false,
        concurrentSessionLimit: false,
        dailySessionLimit: false,
        monthlyTokenLimit: false,
      },
    });
    const audits = await database.client.query<{
      action: string;
      resource_type: string;
      metadata: Record<string, unknown> | null;
    }>(
      `select action, resource_type, metadata
         from audit_logs order by created_at, action`,
    );
    expect(audits.rows.map(({ action }) => action)).toEqual([
      "platform_agent.create",
      "platform_agent.disable",
      "user_default_agent.assign",
      "user_quota.update",
    ]);
    expect(
      audits.rows.find(({ action }) => action === "user_quota.update")
        ?.resource_type,
    ).toBe("user_quota");
    expect(JSON.stringify(audits.rows)).not.toContain("secret prompt");
    await database.close();
  });

  it("guards the last active administrator and revokes sessions on lifecycle changes", async () => {
    const database = await createTestDatabase();
    const adminId = id();
    const secondAdminId = id();
    const userId = id();
    await database.client.query(
      `insert into users (id, auth_subject, email, role)
       values ($1, $2, 'admin@example.com', 'admin'),
              ($3, $4, 'second@example.com', 'admin'),
              ($5, $6, 'user@example.com', 'user')`,
      [
        adminId,
        `admin-${adminId}`,
        secondAdminId,
        `admin-${secondAdminId}`,
        userId,
        `user-${userId}`,
      ],
    );
    for (const [owner, label] of [
      [adminId, "admin"],
      [userId, "user"],
    ] as const) {
      await database.client.query(
        `insert into auth_sessions (id, user_id, token_hash, expires_at)
         values ($1, $2, $3, now() + interval '1 day')`,
        [id(), owner, `token-${label}`],
      );
    }
    const repositories = createRepositories(database.db);
    const service = new PlatformAgentService({
      repository: repositories.platformAgents as PlatformAgentRepository,
      ark: new InMemoryArkGateway(),
      modelAllowlist: ["model-a"],
      createId: id,
      passwordHasher: {
        hash: async (password: string) => `hashed:${password}`,
      },
    });
    const context = { adminId, requestId: "req-lifecycle" };

    // Self-targeting is rejected before any repository mutation.
    await expect(
      service.setUserStatus(adminId, "disabled", context),
    ).rejects.toMatchObject({ code: "SELF_TARGET_FORBIDDEN" });

    // Disabling a regular user revokes their sessions in the same operation.
    const disabled = await service.setUserStatus(userId, "disabled", context);
    expect(disabled).toEqual({
      from: "active",
      to: "disabled",
      revokedSessions: 1,
    });

    // A second admin may be demoted while another active admin remains.
    const demoted = await service.setUserRole(secondAdminId, "user", context);
    expect(demoted).toEqual({
      from: "admin",
      to: "user",
      revokedSessions: 0,
    });

    // The service rejects self-targeting before the repository is involved…
    await expect(
      service.setUserRole(adminId, "user", context),
    ).rejects.toMatchObject({ code: "SELF_TARGET_FORBIDDEN" });
    // …and the repository independently guards the last active administrator,
    // so a future caller that skips the service check still cannot lock the
    // console out.
    await expect(
      repositories.platformAgents.setUserStatus({
        userId: adminId,
        status: "disabled",
        actorId: adminId,
      }),
    ).resolves.toBe("last_active_admin");

    const sessions = await database.client.query<{
      token_hash: string;
      revoked_at: string | null;
    }>(`select token_hash, revoked_at from auth_sessions order by token_hash`);
    expect(sessions.rows).toEqual([
      { token_hash: "token-admin", revoked_at: null },
      { token_hash: "token-user", revoked_at: expect.anything() },
    ]);

    const audits = await database.client.query<{
      action: string;
      result: string;
    }>(`select action, result from audit_logs order by created_at`);
    expect(audits.rows).toEqual([
      { action: "user.status.update", result: "failed" },
      { action: "user.status.update", result: "succeeded" },
      { action: "user.role.update", result: "succeeded" },
      { action: "user.role.update", result: "failed" },
    ]);
    await database.close();
  });
});

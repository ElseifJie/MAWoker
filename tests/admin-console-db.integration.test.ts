import { describe, expect, it } from "vitest";
import { InMemoryArkGateway } from "../packages/ark-client/src/index.js";
import { createRepositories } from "../packages/db/src/index.js";
import {
  AdminUsageService,
  PlatformAgentService,
  QuotaPolicyService,
  type PlatformAgentRepository,
} from "../packages/domain/src/index.js";
import { createTestDatabase, id } from "./support/test-database.js";

describe("admin console database integration", () => {
  it("aggregates the monthly usage overview with near and exhausted states", async () => {
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
      `insert into platform_agents
         (id, ark_agent_id, name, model_id, system_prompt, ark_version,
          status, created_by, updated_by)
       values ($1, 'ark-agent-usage', 'Agent', 'model-a', 'Prompt', '1',
               'active', $2, $2)`,
      [agentId, adminId],
    );
    await database.client.query(
      `insert into user_default_agents (user_id, platform_agent_id, assigned_by)
       values ($1, $2, $3)`,
      [userId, agentId, adminId],
    );
    await database.client.query(
      `insert into sessions
         (id, owner_user_id, ark_session_id, agent_kind, platform_agent_id,
          ark_agent_id, agent_version, environment_id, status)
       values ($1, $2, 'ark-session-usage', 'platform', $3,
               'ark-agent-usage', '1', 'environment-1', 'idle')`,
      [sessionId, userId, agentId],
    );
    for (const [eventId, metric, quantity] of [
      ["event-input", "input_tokens", 300],
      ["event-output", "output_tokens", 500],
      ["event-tool", "tool_calls", 4],
    ] as const) {
      await database.client.query(
        `insert into usage_ledger
           (id, user_id, ark_session_id, ark_event_id, metric_type, quantity,
            agent_kind, platform_agent_id, model_id)
         values ($1, $2, 'ark-session-usage', $3, $4, $5,
                 'platform', $6, 'model-a')`,
        [id(), userId, eventId, metric, quantity, agentId],
      );
    }
    const repositories = createRepositories(database.db);
    const service = new AdminUsageService({
      repository: {
        overview: (input) => repositories.usage.adminOverview(input),
        byAgents: (input) => repositories.usage.byAgents(input),
      },
    });

    const overview = await service.overview({ limit: 50, before: null });
    expect(overview.totals).toEqual({
      inputTokens: 300,
      outputTokens: 500,
      tokens: 800,
      activeUsers: 1,
      sessions: 1,
      exhaustedUsers: 0,
    });
    expect(overview.users).toHaveLength(2);
    const userRow = overview.users.find((row) => row.userId === userId)!;
    // 800 of 1000 tokens = 80% → near on the token dimension.
    expect(userRow.dimensionStatus.monthlyTokens).toBe("near");
    expect(userRow.usage).toMatchObject({
      inputTokens: 300,
      outputTokens: 500,
      tokens: 800,
      toolCalls: 4,
    });
    const adminRow = overview.users.find((row) => row.userId === adminId)!;
    expect(adminRow.dimensionStatus.monthlyTokens).toBe("ok");
    expect(overview.nextCursor).toBeNull();

    const agents = await service.byAgents();
    expect(agents.platform).toEqual([
      {
        platformAgentId: agentId,
        name: "Agent",
        status: "active",
        defaultAssignments: 1,
        inputTokens: 300,
        outputTokens: 500,
        tokens: 800,
      },
    ]);
    expect(agents.personal).toEqual({ personalAgents: 0, tokens: 0 });
    await database.close();
  });

  it("edits the default policy at runtime and re-evaluates over-limit users", async () => {
    const database = await createTestDatabase();
    const adminId = id();
    const userId = id();
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
    const policyAgentId = id();
    await database.client.query(
      `insert into platform_agents
         (id, ark_agent_id, name, model_id, system_prompt, ark_version,
          status, created_by, updated_by)
       values ($1, 'ark-agent-policy', 'Agent', 'model-a', 'Prompt', '1',
               'active', $2, $2)`,
      [policyAgentId, adminId],
    );
    await database.client.query(
      `insert into sessions
         (id, owner_user_id, ark_session_id, agent_kind, platform_agent_id,
          ark_agent_id, agent_version, environment_id, status)
       values ($1, $2, 'ark-session-policy', 'platform', $3, 'ark-agent-policy',
               '1', 'environment-1', 'running')`,
      [sessionId, userId, policyAgentId],
    );
    await database.client.query(
      `insert into usage_ledger
         (id, user_id, ark_session_id, ark_event_id, metric_type, quantity)
       values ($1, $2, 'ark-session-policy', 'event-1', 'input_tokens', 400)`,
      [id(), userId],
    );
    const repositories = createRepositories(database.db);
    const service = new QuotaPolicyService({
      repository: repositories.quotaPolicies,
    });

    const current = await service.getDefault();
    expect(current?.monthlyTokenLimit).toBe(1000);

    const result = await service.updateDefault(
      {
        personalAgentLimit: 10,
        concurrentSessionLimit: 2,
        dailySessionLimit: 25,
        monthlyTokenLimit: 300,
      },
      { adminId, requestId: "req-policy" },
    );
    expect(result.updated.monthlyTokenLimit).toBe(300);
    expect(result.overLimitUserIds).toEqual([userId]);

    const jobs = await database.client.query(
      `select session_id from quota_interrupt_jobs`,
    );
    expect(jobs.rows).toEqual([{ session_id: sessionId }]);

    const audit = await database.client.query<{
      action: string;
      metadata: Record<string, unknown>;
    }>(
      `select action, metadata from audit_logs where action = 'quota_policy.update'`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.metadata).toMatchObject({
      from: { monthlyTokenLimit: 1000 },
      to: { monthlyTokenLimit: 300 },
    });
    await database.close();
  });

  it("clearing every quota override returns the user to inherited defaults", async () => {
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
    const repositories = createRepositories(database.db);
    const service = new PlatformAgentService({
      repository:
        repositories.platformAgents as unknown as PlatformAgentRepository,
      ark: new InMemoryArkGateway(),
      modelAllowlist: ["model-a"],
      createId: id,
      passwordHasher: {
        hash: async (password: string) => `hashed:${password}`,
      },
    });
    const context = { adminId, requestId: "req-quota" };

    const overridden = await service.updateUserQuota(
      userId,
      { personalAgentLimit: 3, monthlyTokenLimit: null },
      context,
    );
    expect(overridden.personalAgentLimit).toBe(3);
    expect(overridden.monthlyTokenLimit).toBe(1000);
    expect(overridden.inherited).toEqual({
      personalAgentLimit: false,
      concurrentSessionLimit: true,
      dailySessionLimit: true,
      monthlyTokenLimit: true,
    });

    const inherited = await service.updateUserQuota(
      userId,
      {
        personalAgentLimit: null,
        concurrentSessionLimit: null,
        dailySessionLimit: null,
        monthlyTokenLimit: null,
      },
      context,
    );
    expect(inherited.personalAgentLimit).toBe(10);
    expect(inherited.inherited.personalAgentLimit).toBe(true);

    const overrides = await database.client.query(
      `select count(*)::integer as count from user_quota_overrides`,
    );
    expect(overrides.rows[0]).toEqual({ count: 0 });
    await database.close();
  });

  it("returns the account detail with metadata-only sessions", async () => {
    const database = await createTestDatabase();
    const adminId = id();
    const userId = id();
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
    const detailAgentId = id();
    await database.client.query(
      `insert into platform_agents
         (id, ark_agent_id, name, model_id, system_prompt, ark_version,
          status, created_by, updated_by)
       values ($1, 'ark-agent-detail', 'Agent', 'model-a', 'Prompt', '1',
               'active', $2, $2)`,
      [detailAgentId, adminId],
    );
    await database.client.query(
      `insert into sessions
         (id, owner_user_id, ark_session_id, agent_kind, platform_agent_id,
          ark_agent_id, agent_name, agent_version, environment_id, status,
          title)
       values ($1, $2, 'ark-session-detail', 'platform', $3,
               'ark-agent-detail', 'Agent', '1', 'environment-1', 'idle',
               'Quarterly report')`,
      [sessionId, userId, detailAgentId],
    );
    await database.client.query(
      `insert into usage_ledger
         (id, user_id, ark_session_id, ark_event_id, metric_type, quantity)
       values ($1, $2, 'ark-session-detail', 'event-1', 'input_tokens', 120)`,
      [id(), userId],
    );
    const repositories = createRepositories(database.db);

    const user = await repositories.adminUsers.getUser(userId);
    expect(user).toMatchObject({
      email: "user@example.com",
      hasPassword: false,
      overridden: {
        personalAgentLimit: false,
        concurrentSessionLimit: false,
        dailySessionLimit: false,
        monthlyTokenLimit: false,
      },
    });

    const page = await repositories.adminUsers.listSessions(userId, {
      limit: 50,
      before: null,
    });
    expect(page.sessions).toEqual([
      {
        id: sessionId,
        title: "Quarterly report",
        status: "idle",
        agentKind: "platform",
        agentName: "Agent",
        agentVersion: "1",
        createdAt: expect.any(Date),
        lastEventAt: null,
        archivedAt: null,
        deletionState: "none",
        tokens: 120,
      },
    ]);
    expect(page.nextCursor).toBeNull();
    await database.close();
  });
});

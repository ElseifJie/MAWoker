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
    const repositories = createRepositories(database.db);
    const service = new PlatformAgentService({
      repository: repositories.platformAgents as PlatformAgentRepository,
      ark: new InMemoryArkGateway(),
      modelAllowlist: ["model-a"],
      createId: id,
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
    expect(await service.listUsers()).toEqual([
      {
        id: userId,
        email: "user@example.com",
        status: "active",
        defaultAgentId: null,
      },
    ]);
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
});

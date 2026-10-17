import { describe, expect, it } from "vitest";
import { createRepositories } from "../packages/db/src/index.js";
import { AccountExportService } from "../packages/domain/src/index.js";
import { createTestDatabase, id } from "./support/test-database.js";

describe("account export", () => {
  it("exports only the owner's user-facing data and never secrets", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const owner = id();
    const other = id();
    const agentId = id();
    const sessionId = id();
    const automationId = id();

    await database.client.query(
      `insert into users (id, auth_subject, email, password_hash, role)
       values ($1, $2, $3, 'secret-hash', 'user'),
              ($4, $5, $6, 'other-hash', 'user')`,
      [
        owner,
        `local:${owner}@example.com`,
        "owner@example.com",
        other,
        `local:${other}@example.com`,
        "other@example.com",
      ],
    );
    await database.client.query(
      `insert into personal_agents
         (id, owner_user_id, ark_agent_id, name, description, model_id,
          system_prompt, ark_version, status)
       values ($1, $2, 'agent-ark-secret', '助手', '', 'model-1', '', '1', 'active')`,
      [agentId, owner],
    );
    await database.client.query(
      `insert into sessions
         (id, owner_user_id, ark_session_id, agent_kind, personal_agent_id,
          ark_agent_id, agent_name, agent_version, environment_id, title, status)
       values ($1, $2, 'ark-session-secret', 'personal', $3,
               'agent-ark-secret', '助手', '1', 'env-1', '导出任务', 'idle')`,
      [sessionId, owner, agentId],
    );
    await database.client.query(
      `insert into user_notifications
         (id, owner_user_id, session_id, turn_id, source_type, source_id,
          dedupe_key, payload, kind)
       values ($1, $2, null, null, 'automation', 'source-1',
               'automation:1', '{"title":"喝水"}', 'reminder')`,
      [id(), owner],
    );
    await database.client.query(
      `insert into automations
         (id, owner_user_id, title, kind, schedule, timezone, next_run_at)
       values ($1, $2, '喝水', 'reminder', '{"type":"daily","time":"09:00"}',
               'Asia/Shanghai', '2026-10-18T01:00:00Z')`,
      [automationId, owner],
    );
    await database.client.query(
      `insert into user_memory_stores (user_id, state, revision)
       values ($1, '{"preferences":{}}', 1)`,
      [owner],
    );

    const service = new AccountExportService({
      repository: repositories.accountExport,
      now: () => new Date("2026-10-17T00:00:00.000Z"),
    });
    const result = await service.export(owner);

    expect(result).toMatchObject({
      schemaVersion: "1",
      user: { email: "owner@example.com" },
    });
    expect(result.sessions).toHaveLength(1);
    expect(result.notifications).toHaveLength(1);
    expect(result.automations).toHaveLength(1);
    expect(result.memoryStore).not.toBeNull();

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("secret-hash");
    expect(serialized).not.toContain("other-hash");
    expect(serialized).not.toContain("ark-session-secret");
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("token");

    const otherExport = await service.export(other);
    expect(otherExport.sessions).toEqual([]);
    expect(otherExport.automations).toEqual([]);
    await database.close();
  });
});

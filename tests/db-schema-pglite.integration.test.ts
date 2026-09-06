import { describe, expect, it } from "vitest";
import { createTestDatabase, id } from "./support/test-database.js";

describe("database migration in PGlite", () => {
  it("creates the complete Task 2 schema and enforces core constraints", async () => {
    const database = await createTestDatabase();
    const tables = await database.client.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' order by table_name`,
    );
    expect(tables.rows.map(({ table_name }) => table_name)).toEqual(
      expect.arrayContaining([
        "artifacts",
        "audit_logs",
        "auth_sessions",
        "background_jobs",
        "personal_agents",
        "platform_agents",
        "quota_policies",
        "quota_reservations",
        "session_event_cursors",
        "session_inputs",
        "sessions",
        "usage_ledger",
        "user_default_agents",
        "user_quota_overrides",
        "users",
      ]),
    );

    const ownerId = id();
    await database.client.query(
      `insert into users (id, auth_subject, email)
       values ($1, 'subject-1', 'owner@example.com')`,
      [ownerId],
    );
    await expect(
      database.client.query(
        `insert into users (id, auth_subject, email)
         values ($1, 'subject-1', 'other@example.com')`,
        [id()],
      ),
    ).rejects.toMatchObject({ code: "23505" });

    await expect(
      database.client.query(
        `insert into sessions
          (id, owner_user_id, ark_session_id, agent_kind, ark_agent_id,
           agent_version, environment_id, status)
         values ($1, $2, 'ark-session-1', 'personal', 'ark-agent-1',
                 '1', 'env-1', 'idle')`,
        [id(), ownerId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await database.close();
  });
});

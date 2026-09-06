import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { createTestDatabase, id } from "./support/test-database.js";

async function applyMigration(client: PGlite, name: string): Promise<void> {
  const migration = readFileSync(
    resolve(import.meta.dirname, `../packages/db/migrations/${name}`),
    "utf8",
  );
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await client.exec(statement);
  }
}

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

  it("backfills historical Session Agent names before making the snapshot required", async () => {
    const client = new PGlite();
    await applyMigration(client, "0000_shiny_nightcrawler.sql");
    await applyMigration(client, "0001_premium_bastion.sql");
    await applyMigration(client, "0002_thankful_mandroid.sql");
    const adminId = id();
    const userId = id();
    const platformAgentId = id();
    const personalAgentId = id();
    await client.query(
      `insert into users (id, auth_subject, email, role)
       values ($1, 'admin', 'admin@example.com', 'admin'),
              ($2, 'user', 'user@example.com', 'user')`,
      [adminId, userId],
    );
    await client.query(
      `insert into platform_agents
        (id, ark_agent_id, name, model_id, system_prompt, ark_version,
         status, created_by, updated_by)
       values ($1, 'ark-platform', 'Historical Platform', 'model-a', 'Prompt',
               '1', 'active', $2, $2)`,
      [platformAgentId, adminId],
    );
    await client.query(
      `insert into personal_agents
        (id, owner_user_id, ark_agent_id, name, model_id, system_prompt,
         ark_version, status)
       values ($1, $2, 'ark-personal', 'Historical Personal', 'model-a',
               'Prompt', '1', 'active')`,
      [personalAgentId, userId],
    );
    await client.query(
      `insert into sessions
        (id, owner_user_id, ark_session_id, agent_kind, platform_agent_id,
         personal_agent_id, ark_agent_id, agent_version, environment_id)
       values ($1, $2, 'ark-session-platform', 'platform', $3, null,
               'ark-platform', '1', 'environment-1'),
              ($4, $2, 'ark-session-personal', 'personal', null, $5,
               'ark-personal', '1', 'environment-1')`,
      [id(), userId, platformAgentId, id(), personalAgentId],
    );

    await applyMigration(client, "0003_clumsy_marvel_zombies.sql");

    const sessions = await client.query<{
      ark_session_id: string;
      agent_name: string;
    }>(
      `select ark_session_id, agent_name
         from sessions
        order by ark_session_id`,
    );
    expect(sessions.rows).toEqual([
      {
        ark_session_id: "ark-session-personal",
        agent_name: "Historical Personal",
      },
      {
        ark_session_id: "ark-session-platform",
        agent_name: "Historical Platform",
      },
    ]);
    await client.close();
  });
});

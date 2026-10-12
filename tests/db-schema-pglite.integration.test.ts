import { readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
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

  it("anchors usage to durable reservations with the T03-A status model", async () => {
    const database = await createTestDatabase();
    const statusValues = await database.client.query<{ enumlabel: string }>(
      `select enumlabel
         from pg_enum
        where enumtypid = 'quota_reservation_status'::regtype
        order by enumsortorder`,
    );
    expect(statusValues.rows.map(({ enumlabel }) => enumlabel)).toEqual([
      "active",
      "unknown_outcome",
      "consumed",
      "released",
    ]);

    const columns = await database.client.query<{
      column_name: string;
      is_nullable: string;
    }>(
      `select column_name, is_nullable
         from information_schema.columns
        where table_name = 'quota_reservations'
          and column_name = 'ark_session_id'`,
    );
    expect(columns.rows).toEqual([
      { column_name: "ark_session_id", is_nullable: "NO" },
    ]);

    const constraints = await database.client.query<{
      name: string;
      definition: string;
    }>(
      `select conname as name, pg_get_constraintdef(oid) as definition
         from pg_constraint
        where conrelid in (
          'quota_reservations'::regclass,
          'usage_ledger'::regclass
        )
        order by conname`,
    );
    expect(constraints.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          definition: expect.stringMatching(
            /unique \(user_id, ark_session_id\)/i,
          ),
        }),
        expect.objectContaining({
          name: "usage_ledger_reservation_owner_fk",
          definition: expect.stringMatching(
            /foreign key \(user_id, ark_session_id\) references quota_reservations\(user_id, ark_session_id\) on update cascade/i,
          ),
        }),
      ]),
    );
    expect(
      constraints.rows.some(
        ({ name }) => name === "usage_ledger_session_owner_fk",
      ),
    ).toBe(false);
    await database.close();
  });

  it("adds model attribution precision without rewriting existing attribution", async () => {
    const database = await createTestDatabase();
    // A pre-0023 ledger row keeps its historical model id but is marked
    // unknown: nothing back-fills it to exact or approximate.
    const userId = id();
    await database.client.query(
      `insert into users (id, auth_subject, email) values ($1, $2, $3)`,
      [userId, `subject-${userId}`, `${userId}@example.com`],
    );
    await database.client.query(
      `insert into quota_policies
        (key, personal_agent_limit, concurrent_session_limit,
         daily_session_limit, monthly_token_limit)
       values ('default', 10, 2, 5, 1000)`,
    );
    await database.client.query(
      `insert into quota_reservations
        (id, user_id, ark_session_id, status, expires_at)
       values ($1, $2, 'ark-legacy-1', 'consumed', '2026-10-12T00:00:00Z')`,
      [id(), userId],
    );
    await database.client.query(
      `insert into usage_ledger
        (id, user_id, ark_session_id, ark_event_id, metric_type, quantity, model_id)
       values ($1, $2, 'ark-legacy-1', 'event-legacy-1', 'input_tokens', 7,
               'model-legacy')`,
      [id(), userId],
    );

    const enumValues = await database.client.query<{ enumlabel: string }>(
      `select enumlabel from pg_enum
        where enumtypid = 'model_attribution_precision'::regtype
        order by enumsortorder`,
    );
    expect(enumValues.rows.map(({ enumlabel }) => enumlabel)).toEqual([
      "exact",
      "approximate",
      "unknown",
    ]);

    const legacy = await database.client.query<{
      model_id: string | null;
      precision: string;
    }>(
      `select model_id, model_attribution_precision::text as precision
         from usage_ledger where ark_event_id = 'event-legacy-1'`,
    );
    expect(legacy.rows[0]).toEqual({
      model_id: "model-legacy",
      precision: "unknown",
    });

    // The migration only adds the column: no UPDATE touches existing rows.
    const migrationsDirectory = resolve(
      import.meta.dirname,
      "../packages/db/migrations",
    );
    const migrationNames = await readdir(migrationsDirectory);
    const migration0023 = migrationNames.find((name) =>
      name.startsWith("0023_"),
    );
    expect(migration0023).toBeDefined();
    const migration = await readFile(
      resolve(migrationsDirectory, migration0023!),
      "utf8",
    );
    expect(migration).toMatch(
      /create type "public"\."model_attribution_precision" as enum\('exact', 'approximate', 'unknown'\)/i,
    );
    expect(migration).toMatch(
      /add column "model_attribution_precision" "model_attribution_precision" default 'unknown' not null/i,
    );
    expect(migration).not.toMatch(/update "usage_ledger"/i);
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

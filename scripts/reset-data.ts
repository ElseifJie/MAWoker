import pg from "pg";
import {
  ensureAdministrator,
  ensureDefaultQuotaPolicy,
  readAdministratorInput,
  readDefaultQuota,
} from "./lib/administrator.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const input = readAdministratorInput(process.env);
if (typeof input === "string") {
  console.error(input);
  process.exit(1);
}

const quota = readDefaultQuota(process.env);
if (typeof quota === "string") {
  console.error(quota);
  process.exit(1);
}

// Everything users own. Platform Agent configuration is kept and re-pointed at
// the new administrator instead, because the Ark managed agents it references
// live outside this database.
const USER_DATA_TABLES = [
  "usage_ledger",
  "artifacts",
  "session_inputs",
  "quota_interrupt_jobs",
  "background_jobs",
  "sessions",
  "session_event_cursors",
  "personal_agents",
  "user_default_agents",
  "user_quota_overrides",
  "quota_reservations",
  "auth_sessions",
  "audit_logs",
].join(", ");

const pool = new pg.Pool({ connectionString: databaseUrl });

try {
  await pool.query(
    `truncate table ${USER_DATA_TABLES} restart identity cascade`,
  );
  console.log("cleared sessions, inputs, artifacts, usage and audit history");

  await ensureDefaultQuotaPolicy(pool, quota);

  const administrator = await ensureAdministrator(pool, input);

  const repointed = await pool.query(
    `update platform_agents
        set created_by = $1,
            updated_by = $1,
            updated_at = now()
      where created_by <> $1
         or updated_by <> $1`,
    [administrator.id],
  );
  console.log(
    `re-pointed ${repointed.rowCount} platform Agent(s) at the administrator`,
  );

  const removed = await pool.query(
    "delete from users where id <> $1 returning email",
    [administrator.id],
  );
  console.log(`removed ${removed.rowCount} previous account(s)`);

  console.log(
    `administrator ready: ${input.email} (password ${administrator.passwordUpdated ? "set" : "unchanged"})`,
  );
} catch (error) {
  console.error("data reset failed:", error);
  process.exit(1);
} finally {
  await pool.end();
}

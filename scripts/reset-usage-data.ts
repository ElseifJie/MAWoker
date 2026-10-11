import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

// Usage footprint only. Accounts (users), platform configuration
// (platform_agents, quota_policies), user assets (personal_agents, skills,
// user_default_agents, user_quota_overrides) and durable Memory Stores
// (user_memory_stores) are kept.
const USAGE_TABLES = [
  "session_event_cursors",
  "session_events",
  "artifacts",
  "drive_files",
  "session_inputs",
  "usage_ledger",
  "quota_reservations",
  "quota_interrupt_jobs",
  "background_jobs",
  "auth_sessions",
  "audit_logs",
  "sessions",
].join(", ");

const pool = new pg.Pool({ connectionString: databaseUrl });

try {
  await pool.query(`truncate table ${USAGE_TABLES} restart identity`);
  console.log(
    "cleared sessions, events, inputs, artifacts, drive files, usage, quota state, auth sessions and audit history",
  );
} catch (error) {
  console.error("usage data reset failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}

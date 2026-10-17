import { sql, type SQL } from "drizzle-orm";

type Row = Record<string, unknown>;

interface Database {
  execute<T extends Row = Row>(query: SQL): PromiseLike<{ rows: T[] }>;
}

/**
 * Owner-scoped export. Every query selects only user-facing metadata: tokens,
 * password hashes, storage keys, Ark session IDs, and lease fields stay private.
 */
export function createAccountExportRepository(db: Database) {
  return {
    async export(userId: string) {
      const [
        users,
        agents,
        sessions,
        runs,
        notifications,
        inputs,
        artifacts,
        memories,
        automations,
        skills,
      ] = await Promise.all([
        db.execute(
          sql`select id, email, role, status, created_at as "createdAt"
                from users where id = ${userId} limit 1`,
        ),
        db.execute(
          sql`select id, name, description, model_id as "modelId", status,
                     created_at as "createdAt", updated_at as "updatedAt"
                from personal_agents where owner_user_id = ${userId}
               order by created_at, id`,
        ),
        db.execute(
          sql`select id, title, status, agent_name as "agentName",
                     model_id as "modelId", archived_at as "archivedAt",
                     pinned_at as "pinnedAt", created_at as "createdAt",
                     updated_at as "updatedAt"
                from sessions
               where owner_user_id = ${userId}
                 and deletion_state = 'none'
               order by created_at, id
               limit 500`,
        ),
        db.execute(
          sql`select id, conversation_id as "conversationId",
                     trigger_kind as "triggerKind", status, error_code as "errorCode",
                     created_at as "createdAt", started_at as "startedAt",
                     ended_at as "endedAt"
                from runs
               where owner_user_id = ${userId}
               order by created_at, id
               limit 1000`,
        ),
        db.execute(
          sql`select id, session_id as "sessionId", turn_id as "turnId",
                     source_type as "sourceType", kind, payload,
                     read_at as "readAt", created_at as "createdAt"
                from user_notifications
               where owner_user_id = ${userId}
               order by created_at, id
               limit 1000`,
        ),
        db.execute(
          sql`select id, session_id as "sessionId",
                     original_name as "name", mime_type as "mimeType",
                     size_bytes as "sizeBytes", status,
                     created_at as "createdAt"
                from session_inputs
               where owner_user_id = ${userId}
               order by created_at, id
               limit 1000`,
        ),
        db.execute(
          sql`select id, session_id as "sessionId", name,
                     mime_type as "mimeType", size_bytes as "sizeBytes",
                     generated_at as "generatedAt", created_at as "createdAt"
                from artifacts
               where owner_user_id = ${userId}
                 and deletion_state = 'none'
               order by created_at, id
               limit 1000`,
        ),
        db.execute(
          sql`select state, revision, updated_at as "updatedAt"
                from user_memory_stores where user_id = ${userId} limit 1`,
        ),
        db.execute(
          sql`select id, title, kind, schedule, timezone,
                     next_run_at as "nextRunAt", enabled,
                     created_at as "createdAt", updated_at as "updatedAt"
                from automations where owner_user_id = ${userId}
               order by created_at, id
               limit 500`,
        ),
        db.execute(
          sql`select id, name, display_title as "displayTitle", description,
                     latest_version as "latestVersion", source,
                     file_name as "fileName", file_size as "fileSize",
                     status, created_at as "createdAt"
                from skills where owner_user_id = ${userId}
               order by created_at, id
               limit 500`,
        ),
      ]);
      return {
        user: users.rows[0] ?? null,
        agents: agents.rows,
        sessions: sessions.rows,
        runs: runs.rows,
        notifications: notifications.rows,
        inputs: inputs.rows,
        artifacts: artifacts.rows,
        memoryStore: memories.rows[0] ?? null,
        automations: automations.rows,
        skills: skills.rows,
      };
    },
  };
}

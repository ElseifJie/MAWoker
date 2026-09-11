import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";

type Row = Record<string, unknown>;

interface QueryResult<T extends Row> {
  rows: T[];
}

interface DatabaseClient {
  execute<T extends Row = Row>(query: SQL): PromiseLike<QueryResult<T>>;
  transaction<T>(
    callback: (transaction: DatabaseClient) => Promise<T>,
  ): Promise<T>;
}

interface OwnedRecord extends Row {
  id: string;
  ownerUserId: string;
}

interface DefaultAgentRecord extends Row {
  userId: string;
  platformAgentId: string;
  assignedBy: string;
  assignedAt: Date;
}

interface AdminUserRecord extends Row {
  id: string;
  email: string;
  role: "user" | "admin";
  status: "active" | "disabled";
  hasPassword: boolean;
  defaultAgentId: string | null;
  quota: {
    personalAgentLimit: number;
    concurrentSessionLimit: number;
    dailySessionLimit: number;
    monthlyTokenLimit: number;
  };
}

interface PlatformAgentRecord extends Row {
  id: string;
  arkAgentId: string;
  name: string;
  description: string;
  modelId: string;
  systemPrompt: string;
  arkVersion: string;
  status: "provisioning" | "active" | "disabled" | "failed" | "deleting";
  createdBy: string;
  updatedBy: string;
  lastErrorCode: string | null;
}

const platformAgentSelection = sql`
  id, ark_agent_id as "arkAgentId", name, description,
  model_id as "modelId", system_prompt as "systemPrompt",
  ark_version as "arkVersion", status,
  created_by as "createdBy", updated_by as "updatedBy",
  last_error_code as "lastErrorCode",
  created_at as "createdAt", updated_at as "updatedAt"`;

interface PersonalAgentRecord extends Row {
  id: string;
  ownerUserId: string;
  arkAgentId: string;
  name: string;
  description: string;
  modelId: string;
  systemPrompt: string;
  arkVersion: string;
  status: "provisioning" | "active" | "disabled" | "failed" | "deleting";
  lastErrorCode: string | null;
}

interface AvailableAgentRecord extends Row {
  id: string;
  arkAgentId: string;
  name: string;
  description: string;
  modelId: string;
  systemPrompt: string;
  arkVersion: string;
  status: PersonalAgentRecord["status"];
  kind: "platform" | "personal";
  editable: boolean;
}

interface SessionRecord extends Row {
  id: string;
  ownerUserId: string;
  arkSessionId: string;
  agentKind: "platform" | "personal";
  platformAgentId: string | null;
  personalAgentId: string | null;
  arkAgentId: string;
  agentName: string;
  agentVersion: string;
  environmentId: string;
  title: string;
  status: "idle" | "running" | "rescheduled" | "terminated";
  lastErrorCode: string | null;
  errorRecoverable: boolean | null;
  archivedAt: Date | null;
  deletionState: "none" | "pending" | "deletion_failed" | "deleted";
  lastEventAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface SessionInputRecord extends Row {
  id: string;
  ownerUserId: string;
  sessionId: string | null;
  arkFileId: string | null;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  mountPath: string;
  status: "uploading" | "uploaded" | "bound" | "failed" | "deleting";
  expiresAt: Date;
  lastErrorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface ArtifactRecord {
  id: string;
  ownerUserId: string;
  sessionId: string;
  arkFileId: string;
  tosObjectKey: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  generatedAt: Date;
  deletionState: "none" | "pending" | "deletion_failed" | "deleted";
  lastErrorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const sessionSelection = sql`
  id, owner_user_id as "ownerUserId",
  ark_session_id as "arkSessionId", agent_kind as "agentKind",
  platform_agent_id as "platformAgentId",
  personal_agent_id as "personalAgentId",
  ark_agent_id as "arkAgentId", agent_name as "agentName",
  agent_version as "agentVersion", environment_id as "environmentId",
  title, status, last_error_code as "lastErrorCode",
  error_recoverable as "errorRecoverable", archived_at as "archivedAt",
  deletion_state as "deletionState", last_event_at as "lastEventAt",
  created_at as "createdAt", updated_at as "updatedAt"`;

const sessionInputSelection = sql`
  id, owner_user_id as "ownerUserId", session_id as "sessionId",
  ark_file_id as "arkFileId", original_name as "originalName",
  mime_type as "mimeType", size_bytes as "sizeBytes",
  mount_path as "mountPath", status, expires_at as "expiresAt",
  last_error_code as "lastErrorCode",
  created_at as "createdAt", updated_at as "updatedAt"`;

const artifactSelection = sql`
  id, owner_user_id as "ownerUserId", session_id as "sessionId",
  ark_file_id as "arkFileId", tos_object_key as "tosObjectKey",
  name, mime_type as "mimeType", size_bytes as "sizeBytes",
  generated_at as "generatedAt", deletion_state as "deletionState",
  last_error_code as "lastErrorCode",
  created_at as "createdAt", updated_at as "updatedAt"`;

const personalAgentSelection = sql`
  id, owner_user_id as "ownerUserId", ark_agent_id as "arkAgentId",
  name, description, model_id as "modelId",
  system_prompt as "systemPrompt", ark_version as "arkVersion", status,
  last_error_code as "lastErrorCode",
  created_at as "createdAt", updated_at as "updatedAt"`;

interface EffectiveQuota extends Row {
  personalAgentLimit: number;
  concurrentSessionLimit: number;
  dailySessionLimit: number;
  monthlyTokenLimit: number;
}

type UsageMetricType =
  "input_tokens" | "output_tokens" | "runtime_ms" | "tool_calls";

interface JobRecord extends Row {
  id: string;
  ownerUserId: string | null;
  type:
    | "delete_session"
    | "delete_artifact"
    | "cleanup_artifact_object"
    | "cleanup_upload"
    | "reconcile_session"
    | "reconcile_personal_agent";
  status: "running";
  priority: number;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  runAfter: Date;
  lockedAt: Date;
  lockedBy: string;
  createdAt: Date;
}

interface QuotaInterruptJobRecord extends Row {
  id: string;
  userId: string;
  sessionId: string;
  arkSessionId: string;
  monthStart: Date;
  attempts: number;
  maxAttempts: number;
}

const JOB_LEASE_DURATION_MS = 5 * 60 * 1_000;
const ARTIFACT_DELETION_ERROR_CODES = new Set([
  "ARTIFACT_DELETE_FAILED",
  "ARTIFACT_DELETE_INVALID_JOB",
  "ARTIFACT_DELETE_LEASE_EXPIRED",
  "STORAGE_UNAVAILABLE",
]);
const ARTIFACT_CLEANUP_ERROR_CODES = new Set([
  "ARTIFACT_CLEANUP_FAILED",
  "ARTIFACT_CLEANUP_INVALID_JOB",
  "ARTIFACT_CLEANUP_LEASE_EXPIRED",
  "STORAGE_UNAVAILABLE",
]);
const SESSION_DELETION_ERROR_CODES = new Set([
  "SESSION_DELETE_FAILED",
  "SESSION_DELETE_INVALID_JOB",
  "SESSION_DELETE_LEASE_EXPIRED",
  "SESSION_DELETE_WAITING",
]);

function artifactDeletionErrorCode(error: string): string {
  return ARTIFACT_DELETION_ERROR_CODES.has(error)
    ? error
    : "ARTIFACT_DELETE_FAILED";
}

function artifactCleanupErrorCode(error: string): string {
  return ARTIFACT_CLEANUP_ERROR_CODES.has(error)
    ? error
    : "ARTIFACT_CLEANUP_FAILED";
}

function sessionDeletionErrorCode(error: string): string {
  return SESSION_DELETION_ERROR_CODES.has(error)
    ? error
    : "SESSION_DELETE_FAILED";
}

export class QuotaExceededError extends Error {
  constructor(
    public readonly dimension:
      "concurrent_sessions" | "daily_sessions" | "monthly_tokens",
  ) {
    super(`Quota exceeded: ${dimension}`);
    this.name = "QuotaExceededError";
  }
}

// Drizzle hands back raw driver values from execute(): timestamptz arrives as
// driver text ("2026-09-11 15:56:49.05906+08") while the query builder returns
// Dates. Revive the aliased timestamp columns here so every repository method
// returns the Date its type declares.
const timestampFields = new Set([
  "archivedAt",
  "assignedAt",
  "createdAt",
  "expiresAt",
  "generatedAt",
  "lastEventAt",
  "lastObservedAt",
  "lockedAt",
  "monthStart",
  "runAfter",
  "runningSince",
  "updatedAt",
]);

function reviveTimestamps<T extends Row>(row: T): T {
  for (const [key, value] of Object.entries(row)) {
    if (typeof value !== "string" || !timestampFields.has(key)) continue;
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) row[key as keyof T] = parsed as never;
  }
  return row;
}

async function rows<T extends Row>(
  database: DatabaseClient,
  query: SQL,
): Promise<T[]> {
  const result = await database.execute<T>(query);
  return result.rows.map((row) => reviveTimestamps(row));
}

async function first<T extends Row>(
  database: DatabaseClient,
  query: SQL,
): Promise<T | undefined> {
  return (await rows<T>(database, query))[0];
}

async function requiredFirst<T extends Row>(
  database: DatabaseClient,
  query: SQL,
): Promise<T> {
  const result = await first<T>(database, query);
  if (!result) throw new Error("Expected repository mutation to return a row");
  return result;
}

function tenantRepository(database: DatabaseClient, tableName: SQL) {
  return {
    findOwned(ownerUserId: string, id: string) {
      return first<OwnedRecord>(
        database,
        sql`select id, owner_user_id as "ownerUserId"
              from ${tableName}
             where id = ${id} and owner_user_id = ${ownerUserId}
             limit 1`,
      );
    },
  };
}

async function effectiveQuota(
  database: DatabaseClient,
  userId: string,
): Promise<EffectiveQuota> {
  const quota = await first<EffectiveQuota>(
    database,
    sql`select
          coalesce(o.personal_agent_limit, p.personal_agent_limit)::integer
            as "personalAgentLimit",
          coalesce(o.concurrent_session_limit, p.concurrent_session_limit)::integer
            as "concurrentSessionLimit",
          coalesce(o.daily_session_limit, p.daily_session_limit)::integer
            as "dailySessionLimit",
          coalesce(o.monthly_token_limit, p.monthly_token_limit)::bigint
            as "monthlyTokenLimit"
        from quota_policies p
        left join user_quota_overrides o on o.user_id = ${userId}
        where p.key = 'default'`,
  );

  if (!quota) {
    throw new Error("Default quota policy is not configured");
  }
  return {
    personalAgentLimit: Number(quota.personalAgentLimit),
    concurrentSessionLimit: Number(quota.concurrentSessionLimit),
    dailySessionLimit: Number(quota.dailySessionLimit),
    monthlyTokenLimit: Number(quota.monthlyTokenLimit),
  };
}

function utcMonthWindow(now: Date): { start: Date; end: Date } {
  return {
    start: new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
    ),
    end: new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0),
    ),
  };
}

async function enqueueQuotaInterrupts(
  database: DatabaseClient,
  userId: string,
  monthStart: Date,
  now: Date,
): Promise<void> {
  const active = await rows<{ sessionId: string }>(
    database,
    sql`select id as "sessionId"
          from sessions
         where owner_user_id = ${userId}
           and status in ('running', 'rescheduled')
           and deletion_state = 'none'
         for update`,
  );
  for (const session of active) {
    await database.execute(
      sql`insert into quota_interrupt_jobs
            (id, user_id, session_id, month_start, status, attempts, run_after)
          values
            (${randomUUID()}, ${userId}, ${session.sessionId}, ${monthStart},
             'pending', 0, ${now})
          on conflict (user_id, session_id, month_start) do nothing`,
    );
  }
}

async function enqueuePersonalAgentReconciliation(
  database: DatabaseClient,
  input: {
    id: string;
    ownerUserId: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await database.execute(
    sql`insert into background_jobs
          (id, owner_user_id, type, status, priority, payload, attempts,
           run_after, locked_at, locked_by, last_error)
        values
          (${input.id}, ${input.ownerUserId}, 'reconcile_personal_agent',
           'pending', 100, ${JSON.stringify(input.payload)}::jsonb, 0,
           now() + interval '30 seconds',
           null, null, null)
        on conflict (id) do update
          set owner_user_id = excluded.owner_user_id,
              type = excluded.type,
              status = 'pending',
              priority = excluded.priority,
              payload = excluded.payload,
              attempts = 0,
              run_after = now() + interval '30 seconds',
              locked_at = null,
              locked_by = null,
              last_error = null,
              updated_at = now()`,
  );
}

export function createRepositories(database: unknown) {
  const db = database as DatabaseClient;

  return {
    users: {
      findById(id: string) {
        return first(
          db,
          sql`select id, auth_subject as "authSubject", email, role, status,
                     created_at as "createdAt", updated_at as "updatedAt"
                from users where id = ${id} limit 1`,
        );
      },
      findByAuthSubject(authSubject: string) {
        return first(
          db,
          sql`select id, auth_subject as "authSubject", email, role, status,
                     created_at as "createdAt", updated_at as "updatedAt"
                from users where auth_subject = ${authSubject} limit 1`,
        );
      },
    },

    authSessions: {
      findActiveByTokenHash(tokenHash: string, now = new Date()) {
        return first(
          db,
          sql`select id, user_id as "userId", token_hash as "tokenHash",
                     expires_at as "expiresAt", created_at as "createdAt"
                from auth_sessions
               where token_hash = ${tokenHash}
                 and revoked_at is null
                 and expires_at > ${now}
               limit 1`,
        );
      },
    },

    platformAgents: {
      findById(id: string) {
        return first<PlatformAgentRecord>(
          db,
          sql`select ${platformAgentSelection}
                from platform_agents where id = ${id} limit 1`,
        );
      },
      findAssignedToUser(userId: string, platformAgentId: string) {
        return first(
          db,
          sql`select pa.*
                from platform_agents pa
                join user_default_agents uda
                  on uda.platform_agent_id = pa.id
               where uda.user_id = ${userId}
                 and pa.id = ${platformAgentId}
                 and pa.status = 'active'
               limit 1`,
        );
      },
      list() {
        return rows<PlatformAgentRecord>(
          db,
          sql`select ${platformAgentSelection}
                from platform_agents
               order by created_at asc, id asc`,
        );
      },
      createProvisioning(input: {
        id: string;
        name: string;
        description: string;
        modelId: string;
        systemPrompt: string;
        createdBy: string;
        updatedBy: string;
      }) {
        return first<PlatformAgentRecord>(
          db,
          sql`insert into platform_agents
                (id, ark_agent_id, name, description, model_id, system_prompt,
                 ark_version, status, created_by, updated_by)
              values
                (${input.id}, ${`pending:${input.id}`}, ${input.name},
                 ${input.description}, ${input.modelId}, ${input.systemPrompt},
                 '0', 'provisioning', ${input.createdBy}, ${input.updatedBy})
              returning ${platformAgentSelection}`,
        );
      },
      markProvisioned(
        id: string,
        upstream: { arkAgentId: string; arkVersion: string },
      ) {
        return first<PlatformAgentRecord>(
          db,
          sql`update platform_agents
                set ark_agent_id = ${upstream.arkAgentId},
                    ark_version = ${upstream.arkVersion},
                    status = 'active',
                    last_error_code = null,
                    updated_at = now()
              where id = ${id}
              returning ${platformAgentSelection}`,
        );
      },
      markFailure(
        id: string,
        status: "provisioning" | "failed" | "deleting",
        errorCode: string,
      ) {
        return first<PlatformAgentRecord>(
          db,
          sql`update platform_agents
                set status = ${status},
                    last_error_code = ${errorCode},
                    updated_at = now()
              where id = ${id}
              returning ${platformAgentSelection}`,
        );
      },
      update(
        id: string,
        input: {
          name?: string;
          description?: string;
          modelId?: string;
          systemPrompt?: string;
          arkVersion?: string;
          status?: string;
          updatedBy?: string;
          lastErrorCode?: string | null;
        },
      ) {
        return first<PlatformAgentRecord>(
          db,
          sql`update platform_agents
                set name = coalesce(${input.name ?? null}, name),
                    description = coalesce(${input.description ?? null}, description),
                    model_id = coalesce(${input.modelId ?? null}, model_id),
                    system_prompt = coalesce(${input.systemPrompt ?? null}, system_prompt),
                    ark_version = coalesce(${input.arkVersion ?? null}, ark_version),
                    status = coalesce(${input.status ?? null}, status::text)::agent_status,
                    updated_by = coalesce(${input.updatedBy ?? null}, updated_by),
                    last_error_code = case
                      when ${input.lastErrorCode === null} then null
                      else coalesce(${input.lastErrorCode ?? null}, last_error_code)
                    end,
                    updated_at = now()
              where id = ${id}
              returning ${platformAgentSelection}`,
        );
      },
      beginDelete(id: string, updatedBy: string) {
        return db.transaction(async (transaction) => {
          const current = await first<PlatformAgentRecord>(
            transaction,
            sql`select ${platformAgentSelection}
                  from platform_agents
                 where id = ${id}
                 for update`,
          );
          if (!current) return undefined;

          const references = (await first<{
            assignments: number;
            sessions: number;
          }>(
            transaction,
            sql`select
                    (select count(*)::integer from user_default_agents
                      where platform_agent_id = ${id}) as assignments,
                    (select count(*)::integer from sessions
                      where platform_agent_id = ${id}) as sessions`,
          )) ?? { assignments: 0, sessions: 0 };
          if (references.assignments > 0 || references.sessions > 0) {
            return {
              agent: current,
              previousStatus: current.status,
              references,
            };
          }

          const agent = await first<PlatformAgentRecord>(
            transaction,
            sql`update platform_agents
                  set status = 'deleting',
                      updated_by = ${updatedBy},
                      updated_at = now()
                where id = ${id}
                returning ${platformAgentSelection}`,
          );
          if (!agent) return undefined;
          return {
            agent,
            previousStatus: current.status,
            references,
          };
        });
      },
      async remove(id: string) {
        await db.execute(sql`delete from platform_agents where id = ${id}`);
      },
      assignDefault(input: {
        userId: string;
        platformAgentId: string;
        assignedBy: string;
      }) {
        return db.transaction(async (transaction) => {
          const eligible = await first(
            transaction,
            sql`select pa.id
                  from platform_agents pa
                  join users target on target.id = ${input.userId}
                  join users administrator on administrator.id = ${input.assignedBy}
                 where pa.id = ${input.platformAgentId}
                   and pa.status = 'active'
                   and target.role = 'user'
                   and target.status = 'active'
                   and administrator.role = 'admin'
                   and administrator.status = 'active'
                 for update of pa, target`,
          );
          if (!eligible) return undefined;
          return first<DefaultAgentRecord>(
            transaction,
            sql`insert into user_default_agents
                  (user_id, platform_agent_id, assigned_by)
                values
                  (${input.userId}, ${input.platformAgentId}, ${input.assignedBy})
                on conflict (user_id) do update
                  set platform_agent_id = excluded.platform_agent_id,
                      assigned_by = excluded.assigned_by,
                      assigned_at = now()
                returning user_id as "userId",
                          platform_agent_id as "platformAgentId",
                          assigned_by as "assignedBy",
                          assigned_at as "assignedAt"`,
          );
        });
      },
      listUsers() {
        return rows<AdminUserRecord>(
          db,
          sql`select u.id, u.email, u.role, u.status,
                     (u.password_hash is not null) as "hasPassword",
                     uda.platform_agent_id as "defaultAgentId",
                     jsonb_build_object(
                       'personalAgentLimit',
                         coalesce(
                           override.personal_agent_limit,
                           policy.personal_agent_limit
                         ),
                       'concurrentSessionLimit',
                         coalesce(
                           override.concurrent_session_limit,
                           policy.concurrent_session_limit
                         ),
                       'dailySessionLimit',
                         coalesce(
                           override.daily_session_limit,
                           policy.daily_session_limit
                         ),
                       'monthlyTokenLimit',
                         coalesce(
                           override.monthly_token_limit,
                           policy.monthly_token_limit
                         )
                     ) as quota
                from users u
                join quota_policies policy on policy.key = 'default'
                left join user_default_agents uda on uda.user_id = u.id
                left join user_quota_overrides override
                  on override.user_id = u.id
               order by u.created_at asc, u.id asc`,
        );
      },
      createUser(input: {
        id: string;
        authSubject: string;
        email: string;
        passwordHash: string;
        role: "user" | "admin";
        createdBy: string;
      }) {
        return db.transaction(async (transaction) => {
          const administrator = await first<{ id: string }>(
            transaction,
            sql`select id
                  from users
                 where id = ${input.createdBy}
                   and role = 'admin'
                   and status = 'active'
                 for update`,
          );
          if (!administrator) return undefined;
          const created = await first<{ id: string }>(
            transaction,
            sql`insert into users
                  (id, auth_subject, email, password_hash, role)
                values
                  (${input.id}, ${input.authSubject}, ${input.email},
                   ${input.passwordHash}, ${input.role})
                on conflict (email) do nothing
                returning id`,
          );
          return created ? { id: created.id } : undefined;
        });
      },
      resetUserPassword(input: {
        userId: string;
        passwordHash: string;
        updatedBy: string;
      }) {
        return db.transaction(async (transaction) => {
          const eligible = await first<{ id: string }>(
            transaction,
            sql`select target.id
                  from users target
                  join users administrator on administrator.id = ${input.updatedBy}
                 where target.id = ${input.userId}
                   and administrator.role = 'admin'
                   and administrator.status = 'active'
                 for update of target`,
          );
          if (!eligible) return false;
          await transaction.execute(
            sql`update users
                   set password_hash = ${input.passwordHash},
                       updated_at = now()
                 where id = ${input.userId}`,
          );
          await transaction.execute(
            sql`update auth_sessions
                   set revoked_at = now()
                 where user_id = ${input.userId}
                   and revoked_at is null`,
          );
          return true;
        });
      },
      updateUserQuota(input: {
        userId: string;
        personalAgentLimit: number;
        concurrentSessionLimit: number;
        dailySessionLimit: number;
        monthlyTokenLimit: number;
        updatedBy: string;
      }) {
        return db.transaction(async (transaction) => {
          const eligible = await first(
            transaction,
            sql`select target.id
                  from users target
                  join users administrator on administrator.id = ${input.updatedBy}
                 where target.id = ${input.userId}
                   and target.role = 'user'
                   and administrator.role = 'admin'
                   and administrator.status = 'active'
                 for update of target`,
          );
          if (!eligible) return undefined;
          const updated = await first<{
            userId: string;
            personalAgentLimit: number;
            concurrentSessionLimit: number;
            dailySessionLimit: number;
            monthlyTokenLimit: number;
          }>(
            transaction,
            sql`insert into user_quota_overrides
                  (user_id, personal_agent_limit, concurrent_session_limit,
                   daily_session_limit, monthly_token_limit, updated_by)
                values
                  (${input.userId}, ${input.personalAgentLimit},
                   ${input.concurrentSessionLimit}, ${input.dailySessionLimit},
                   ${input.monthlyTokenLimit}, ${input.updatedBy})
                on conflict (user_id) do update
                  set personal_agent_limit = excluded.personal_agent_limit,
                      concurrent_session_limit = excluded.concurrent_session_limit,
                      daily_session_limit = excluded.daily_session_limit,
                      monthly_token_limit = excluded.monthly_token_limit,
                      updated_by = excluded.updated_by,
                      updated_at = now()
                returning user_id as "userId",
                          personal_agent_limit as "personalAgentLimit",
                          concurrent_session_limit as "concurrentSessionLimit",
                          daily_session_limit as "dailySessionLimit",
                          monthly_token_limit::bigint as "monthlyTokenLimit"`,
          );
          if (!updated) return undefined;
          const now = new Date();
          const window = utcMonthWindow(now);
          const usage = await first<{ total: number }>(
            transaction,
            sql`select coalesce(sum(quantity), 0)::bigint as total
                  from usage_ledger
                 where user_id = ${input.userId}
                   and metric_type in ('input_tokens', 'output_tokens')
                   and recorded_at >= ${window.start}
                   and recorded_at < ${window.end}`,
          );
          if (Number(usage?.total ?? 0) >= input.monthlyTokenLimit) {
            await enqueueQuotaInterrupts(
              transaction,
              input.userId,
              window.start,
              now,
            );
          }
          return updated;
        });
      },
      async audit(input: {
        actorUserId: string;
        ownerUserId?: string;
        action: string;
        resourceType: string;
        resourceId?: string;
        result: "succeeded" | "failed";
        requestId: string;
        arkRequestId?: string;
        errorCode?: string;
        metadata?: Record<string, unknown>;
      }) {
        await db.execute(
          sql`insert into audit_logs
                (id, actor_user_id, owner_user_id, action, resource_type,
                 resource_id, result, request_id, ark_request_id, error_code,
                 metadata)
              values
                (${randomUUID()}, ${input.actorUserId},
                 ${input.ownerUserId ?? null}, ${input.action},
                 ${input.resourceType}, ${input.resourceId ?? null},
                 ${input.result}, ${input.requestId},
                 ${input.arkRequestId ?? null}, ${input.errorCode ?? null},
                 ${input.metadata ? JSON.stringify(input.metadata) : null}::jsonb)`,
        );
      },
    },

    personalAgents: tenantRepository(db, sql.raw("personal_agents")),
    userAgents: {
      listAvailable(userId: string) {
        return rows<AvailableAgentRecord>(
          db,
          sql`select *
                from (
                  select pa.id, pa.ark_agent_id as "arkAgentId", pa.name,
                         pa.description, pa.model_id as "modelId",
                         pa.system_prompt as "systemPrompt",
                         pa.ark_version as "arkVersion", pa.status,
                         'platform'::text as kind, false as editable,
                         pa.created_at as "createdAt"
                    from platform_agents pa
                    join user_default_agents uda
                      on uda.platform_agent_id = pa.id
                   where uda.user_id = ${userId}
                     and pa.status = 'active'
                  union all
                  select ua.id, ua.ark_agent_id as "arkAgentId", ua.name,
                         ua.description, ua.model_id as "modelId",
                         ua.system_prompt as "systemPrompt",
                         ua.ark_version as "arkVersion", ua.status,
                         'personal'::text as kind, true as editable,
                         ua.created_at as "createdAt"
                    from personal_agents ua
                   where ua.owner_user_id = ${userId}
                ) available
               order by case when kind = 'platform' then 0 else 1 end,
                        "createdAt" asc, id asc`,
        );
      },
      async findRecentAvailable(userId: string) {
        const recent = await first<{ agentId: string }>(
          db,
          sql`select case
                       when s.agent_kind = 'platform' then s.platform_agent_id
                       else s.personal_agent_id
                     end as "agentId"
                from sessions s
                left join platform_agents pa
                  on pa.id = s.platform_agent_id
                left join user_default_agents uda
                  on uda.user_id = s.owner_user_id
                 and uda.platform_agent_id = s.platform_agent_id
                left join personal_agents ua
                  on ua.id = s.personal_agent_id
                 and ua.owner_user_id = s.owner_user_id
               where s.owner_user_id = ${userId}
                 and (
                   (s.agent_kind = 'platform'
                    and pa.status = 'active'
                    and uda.user_id is not null)
                   or
                   (s.agent_kind = 'personal' and ua.status = 'active')
                 )
               order by s.created_at desc, s.id desc
               limit 1`,
        );
        return recent?.agentId;
      },
      async findDefaultActive(userId: string) {
        const assignment = await first<{ agentId: string }>(
          db,
          sql`select pa.id as "agentId"
                from user_default_agents uda
                join platform_agents pa on pa.id = uda.platform_agent_id
               where uda.user_id = ${userId}
                 and pa.status = 'active'
               limit 1`,
        );
        return assignment?.agentId;
      },
      findAvailableById(userId: string, id: string) {
        return first<AvailableAgentRecord>(
          db,
          sql`select *
                from (
                  select pa.id, pa.ark_agent_id as "arkAgentId", pa.name,
                         pa.description, pa.model_id as "modelId",
                         pa.system_prompt as "systemPrompt",
                         pa.ark_version as "arkVersion", pa.status,
                         'platform'::text as kind, false as editable
                    from platform_agents pa
                    join user_default_agents uda
                      on uda.platform_agent_id = pa.id
                   where uda.user_id = ${userId}
                     and pa.id = ${id}
                     and pa.status = 'active'
                  union all
                  select ua.id, ua.ark_agent_id as "arkAgentId", ua.name,
                         ua.description, ua.model_id as "modelId",
                         ua.system_prompt as "systemPrompt",
                         ua.ark_version as "arkVersion", ua.status,
                         'personal'::text as kind, true as editable
                    from personal_agents ua
                   where ua.owner_user_id = ${userId}
                     and ua.id = ${id}
                     and ua.status = 'active'
                ) available
               limit 1`,
        );
      },
      createProvisioning(input: {
        id: string;
        ownerUserId: string;
        name: string;
        description: string;
        modelId: string;
        systemPrompt: string;
      }) {
        return db.transaction(async (transaction) => {
          const user = await first(
            transaction,
            sql`select id from users
                 where id = ${input.ownerUserId}
                   and role = 'user'
                   and status = 'active'
                 for update`,
          );
          if (!user) return undefined;
          const quota = await effectiveQuota(transaction, input.ownerUserId);
          const usage = await first<{ count: number }>(
            transaction,
            sql`select count(*)::integer as count
                  from personal_agents
                 where owner_user_id = ${input.ownerUserId}
                   and not (
                     status = 'failed'
                     and ark_version = '0'
                     and ark_agent_id like 'pending:%'
                   )`,
          );
          if ((usage?.count ?? 0) >= quota.personalAgentLimit) return undefined;
          const created = await requiredFirst<PersonalAgentRecord>(
            transaction,
            sql`insert into personal_agents
                  (id, owner_user_id, ark_agent_id, name, description, model_id,
                   system_prompt, ark_version, status)
                values
                  (${input.id}, ${input.ownerUserId}, ${`pending:${input.id}`},
                   ${input.name}, ${input.description}, ${input.modelId},
                   ${input.systemPrompt}, '0', 'provisioning')
                returning ${personalAgentSelection}`,
          );
          await enqueuePersonalAgentReconciliation(transaction, {
            id: input.id,
            ownerUserId: input.ownerUserId,
            payload: {
              operation: "create",
              personalAgentId: input.id,
            },
          });
          return created;
        });
      },
      findOwned(userId: string, id: string) {
        return first<PersonalAgentRecord>(
          db,
          sql`select ${personalAgentSelection}
                from personal_agents
               where id = ${id} and owner_user_id = ${userId}
               limit 1`,
        );
      },
      markProvisioned(
        id: string,
        userId: string,
        upstream: { arkAgentId: string; arkVersion: string },
      ) {
        return db.transaction(async (transaction) => {
          const job = await requiredFirst<{ status: string }>(
            transaction,
            sql`select status
                  from background_jobs
                 where id = ${id}
                   and owner_user_id = ${userId}
                   and type = 'reconcile_personal_agent'
                 for update`,
          );
          if (job.status === "failed") {
            throw new Error("Personal Agent create reconciliation is terminal");
          }
          const agent = await requiredFirst<PersonalAgentRecord>(
            transaction,
            sql`update personal_agents
                  set ark_agent_id = ${upstream.arkAgentId},
                      ark_version = ${upstream.arkVersion},
                      status = 'active',
                      last_error_code = null,
                      updated_at = now()
                where id = ${id} and owner_user_id = ${userId}
                returning ${personalAgentSelection}`,
          );
          await transaction.execute(
            sql`update background_jobs
                  set status = 'succeeded',
                      locked_at = null,
                      locked_by = null,
                      last_error = null,
                      updated_at = now()
                where id = ${id} and owner_user_id = ${userId}`,
          );
          return agent;
        });
      },
      markFailure(
        id: string,
        userId: string,
        status: "provisioning" | "failed" | "deleting",
        errorCode: string,
      ) {
        return requiredFirst<PersonalAgentRecord>(
          db,
          sql`update personal_agents
                set status = ${status},
                    last_error_code = ${errorCode},
                    updated_at = now()
              where id = ${id} and owner_user_id = ${userId}
              returning ${personalAgentSelection}`,
        );
      },
      markDefinitiveCreateFailure(
        id: string,
        userId: string,
        errorCode: string,
      ) {
        return db.transaction(async (transaction) => {
          const job = await requiredFirst<{ status: string }>(
            transaction,
            sql`select status
                  from background_jobs
                 where id = ${id}
                   and owner_user_id = ${userId}
                   and type = 'reconcile_personal_agent'
                 for update`,
          );
          if (job.status === "succeeded") {
            return requiredFirst<PersonalAgentRecord>(
              transaction,
              sql`select ${personalAgentSelection}
                    from personal_agents
                   where id = ${id} and owner_user_id = ${userId}`,
            );
          }
          const agent = await requiredFirst<PersonalAgentRecord>(
            transaction,
            sql`update personal_agents
                  set status = 'failed',
                      last_error_code = ${errorCode},
                      updated_at = now()
                where id = ${id} and owner_user_id = ${userId}
                returning ${personalAgentSelection}`,
          );
          await transaction.execute(
            sql`update background_jobs
                  set status = 'failed',
                      locked_at = null,
                      locked_by = null,
                      last_error = ${errorCode},
                      updated_at = now()
                where id = ${id}
                  and owner_user_id = ${userId}
                  and type = 'reconcile_personal_agent'`,
          );
          return agent;
        });
      },
      markCreatePersistenceFailure(
        id: string,
        userId: string,
        upstream: { arkAgentId: string; arkVersion: string },
      ) {
        return requiredFirst<PersonalAgentRecord>(
          db,
          sql`update personal_agents
                set ark_agent_id = ${upstream.arkAgentId},
                    ark_version = ${upstream.arkVersion},
                    status = 'failed',
                    last_error_code = 'DB_PERSISTENCE_FAILED',
                    updated_at = now()
              where id = ${id} and owner_user_id = ${userId}
              returning ${personalAgentSelection}`,
        );
      },
      markUpdatePersistenceFailure(
        id: string,
        userId: string,
        upstreamVersion: string,
      ) {
        return requiredFirst<PersonalAgentRecord>(
          db,
          sql`update personal_agents
                set ark_version = ${upstreamVersion},
                    status = 'failed',
                    last_error_code = 'DB_PERSISTENCE_FAILED',
                    updated_at = now()
              where id = ${id} and owner_user_id = ${userId}
              returning ${personalAgentSelection}`,
        );
      },
      async saveUpdateIntent(
        id: string,
        userId: string,
        configuration: {
          name: string;
          description: string;
          modelId: string;
          systemPrompt: string;
        },
        arkVersion: string,
      ) {
        await enqueuePersonalAgentReconciliation(db, {
          id,
          ownerUserId: userId,
          payload: {
            operation: "update",
            personalAgentId: id,
            configuration,
            arkVersion,
          },
        });
      },
      update(
        id: string,
        userId: string,
        input: {
          name?: string;
          description?: string;
          modelId?: string;
          systemPrompt?: string;
          arkVersion?: string;
          status?: string;
          lastErrorCode?: string | null;
        },
      ) {
        return requiredFirst<PersonalAgentRecord>(
          db,
          sql`update personal_agents
                set name = coalesce(${input.name ?? null}, name),
                    description = coalesce(${input.description ?? null}, description),
                    model_id = coalesce(${input.modelId ?? null}, model_id),
                    system_prompt = coalesce(${input.systemPrompt ?? null}, system_prompt),
                    ark_version = coalesce(${input.arkVersion ?? null}, ark_version),
                    status = coalesce(${input.status ?? null}, status::text)::agent_status,
                    last_error_code = case
                      when ${input.lastErrorCode === null} then null
                      else coalesce(${input.lastErrorCode ?? null}, last_error_code)
                    end,
                    updated_at = now()
              where id = ${id} and owner_user_id = ${userId}
              returning ${personalAgentSelection}`,
        );
      },
      beginDelete(id: string, userId: string, enqueueReconciliation = true) {
        return db.transaction(async (transaction) => {
          const current = await first<PersonalAgentRecord>(
            transaction,
            sql`select ${personalAgentSelection}
                  from personal_agents
                 where id = ${id} and owner_user_id = ${userId}
                 for update`,
          );
          if (!current) return undefined;
          const createJob = await first<{
            status: string;
            payload: Record<string, unknown>;
          }>(
            transaction,
            sql`select status, payload
                  from background_jobs
                 where id = ${id}
                   and owner_user_id = ${userId}
                   and type = 'reconcile_personal_agent'
                 limit 1`,
          );
          const createJobPending =
            createJob?.payload.operation === "create" &&
            (createJob.status === "pending" || createJob.status === "running");
          const pendingIdentity =
            current.arkAgentId.startsWith("pending:") &&
            current.status !== "failed";
          if (
            current.status === "provisioning" ||
            pendingIdentity ||
            createJobPending
          ) {
            return {
              agent: current,
              conflict: "create_reconciliation_pending" as const,
            };
          }
          const references = (await first<{ sessions: number }>(
            transaction,
            sql`select count(*)::integer as sessions
                  from sessions
                 where owner_user_id = ${userId}
                   and personal_agent_id = ${id}`,
          )) ?? { sessions: 0 };
          if (references.sessions > 0) {
            return {
              agent: current,
              previousStatus: current.status,
              references,
            };
          }
          const agent = await requiredFirst<PersonalAgentRecord>(
            transaction,
            sql`update personal_agents
                  set status = 'deleting', updated_at = now()
                where id = ${id} and owner_user_id = ${userId}
                returning ${personalAgentSelection}`,
          );
          if (enqueueReconciliation) {
            await enqueuePersonalAgentReconciliation(transaction, {
              id,
              ownerUserId: userId,
              payload: {
                operation: "delete",
                personalAgentId: id,
              },
            });
          }
          return {
            agent,
            previousStatus: current.status,
            references,
          };
        });
      },
      async remove(id: string, userId: string) {
        await db.transaction(async (transaction) => {
          await transaction.execute(
            sql`delete from background_jobs
                 where id = ${id} and owner_user_id = ${userId}
                   and type = 'reconcile_personal_agent'`,
          );
          await transaction.execute(
            sql`delete from personal_agents
                 where id = ${id} and owner_user_id = ${userId}`,
          );
        });
      },
      async audit(input: {
        actorUserId: string;
        ownerUserId: string;
        action: string;
        resourceType: "personal_agent";
        resourceId: string;
        result: "succeeded" | "failed";
        requestId: string;
        arkRequestId?: string;
        errorCode?: string;
      }) {
        await db.execute(
          sql`insert into audit_logs
                (id, actor_user_id, owner_user_id, action, resource_type,
                 resource_id, result, request_id, ark_request_id, error_code)
              values
                (${randomUUID()}, ${input.actorUserId}, ${input.ownerUserId},
                 ${input.action}, ${input.resourceType}, ${input.resourceId},
                 ${input.result}, ${input.requestId},
                 ${input.arkRequestId ?? null}, ${input.errorCode ?? null})`,
        );
      },
    },
    sessionDeletion: {
      findDeleting(userId: string, id: string) {
        return first<{
          id: string;
          ownerUserId: string;
          arkSessionId: string;
          status: SessionRecord["status"];
        }>(
          db,
          sql`select id, owner_user_id as "ownerUserId",
                     ark_session_id as "arkSessionId", status
                from sessions
               where id = ${id}
                 and owner_user_id = ${userId}
                 and deletion_state in ('pending', 'deletion_failed')
               limit 1`,
        );
      },
      listArtifactObjectKeys(userId: string, id: string) {
        return rows<{ objectKey: string }>(
          db,
          sql`select distinct source.object_key as "objectKey"
                from (
                  select artifact.tos_object_key as object_key
                    from artifacts artifact
                   where artifact.session_id = ${id}
                     and artifact.owner_user_id = ${userId}
                  union all
                  select job.payload ->> 'objectKey' as object_key
                    from background_jobs job
                   where job.owner_user_id = ${userId}
                     and job.type = 'cleanup_artifact_object'
                     and job.payload ->> 'objectKey' like ${`tenants/${userId}/sessions/${id}/artifacts/%`}
                ) source
               where exists (
                 select 1
                   from sessions session
                  where session.id = ${id}
                    and session.owner_user_id = ${userId}
                    and session.deletion_state in (
                      'pending',
                      'deletion_failed'
                    )
               )
               order by source.object_key`,
        ).then((records) => records.map(({ objectKey }) => objectKey));
      },
      async removeLocal(userId: string, id: string) {
        return db.transaction(async (transaction) => {
          const session = await first(
            transaction,
            sql`select id
                  from sessions
                 where id = ${id}
                   and owner_user_id = ${userId}
                   and deletion_state in ('pending', 'deletion_failed')
                 for update`,
          );
          if (!session) return "missing" as const;
          const cleanup = await first<{
            pending: boolean;
            failed: boolean;
          }>(
            transaction,
            sql`select
                  coalesce(
                    bool_or(status in ('pending', 'running')),
                    false
                  ) as pending,
                  coalesce(bool_or(status = 'failed'), false) as failed
                from background_jobs
               where owner_user_id = ${userId}
                 and type = 'cleanup_artifact_object'
                 and payload ->> 'objectKey' like ${`tenants/${userId}/sessions/${id}/artifacts/%`}`,
          );
          if (cleanup?.failed) return "cleanup_failed" as const;
          if (cleanup?.pending) return "cleanup_pending" as const;
          await transaction.execute(
            sql`delete from quota_reservations
                 where id = ${id} and user_id = ${userId}`,
          );
          await transaction.execute(
            sql`delete from sessions
                 where id = ${id} and owner_user_id = ${userId}`,
          );
          return "removed" as const;
        });
      },
    },
    sessions: tenantRepository(db, sql.raw("sessions")),
    sessionLifecycle: {
      prepareCreate(input: SessionRecord, uploadIds: string[] = []) {
        return db.transaction(async (transaction) => {
          const user = await first(
            transaction,
            sql`select id from users
                 where id = ${input.ownerUserId}
                   and role = 'user'
                   and status = 'active'
                 for update`,
          );
          if (!user) throw new Error("Active user not found");

          const selectedUploadIds = [...new Set(uploadIds)];
          let selectedInputs: SessionInputRecord[] = [];
          if (selectedUploadIds.length > 0) {
            const uploadIdList = sql.join(
              selectedUploadIds.map((uploadId) => sql`${uploadId}`),
              sql`, `,
            );
            selectedInputs = await rows<SessionInputRecord>(
              transaction,
              sql`select ${sessionInputSelection}
                    from session_inputs
                   where owner_user_id = ${input.ownerUserId}
                     and id in (${uploadIdList})
                     and session_id is null
                     and status = 'uploaded'
                     and expires_at > ${input.createdAt}
                   for update`,
            );
            if (selectedInputs.length !== selectedUploadIds.length) {
              const error = new Error("Resource not found");
              error.name = "ResourceNotFoundError";
              throw error;
            }
          }

          const quota = await effectiveQuota(transaction, input.ownerUserId);
          const month = utcMonthWindow(input.createdAt);
          const counters = await first<{
            dailyCreateIntents: number;
            monthlyTokens: number;
          }>(
            transaction,
            sql`select
                  (select count(*)::integer
                     from (
                       select id
                         from sessions
                        where owner_user_id = ${input.ownerUserId}
                          and created_at >= date_trunc(
                            'day',
                            ${input.createdAt}::timestamptz
                          )
                       union
                       select id
                         from quota_reservations
                        where user_id = ${input.ownerUserId}
                          and status = 'active'
                          and expires_at > ${input.createdAt}
                          and created_at >= date_trunc(
                            'day',
                            ${input.createdAt}::timestamptz
                          )
                     ) as create_intents)
                    as "dailyCreateIntents",
                  (select coalesce(sum(quantity), 0)::bigint
                     from usage_ledger
                    where user_id = ${input.ownerUserId}
                      and metric_type in ('input_tokens', 'output_tokens')
                      and recorded_at >= ${month.start}
                      and recorded_at < ${month.end})
                    as "monthlyTokens"`,
          );
          if (!counters) throw new Error("Unable to read quota counters");
          if (counters.dailyCreateIntents >= quota.dailySessionLimit) {
            throw new QuotaExceededError("daily_sessions");
          }
          if (counters.monthlyTokens >= quota.monthlyTokenLimit) {
            throw new QuotaExceededError("monthly_tokens");
          }

          await transaction.execute(
            sql`insert into quota_reservations
                  (id, user_id, expires_at, created_at)
                values
                  (${input.id}, ${input.ownerUserId},
                   ${new Date(input.createdAt.getTime() + 5 * 60_000)},
                   ${input.createdAt})`,
          );
          await transaction.execute(
            sql`insert into sessions
                  (id, owner_user_id, ark_session_id, agent_kind,
                   platform_agent_id, personal_agent_id, ark_agent_id,
                   agent_name, agent_version, environment_id, title, status,
                   archived_at, deletion_state, last_event_at, created_at,
                   updated_at)
                values
                  (${input.id}, ${input.ownerUserId}, ${input.arkSessionId},
                   ${input.agentKind}, ${input.platformAgentId},
                   ${input.personalAgentId}, ${input.arkAgentId},
                   ${input.agentName}, ${input.agentVersion},
                   ${input.environmentId}, ${input.title}, ${input.status},
                   ${input.archivedAt}, ${input.deletionState},
                   ${input.lastEventAt}, ${input.createdAt}, ${input.updatedAt})`,
          );
          await transaction.execute(
            sql`insert into background_jobs
                  (id, owner_user_id, type, status, priority, payload,
                   attempts, run_after)
                values
                  (${input.id}, ${input.ownerUserId}, 'reconcile_session',
                   'pending', 100,
                   ${JSON.stringify({
                     operation: "create",
                     sessionId: input.id,
                   })}::jsonb,
                   0, now() + interval '30 seconds')`,
          );
          if (selectedUploadIds.length > 0) {
            const uploadIdList = sql.join(
              selectedUploadIds.map((uploadId) => sql`${uploadId}`),
              sql`, `,
            );
            await transaction.execute(
              sql`update session_inputs
                    set session_id = ${input.id}, updated_at = now()
                  where owner_user_id = ${input.ownerUserId}
                    and id in (${uploadIdList})`,
            );
          }
          return selectedInputs.length > 0
            ? selectedInputs.map((selected) => ({
                ...selected,
                sessionId: input.id,
              }))
            : undefined;
        });
      },
      completeCreate(
        id: string,
        userId: string,
        upstream: {
          arkSessionId: string;
          arkAgentId: string;
          agentVersion: string;
          status: SessionRecord["status"];
        },
      ) {
        return db.transaction(async (transaction) => {
          const job = await requiredFirst<{ status: string }>(
            transaction,
            sql`select status from background_jobs
                 where id = ${id}
                   and owner_user_id = ${userId}
                   and type = 'reconcile_session'
                 for update`,
          );
          if (job.status === "failed") {
            throw new Error("Session create reconciliation is terminal");
          }
          const session = await requiredFirst<SessionRecord>(
            transaction,
            sql`update sessions
                  set ark_session_id = ${upstream.arkSessionId},
                      ark_agent_id = ${upstream.arkAgentId},
                      agent_version = ${upstream.agentVersion},
                      status = ${upstream.status},
                      updated_at = now()
                where id = ${id} and owner_user_id = ${userId}
                returning ${sessionSelection}`,
          );
          await transaction.execute(
            sql`update session_inputs
                  set status = 'bound', last_error_code = null,
                      updated_at = now()
                where session_id = ${id}
                  and owner_user_id = ${userId}
                  and status = 'uploaded'`,
          );
          await transaction.execute(
            sql`update background_jobs
                  set status = 'succeeded', locked_at = null,
                      locked_by = null, last_error = null, updated_at = now()
                where type = 'cleanup_upload'
                  and owner_user_id = ${userId}
                  and id in (
                    select id from session_inputs
                     where session_id = ${id}
                       and owner_user_id = ${userId}
                  )`,
          );
          await transaction.execute(
            sql`update quota_reservations
                  set status = 'consumed', resolved_at = now()
                where id = ${id} and user_id = ${userId}
                  and status = 'active'`,
          );
          await transaction.execute(
            sql`update background_jobs
                  set status = 'succeeded', locked_at = null,
                      locked_by = null, last_error = null, updated_at = now()
                where id = ${id} and owner_user_id = ${userId}
                  and type = 'reconcile_session'`,
          );
          return session;
        });
      },
      async preserveCreateOutcome(
        id: string,
        userId: string,
        upstream?: {
          arkSessionId: string;
          arkAgentId: string;
          agentVersion: string;
          status: SessionRecord["status"];
        },
      ) {
        await db.transaction(async (transaction) => {
          if (upstream) {
            await transaction.execute(
              sql`update sessions
                    set ark_session_id = ${upstream.arkSessionId},
                        ark_agent_id = ${upstream.arkAgentId},
                        agent_version = ${upstream.agentVersion},
                        status = ${upstream.status},
                        updated_at = now()
                  where id = ${id} and owner_user_id = ${userId}`,
            );
          }
          await transaction.execute(
            sql`update quota_reservations
                  set status = 'consumed', resolved_at = now()
                where id = ${id} and user_id = ${userId}
                  and status = 'active'`,
          );
          await transaction.execute(
            sql`update background_jobs
                  set status = 'pending', run_after = now() + interval '30 seconds',
                      locked_at = null, locked_by = null, updated_at = now()
                where id = ${id} and owner_user_id = ${userId}
                  and type = 'reconcile_session'
                  and status <> 'succeeded'`,
          );
        });
      },
      async failCreate(id: string, userId: string) {
        await db.transaction(async (transaction) => {
          await transaction.execute(
            sql`delete from sessions
                 where id = ${id} and owner_user_id = ${userId}`,
          );
          await transaction.execute(
            sql`update quota_reservations
                  set status = 'released', resolved_at = now()
                where id = ${id} and user_id = ${userId}
                  and status = 'active'`,
          );
          await transaction.execute(
            sql`update background_jobs
                  set status = 'failed', locked_at = null, locked_by = null,
                      last_error = 'ARK_CREATE_FAILED', updated_at = now()
                where id = ${id} and owner_user_id = ${userId}
                  and type = 'reconcile_session'`,
          );
        });
      },
      listOwned(userId: string, archived: boolean) {
        return rows<SessionRecord>(
          db,
          sql`select ${sessionSelection}
                from sessions
               where owner_user_id = ${userId}
                 and (
                   ark_session_id not like 'pending:%'
                   or deletion_state = 'deletion_failed'
                 )
                 and deletion_state <> 'deleted'
                 and ${
                   archived
                     ? sql`archived_at is not null`
                     : sql`archived_at is null`
                 }
               order by created_at desc, id desc`,
        );
      },
      findOwned(userId: string, id: string) {
        return first<SessionRecord>(
          db,
          sql`select ${sessionSelection}
                from sessions
               where id = ${id} and owner_user_id = ${userId}
                 and (
                   ark_session_id not like 'pending:%'
                   or deletion_state = 'deletion_failed'
                 )
                 and deletion_state <> 'deleted'
               limit 1`,
        );
      },
      findCreateIntent(userId: string, id: string) {
        return first<SessionRecord>(
          db,
          sql`select ${sessionSelection}
                from sessions
               where id = ${id} and owner_user_id = ${userId}
               limit 1`,
        );
      },
      setArchived(userId: string, id: string, archivedAt: Date | null) {
        return first<SessionRecord>(
          db,
          sql`update sessions
                set archived_at = ${archivedAt}
              where id = ${id}
                and owner_user_id = ${userId}
                and ark_session_id not like 'pending:%'
                and deletion_state <> 'deleted'
              returning ${sessionSelection}`,
        );
      },
      beginDelete(userId: string, id: string) {
        return db.transaction(async (transaction) => {
          const job = await first<{
            type: JobRecord["type"];
            status: "pending" | "running" | "succeeded" | "failed";
          }>(
            transaction,
            sql`select type, status
                  from background_jobs
                 where id = ${id}
                   and owner_user_id = ${userId}
                 for update`,
          );
          const session = await first<SessionRecord>(
            transaction,
            sql`select ${sessionSelection}
                  from sessions
                 where id = ${id}
                  and owner_user_id = ${userId}
                  and (
                    ark_session_id not like 'pending:%'
                    or deletion_state = 'deletion_failed'
                  )
                  and deletion_state <> 'deleted'
                 for update`,
          );
          if (!session) return undefined;

          await transaction.execute(
            sql`update background_jobs
                  set run_after = now(), updated_at = now()
                where owner_user_id = ${userId}
                  and type = 'cleanup_artifact_object'
                  and status = 'pending'
                  and payload ->> 'objectKey'
                    like ${`tenants/${userId}/sessions/${id}/artifacts/%`}`,
          );

          if (job?.type === "delete_session" && job.status !== "failed") {
            return session;
          }
          if (job?.type === "delete_session") {
            await requiredFirst(
              transaction,
              sql`update background_jobs
                    set status = 'pending',
                        priority = 80,
                        attempts = 0,
                        run_after = now(),
                        locked_at = null,
                        locked_by = null,
                        last_error = null,
                        updated_at = now()
                  where id = ${id}
                    and owner_user_id = ${userId}
                    and type = 'delete_session'
                    and status = 'failed'
                  returning id`,
            );
          } else if (job?.type === "reconcile_session") {
            await requiredFirst(
              transaction,
              sql`update background_jobs
                    set type = 'delete_session',
                        status = 'pending',
                        priority = 80,
                        payload = ${JSON.stringify({
                          sessionId: id,
                          completed: {},
                        })}::jsonb,
                        attempts = 0,
                        run_after = now(),
                        locked_at = null,
                        locked_by = null,
                        last_error = null,
                        updated_at = now()
                  where id = ${id}
                    and owner_user_id = ${userId}
                    and type = 'reconcile_session'
                  returning id`,
            );
          } else if (!job) {
            await transaction.execute(
              sql`insert into background_jobs
                  (id, owner_user_id, type, status, priority, payload,
                   attempts, run_after)
                values
                  (${id}, ${userId}, 'delete_session', 'pending', 80,
                   ${JSON.stringify({ sessionId: id, completed: {} })}::jsonb,
                   0, now())`,
            );
          } else {
            throw new Error("Session deletion job conflicts with existing job");
          }

          return requiredFirst<SessionRecord>(
            transaction,
            sql`update sessions
                  set deletion_state = 'pending',
                      updated_at = now()
                where id = ${id}
                  and owner_user_id = ${userId}
                  and deletion_state <> 'deleted'
                returning ${sessionSelection}`,
          );
        });
      },
      listInputs(userId: string, id: string) {
        return rows<SessionInputRecord>(
          db,
          sql`select ${sessionInputSelection}
                from session_inputs
               where owner_user_id = ${userId}
                 and session_id = ${id}
               order by created_at asc, id asc`,
        );
      },
      beginMessage(userId: string, id: string) {
        return db.transaction(async (transaction) => {
          const user = await first(
            transaction,
            sql`select id from users
                 where id = ${userId}
                   and role = 'user'
                   and status = 'active'
                 for update`,
          );
          if (!user) return undefined;
          const session = await first<SessionRecord>(
            transaction,
            sql`select ${sessionSelection}
                  from sessions
                 where id = ${id}
                   and owner_user_id = ${userId}
                   and ark_session_id not like 'pending:%'
                   and deletion_state <> 'deleted'
                 for update`,
          );
          if (!session) return undefined;
          if (
            session.deletionState === "pending" ||
            session.deletionState === "deletion_failed"
          ) {
            return {
              kind: "deletion_conflict" as const,
              deletionState: session.deletionState,
            };
          }

          const quota = await effectiveQuota(transaction, userId);
          const month = utcMonthWindow(new Date());
          const usage = await first<{
            concurrentSessions: number;
            monthlyTokens: number;
          }>(
            transaction,
            sql`select
                  (select count(*)::integer
                     from sessions
                    where owner_user_id = ${userId}
                      and status in ('running', 'rescheduled')
                      and deletion_state <> 'deleted')
                    as "concurrentSessions",
                  (select coalesce(sum(quantity), 0)::bigint
                     from usage_ledger
                    where user_id = ${userId}
                      and metric_type in ('input_tokens', 'output_tokens')
                      and recorded_at >= ${month.start}
                      and recorded_at < ${month.end})
                    as "monthlyTokens"`,
          );
          if (!usage) throw new Error("Unable to read message quota");
          if (usage.monthlyTokens >= quota.monthlyTokenLimit) {
            throw new QuotaExceededError("monthly_tokens");
          }
          if (session.status !== "idle") {
            if (session.status === "terminated") {
              return {
                kind: "accepted" as const,
                session,
                started: false,
              };
            }
            const queued = await requiredFirst<SessionRecord>(
              transaction,
              sql`update sessions
                    set message_in_flight_count = message_in_flight_count + 1,
                        updated_at = now()
                  where id = ${id}
                    and owner_user_id = ${userId}
                    and status in ('running', 'rescheduled')
                    and deletion_state = 'none'
                  returning ${sessionSelection}`,
            );
            return {
              kind: "accepted" as const,
              session: queued,
              started: false,
            };
          }
          if (usage.concurrentSessions >= quota.concurrentSessionLimit) {
            throw new QuotaExceededError("concurrent_sessions");
          }

          const started = await requiredFirst<SessionRecord>(
            transaction,
            sql`update sessions
                  set status = 'running',
                      message_in_flight_count = message_in_flight_count + 1,
                      message_start_pending = true,
                      updated_at = now()
                where id = ${id}
                  and owner_user_id = ${userId}
                  and status = 'idle'
                  and deletion_state = 'none'
                returning ${sessionSelection}`,
          );
          return {
            kind: "accepted" as const,
            session: started,
            started: true,
          };
        });
      },
      async finishMessage(
        userId: string,
        id: string,
        outcome: "accepted_or_unknown" | "definite_failure",
      ) {
        await db.execute(
          sql`update sessions
                set status = case
                      when ${outcome} = 'definite_failure'
                        and message_start_pending
                        and message_in_flight_count = 1
                        and status = 'running'
                      then 'idle'::session_status
                      else status
                    end,
                    message_start_pending = case
                      when ${outcome} = 'accepted_or_unknown'
                        or message_in_flight_count = 1
                      then false
                      else message_start_pending
                    end,
                    message_in_flight_count =
                      greatest(message_in_flight_count - 1, 0),
                    updated_at = now()
              where id = ${id}
                and owner_user_id = ${userId}
                and message_in_flight_count > 0`,
        );
      },
      async projectEvent(
        userId: string,
        id: string,
        projection: {
          eventId: string;
          observedAt: Date;
          status?: SessionRecord["status"];
          errorCode?: string | null;
          errorRecoverable?: boolean | null;
          metrics?: Array<{
            metricType: UsageMetricType;
            quantity: number;
          }>;
        },
      ) {
        await db.transaction(async (transaction) => {
          const owner = await first(
            transaction,
            sql`select id from users
                 where id = ${userId}
                 for update`,
          );
          if (!owner) return;
          await transaction.execute(
            sql`insert into session_event_cursors
                  (session_id, recent_event_ids)
                select id, '[]'::jsonb
                  from sessions
                 where id = ${id} and owner_user_id = ${userId}
                on conflict (session_id) do nothing`,
          );
          const cursor = await first<{
            lastObservedAt: Date | null;
            runningSince: Date | null;
            recentEventIds: string[];
          }>(
            transaction,
            sql`select cursor.last_observed_at as "lastObservedAt",
                       cursor.running_since as "runningSince",
                       cursor.recent_event_ids as "recentEventIds"
                  from session_event_cursors cursor
                  join sessions session on session.id = cursor.session_id
                 where cursor.session_id = ${id}
                   and session.owner_user_id = ${userId}
                 for update of cursor`,
          );
          if (!cursor || cursor.recentEventIds.includes(projection.eventId)) {
            return;
          }

          const lastObservedAt =
            cursor.lastObservedAt === null
              ? null
              : new Date(cursor.lastObservedAt);
          const runningSince =
            cursor.runningSince === null ? null : new Date(cursor.runningSince);
          const chronological =
            lastObservedAt === null || lastObservedAt <= projection.observedAt;
          const activeStatus = projection.status === "running";
          const closesRuntime =
            chronological &&
            projection.status !== undefined &&
            !activeStatus &&
            runningSince !== null &&
            runningSince <= projection.observedAt;
          const metrics = [
            ...(projection.metrics ?? []),
            ...(closesRuntime
              ? [
                  {
                    metricType: "runtime_ms" as const,
                    quantity:
                      projection.observedAt.getTime() - runningSince!.getTime(),
                  },
                ]
              : []),
          ];
          let tokenUsageInserted = false;
          for (const metric of metrics) {
            const inserted = await rows(
              transaction,
              sql`insert into usage_ledger
                    (id, user_id, ark_session_id, ark_event_id, metric_type,
                     quantity, recorded_at)
                  select ${randomUUID()}, ${userId}, session.ark_session_id,
                         ${projection.eventId}, ${metric.metricType},
                         ${metric.quantity}, ${projection.observedAt}
                    from sessions session
                   where session.id = ${id}
                     and session.owner_user_id = ${userId}
                  on conflict
                    (user_id, ark_session_id, ark_event_id, metric_type)
                  do nothing
                  returning id`,
            );
            if (
              inserted.length === 1 &&
              (metric.metricType === "input_tokens" ||
                metric.metricType === "output_tokens")
            ) {
              tokenUsageInserted = true;
            }
          }
          if (tokenUsageInserted) {
            const window = utcMonthWindow(projection.observedAt);
            const quota = await effectiveQuota(transaction, userId);
            const usage = await first<{ total: number }>(
              transaction,
              sql`select coalesce(sum(quantity), 0)::bigint as total
                    from usage_ledger
                   where user_id = ${userId}
                     and metric_type in ('input_tokens', 'output_tokens')
                     and recorded_at >= ${window.start}
                     and recorded_at < ${window.end}`,
            );
            if (Number(usage?.total ?? 0) >= quota.monthlyTokenLimit) {
              await enqueueQuotaInterrupts(
                transaction,
                userId,
                window.start,
                projection.observedAt,
              );
            }
          }

          const nextRunningSince =
            chronological && projection.status !== undefined
              ? activeStatus
                ? (runningSince ?? projection.observedAt)
                : null
              : runningSince;
          await transaction.execute(
            sql`update session_event_cursors
                  set recent_event_ids = case
                        when jsonb_array_length(recent_event_ids) >= 256
                          then (recent_event_ids - 0)
                               || jsonb_build_array(${projection.eventId}::text)
                        else recent_event_ids
                             || jsonb_build_array(${projection.eventId}::text)
                      end,
                      last_observed_at = greatest(
                        coalesce(last_observed_at, ${projection.observedAt}),
                        ${projection.observedAt}
                      ),
                      running_since = ${nextRunningSince},
                      updated_at = now()
                where session_id = ${id}`,
          );

          const applies =
            projection.status !== undefined ||
            projection.errorCode !== undefined ||
            projection.errorRecoverable !== undefined;
          await transaction.execute(
            sql`update sessions
                  set status = case
                        when ${applies}
                          and (
                            last_event_at is null
                            or last_event_at <= ${projection.observedAt}
                          )
                          and ${projection.status !== undefined}
                        then ${projection.status ?? null}::session_status
                        else status
                      end,
                      last_error_code = case
                        when ${applies}
                          and (
                            last_event_at is null
                            or last_event_at <= ${projection.observedAt}
                          )
                          and ${projection.errorCode !== undefined}
                        then ${projection.errorCode ?? null}
                        else last_error_code
                      end,
                      error_recoverable = case
                        when ${applies}
                          and (
                            last_event_at is null
                            or last_event_at <= ${projection.observedAt}
                          )
                          and ${projection.errorRecoverable !== undefined}
                        then ${projection.errorRecoverable ?? null}
                        else error_recoverable
                      end,
                      last_event_at = greatest(
                        coalesce(last_event_at, ${projection.observedAt}),
                        ${projection.observedAt}
                      ),
                      updated_at = now()
                where id = ${id} and owner_user_id = ${userId}`,
          );
        });
      },
      listRunningForQuota(userId: string) {
        return rows<SessionRecord>(
          db,
          sql`select ${sessionSelection}
                from sessions
               where owner_user_id = ${userId}
                 and status in ('running', 'rescheduled')
                 and deletion_state = 'none'
               order by updated_at, id`,
        );
      },
      async syncQuotaStatus(
        userId: string,
        id: string,
        status: SessionRecord["status"],
        observedAt: Date,
      ) {
        await db.execute(
          sql`update sessions
                set status = ${status},
                    updated_at = ${observedAt}
              where id = ${id}
                and owner_user_id = ${userId}
                and status in ('running', 'rescheduled')
                and deletion_state = 'none'`,
        );
      },
      async audit(input: {
        actorUserId: string;
        ownerUserId: string;
        action: string;
        resourceType: "session";
        resourceId: string;
        result: "succeeded" | "failed";
        requestId: string;
        arkRequestId?: string;
        errorCode?: string;
      }) {
        await db.execute(
          sql`insert into audit_logs
                (id, actor_user_id, owner_user_id, action, resource_type,
                 resource_id, result, request_id, ark_request_id, error_code)
              values
                (${randomUUID()}, ${input.actorUserId}, ${input.ownerUserId},
                 ${input.action}, ${input.resourceType}, ${input.resourceId},
                 ${input.result}, ${input.requestId},
                 ${input.arkRequestId ?? null}, ${input.errorCode ?? null})`,
        );
      },
    },
    sessionInputs: {
      prepareUpload(input: SessionInputRecord) {
        return db.transaction(async (transaction) => {
          await transaction.execute(
            sql`insert into session_inputs
                  (id, owner_user_id, session_id, ark_file_id, original_name,
                   mime_type, size_bytes, mount_path, status, expires_at,
                   last_error_code, created_at, updated_at)
                values
                  (${input.id}, ${input.ownerUserId}, ${input.sessionId},
                   ${input.arkFileId}, ${input.originalName}, ${input.mimeType},
                   ${input.sizeBytes}, ${input.mountPath}, ${input.status},
                   ${input.expiresAt}, ${input.lastErrorCode},
                   ${input.createdAt}, ${input.updatedAt})`,
          );
          await transaction.execute(
            sql`insert into background_jobs
                  (id, owner_user_id, type, status, priority, payload,
                   attempts, run_after)
                values
                  (${input.id}, ${input.ownerUserId}, 'cleanup_upload',
                   'pending', 200,
                   ${JSON.stringify({ uploadId: input.id })}::jsonb,
                   0, ${input.expiresAt})`,
          );
        });
      },
      completeUpload(
        id: string,
        userId: string,
        upstream: {
          arkFileId: string;
          mimeType: string;
          sizeBytes: number;
        },
      ) {
        return requiredFirst<SessionInputRecord>(
          db,
          sql`update session_inputs
                set ark_file_id = ${upstream.arkFileId},
                    mime_type = ${upstream.mimeType},
                    size_bytes = ${upstream.sizeBytes},
                    status = 'uploaded',
                    last_error_code = null,
                    updated_at = now()
              where id = ${id}
                and owner_user_id = ${userId}
                and session_id is null
                and status = 'uploading'
              returning ${sessionInputSelection}`,
        );
      },
      async preserveUploadOutcome(
        id: string,
        userId: string,
        upstream: {
          arkFileId: string;
          mimeType: string;
          sizeBytes: number;
        },
      ) {
        await db.execute(
          sql`update session_inputs
                set ark_file_id = ${upstream.arkFileId},
                    mime_type = ${upstream.mimeType},
                    size_bytes = ${upstream.sizeBytes},
                    status = 'uploaded',
                    last_error_code = 'DB_PERSISTENCE_FAILED',
                    updated_at = now()
              where id = ${id}
                and owner_user_id = ${userId}
                and session_id is null
                and status = 'uploading'`,
        );
      },
      async failUpload(id: string, userId: string, errorCode: string) {
        await db.transaction(async (transaction) => {
          await transaction.execute(
            sql`update session_inputs
                  set status = 'failed', last_error_code = ${errorCode},
                      updated_at = now()
                where id = ${id}
                  and owner_user_id = ${userId}
                  and session_id is null`,
          );
          await transaction.execute(
            sql`update background_jobs
                  set status = 'pending', locked_at = null, locked_by = null,
                      last_error = ${errorCode}, updated_at = now()
                where id = ${id}
                  and owner_user_id = ${userId}
                  and type = 'cleanup_upload'`,
          );
        });
      },
      findOwned(userId: string, id: string) {
        return first<SessionInputRecord>(
          db,
          sql`select ${sessionInputSelection}
                from session_inputs
               where id = ${id} and owner_user_id = ${userId}
               limit 1`,
        );
      },
      findExpiredUnbound(userId: string, id: string, now = new Date()) {
        return first<SessionInputRecord>(
          db,
          sql`update session_inputs
                set status = 'deleting', updated_at = ${now}
              where id = ${id}
                and owner_user_id = ${userId}
                and session_id is null
                and status in ('uploading', 'uploaded', 'failed', 'deleting')
                and expires_at <= ${now}
              returning ${sessionInputSelection}`,
        );
      },
      async removeUnbound(id: string, userId: string) {
        const removed = await rows(
          db,
          sql`delete from session_inputs
                where id = ${id}
                  and owner_user_id = ${userId}
                  and session_id is null
                returning id`,
        );
        return removed.length === 1;
      },
    },
    artifacts: {
      findSessionOwned(userId: string, sessionId: string) {
        return first<{ id: string; arkSessionId: string }>(
          db,
          sql`select id, ark_session_id as "arkSessionId"
                from sessions
               where id = ${sessionId}
                 and owner_user_id = ${userId}
                 and ark_session_id not like 'pending:%'
                 and deletion_state = 'none'
               limit 1`,
        );
      },
      findBySource(userId: string, sessionId: string, arkFileId: string) {
        return first<ArtifactRecord & Row>(
          db,
          sql`select ${artifactSelection}
                from artifacts
               where owner_user_id = ${userId}
                 and session_id = ${sessionId}
                 and ark_file_id = ${arkFileId}
               limit 1`,
        );
      },
      async stageCleanup(input: {
        id: string;
        ownerUserId: string;
        sessionId: string;
        objectKey: string;
        runAfter: Date;
        uploadInProgressUntil?: Date;
      }) {
        return db.transaction(async (transaction) => {
          const session = await first(
            transaction,
            sql`select id
                  from sessions
                 where id = ${input.sessionId}
                   and owner_user_id = ${input.ownerUserId}
                   and deletion_state = 'none'
                 for update`,
          );
          if (!session) return false;
          await transaction.execute(
            sql`insert into background_jobs
                  (id, owner_user_id, type, status, priority, payload,
                   attempts, run_after)
                values
                  (${input.id}, ${input.ownerUserId}, 'cleanup_artifact_object',
                   'pending', 90,
                   ${JSON.stringify({
                     objectKey: input.objectKey,
                     cleanupGeneration: 0,
                     ...(input.uploadInProgressUntil
                       ? {
                           uploadInProgressUntil:
                             input.uploadInProgressUntil.toISOString(),
                         }
                       : {}),
                   })}::jsonb,
                   0, ${input.runAfter})`,
          );
          return true;
        });
      },
      commitCandidate(input: {
        record: ArtifactRecord;
        stagingCleanupJobId: string;
        replacementCleanupJobId: string;
      }) {
        return db.transaction(async (transaction) => {
          const session = await first<{ deletionState: string }>(
            transaction,
            sql`select deletion_state as "deletionState"
                  from sessions
                 where id = ${input.record.sessionId}
                   and owner_user_id = ${input.record.ownerUserId}
                   for update`,
          );
          const stagingCleanup = await first<{
            status: "pending" | "running" | "succeeded" | "failed";
            uploadInProgressUntil: string | null;
          }>(
            transaction,
            sql`select status,
                       payload ->> 'uploadInProgressUntil'
                         as "uploadInProgressUntil"
                  from background_jobs
                 where id = ${input.stagingCleanupJobId}
                   and owner_user_id = ${input.record.ownerUserId}
                   and type = 'cleanup_artifact_object'
                   and payload ->> 'objectKey' = ${input.record.tosObjectKey}
                 for update`,
          );
          if (!stagingCleanup) {
            throw new Error("Artifact staging cleanup intent was not found");
          }
          const rearmStagingCleanup = () =>
            transaction.execute(
              sql`update background_jobs
                    set payload =
                          (payload - 'uploadInProgressUntil')
                          || jsonb_build_object(
                            'cleanupGeneration',
                            coalesce(
                              (payload ->> 'cleanupGeneration')::integer,
                              0
                            ) + 1
                          ),
                        status = case
                          when status = 'running' then status
                          else 'pending'
                        end,
                        attempts = 0,
                        run_after = case
                          when status = 'running' then run_after
                          else now()
                        end,
                        locked_at = case
                          when status = 'running' then locked_at
                          else null
                        end,
                        locked_by = case
                          when status = 'running' then locked_by
                          else null
                        end,
                        last_error = null,
                        updated_at = now()
                  where id = ${input.stagingCleanupJobId}
                    and owner_user_id = ${input.record.ownerUserId}
                    and type = 'cleanup_artifact_object'`,
            );
          if (!session || session.deletionState !== "none") {
            await rearmStagingCleanup();
            return { artifact: input.record, activated: false };
          }
          const existing = await first<ArtifactRecord & Row>(
            transaction,
            sql`select ${artifactSelection}
                  from artifacts
                 where owner_user_id = ${input.record.ownerUserId}
                   and session_id = ${input.record.sessionId}
                   and ark_file_id = ${input.record.arkFileId}
                 limit 1`,
          );
          if (
            existing?.deletionState !== undefined &&
            existing.deletionState !== "none"
          ) {
            if (
              stagingCleanup.uploadInProgressUntil ||
              stagingCleanup.status === "failed"
            ) {
              await rearmStagingCleanup();
            }
            await transaction.execute(
              sql`update background_jobs
                    set status = 'pending',
                        attempts = 0,
                        run_after = now(),
                        locked_at = null,
                        locked_by = null,
                        last_error = null,
                        updated_at = now()
                  where id = ${existing.id}
                    and owner_user_id = ${existing.ownerUserId}
                    and type = 'delete_artifact'
                    and status = 'failed'`,
            );
            return { artifact: existing, activated: false };
          }
          if (stagingCleanup.status !== "pending") {
            await rearmStagingCleanup();
            return { artifact: existing ?? input.record, activated: false };
          }
          const artifact = await requiredFirst<ArtifactRecord & Row>(
            transaction,
            sql`insert into artifacts
                (id, owner_user_id, session_id, ark_file_id, tos_object_key,
                 name, mime_type, size_bytes, generated_at, deletion_state,
                 last_error_code, created_at, updated_at)
              values
                (${input.record.id}, ${input.record.ownerUserId},
                 ${input.record.sessionId}, ${input.record.arkFileId},
                 ${input.record.tosObjectKey}, ${input.record.name},
                 ${input.record.mimeType}, ${input.record.sizeBytes},
                 ${input.record.generatedAt}, ${input.record.deletionState},
                 ${input.record.lastErrorCode}, ${input.record.createdAt},
                 ${input.record.updatedAt})
              on conflict (owner_user_id, session_id, ark_file_id) do update
                set tos_object_key = excluded.tos_object_key,
                    name = excluded.name,
                    mime_type = excluded.mime_type,
                    size_bytes = excluded.size_bytes,
                    generated_at = excluded.generated_at,
                    updated_at = excluded.updated_at
              returning ${artifactSelection}`,
          );
          const retired = await rows(
            transaction,
            sql`update background_jobs
                  set status = 'succeeded',
                      payload = payload - 'uploadInProgressUntil',
                      locked_at = null,
                      locked_by = null,
                      last_error = null,
                      updated_at = now()
                where id = ${input.stagingCleanupJobId}
                  and owner_user_id = ${input.record.ownerUserId}
                  and type = 'cleanup_artifact_object'
                  and status = 'pending'
                  and payload ->> 'objectKey' = ${input.record.tosObjectKey}
                returning id`,
          );
          if (retired.length !== 1) {
            throw new Error("Artifact staging cleanup intent was not active");
          }
          if (existing && existing.tosObjectKey !== input.record.tosObjectKey) {
            await transaction.execute(
              sql`insert into background_jobs
                    (id, owner_user_id, type, status, priority, payload,
                     attempts, run_after)
                  values
                    (${input.replacementCleanupJobId},
                     ${input.record.ownerUserId}, 'cleanup_artifact_object',
                     'pending', 90,
                     ${JSON.stringify({
                       objectKey: existing.tosObjectKey,
                       cleanupGeneration: 0,
                     })}::jsonb,
                     0, now())`,
            );
          }
          return { artifact, activated: true };
        });
      },
      async releaseCleanup(id: string, userId: string) {
        await db.execute(
          sql`update background_jobs
                set payload =
                      (payload - 'uploadInProgressUntil')
                      || jsonb_build_object(
                        'cleanupGeneration',
                        coalesce(
                          (payload ->> 'cleanupGeneration')::integer,
                          0
                        ) + 1
                      ),
                    status = case
                      when status = 'running' then status
                      else 'pending'
                    end,
                    attempts = 0,
                    run_after = case
                      when status = 'running' then run_after
                      else now()
                    end,
                    locked_at = case
                      when status = 'running' then locked_at
                      else null
                    end,
                    locked_by = case
                      when status = 'running' then locked_by
                      else null
                    end,
                    last_error = null,
                    updated_at = now()
              where id = ${id}
                and owner_user_id = ${userId}
                and type = 'cleanup_artifact_object'`,
        );
      },
      listOwned(userId: string, sessionId?: string) {
        return rows<ArtifactRecord & Row>(
          db,
          sql`select ${artifactSelection}
                from artifacts
               where owner_user_id = ${userId}
                 and (${sessionId ?? null}::uuid is null
                      or session_id = ${sessionId ?? null})
                 and deletion_state = 'none'
               order by generated_at desc, id desc`,
        );
      },
      findOwned(userId: string, id: string) {
        return first<ArtifactRecord & Row>(
          db,
          sql`select ${artifactSelection}
                from artifacts
               where id = ${id}
                 and owner_user_id = ${userId}
                 and deletion_state <> 'deleted'
               limit 1`,
        );
      },
      beginDelete(id: string, userId: string) {
        return db.transaction(async (transaction) => {
          const candidate = await first<{ sessionId: string }>(
            transaction,
            sql`select session_id as "sessionId"
                  from artifacts
                 where id = ${id}
                   and owner_user_id = ${userId}
                 limit 1`,
          );
          if (!candidate) return undefined;
          await transaction.execute(
            sql`select id
                  from sessions
                 where id = ${candidate.sessionId}
                   and owner_user_id = ${userId}
                   for update`,
          );
          const artifact = await first<ArtifactRecord & Row>(
            transaction,
            sql`update artifacts
                  set deletion_state = 'pending',
                      last_error_code = null,
                      updated_at = now()
                where id = ${id}
                  and owner_user_id = ${userId}
                  and deletion_state <> 'deleted'
                returning ${artifactSelection}`,
          );
          if (!artifact) return undefined;
          await transaction.execute(
            sql`insert into background_jobs
                  (id, owner_user_id, type, status, priority, payload,
                   attempts, run_after)
                values
                  (${id}, ${userId}, 'delete_artifact', 'pending', 100,
                   ${JSON.stringify({ artifactId: id })}::jsonb, 0, now())
                on conflict (id) do update
                  set status = 'pending',
                      attempts = 0,
                      run_after = now(),
                      locked_at = null,
                      locked_by = null,
                      last_error = null,
                      updated_at = now()
                where background_jobs.status = 'failed'`,
          );
          return artifact;
        });
      },
      findDeleting(userId: string, id: string) {
        return first<ArtifactRecord & Row>(
          db,
          sql`select ${artifactSelection}
                from artifacts
               where id = ${id}
                 and owner_user_id = ${userId}
                 and deletion_state in ('pending', 'deletion_failed', 'deleted')
               limit 1`,
        );
      },
      async markDeleted(id: string, userId: string) {
        const removed = await rows(
          db,
          sql`update artifacts
                 set name = '',
                     mime_type = 'application/octet-stream',
                     size_bytes = 0,
                     deletion_state = 'deleted',
                     last_error_code = null,
                     updated_at = now()
               where id = ${id}
                 and owner_user_id = ${userId}
                 and deletion_state in ('pending', 'deletion_failed', 'deleted')
               returning id`,
        );
        return removed.length === 1;
      },
    },

    defaultAgents: {
      findForUser(userId: string) {
        return first<DefaultAgentRecord>(
          db,
          sql`select user_id as "userId",
                     platform_agent_id as "platformAgentId",
                     assigned_by as "assignedBy",
                     assigned_at as "assignedAt"
                from user_default_agents
               where user_id = ${userId}
               limit 1`,
        );
      },
      assign(input: {
        userId: string;
        platformAgentId: string;
        assignedBy: string;
      }) {
        return db.transaction(async (transaction) => {
          const eligible = await first(
            transaction,
            sql`select pa.id
                  from platform_agents pa
                  join users target on target.id = ${input.userId}
                  join users administrator on administrator.id = ${input.assignedBy}
                 where pa.id = ${input.platformAgentId}
                   and pa.status = 'active'
                   and target.role = 'user'
                   and target.status = 'active'
                   and administrator.role = 'admin'
                   and administrator.status = 'active'
                 for update of pa, target`,
          );
          if (!eligible) {
            throw new Error(
              "Default assignment requires an active platform agent, active user, and active admin",
            );
          }

          return first<DefaultAgentRecord>(
            transaction,
            sql`insert into user_default_agents
                  (user_id, platform_agent_id, assigned_by)
                values
                  (${input.userId}, ${input.platformAgentId}, ${input.assignedBy})
                on conflict (user_id) do update
                  set platform_agent_id = excluded.platform_agent_id,
                      assigned_by = excluded.assigned_by,
                      assigned_at = now()
                returning user_id as "userId",
                          platform_agent_id as "platformAgentId",
                          assigned_by as "assignedBy",
                          assigned_at as "assignedAt"`,
          );
        });
      },
    },

    quotas: {
      getEffective(userId: string) {
        return effectiveQuota(db, userId);
      },
      reserveSession(input: {
        userId: string;
        reservationId: string;
        expiresAt: Date;
        now?: Date;
      }) {
        return db.transaction(async (transaction) => {
          const now = input.now ?? new Date();
          const user = await first(
            transaction,
            sql`select id from users
                 where id = ${input.userId} and status = 'active'
                 for update`,
          );
          if (!user) {
            throw new Error("Active user not found");
          }

          const quota = await effectiveQuota(transaction, input.userId);
          const month = utcMonthWindow(now);
          const counters = await first<{
            activeReservations: number;
            concurrentSessions: number;
            dailySessions: number;
            monthlyTokens: number;
          }>(
            transaction,
            sql`select
                  (select count(*)::integer
                     from quota_reservations
                    where user_id = ${input.userId}
                      and status = 'active'
                      and expires_at > ${now}) as "activeReservations",
                  (select count(*)::integer
                     from sessions
                    where owner_user_id = ${input.userId}
                      and status in ('running', 'rescheduled')
                      and deletion_state <> 'deleted') as "concurrentSessions",
                  (select count(*)::integer
                     from sessions
                    where owner_user_id = ${input.userId}
                      and created_at >= date_trunc('day', ${now}::timestamptz))
                    as "dailySessions",
                  (select coalesce(sum(quantity), 0)::bigint
                     from usage_ledger
                    where user_id = ${input.userId}
                      and metric_type in ('input_tokens', 'output_tokens')
                      and recorded_at >= ${month.start}
                      and recorded_at < ${month.end})
                    as "monthlyTokens"`,
          );
          if (!counters) {
            throw new Error("Unable to read quota counters");
          }

          if (
            counters.concurrentSessions + counters.activeReservations >=
            quota.concurrentSessionLimit
          ) {
            throw new QuotaExceededError("concurrent_sessions");
          }
          if (
            counters.dailySessions + counters.activeReservations >=
            quota.dailySessionLimit
          ) {
            throw new QuotaExceededError("daily_sessions");
          }
          if (counters.monthlyTokens >= quota.monthlyTokenLimit) {
            throw new QuotaExceededError("monthly_tokens");
          }

          await transaction.execute(
            sql`insert into quota_reservations (id, user_id, expires_at)
                values (${input.reservationId}, ${input.userId}, ${input.expiresAt})`,
          );
          return { id: input.reservationId, quota };
        });
      },
      async resolveReservation(
        reservationId: string,
        status: "consumed" | "released",
      ) {
        const reservation = await first(
          db,
          sql`update quota_reservations
                set status = ${status}, resolved_at = now()
              where id = ${reservationId} and status = 'active'
              returning id, user_id as "userId", status`,
        );
        return reservation;
      },
    },

    usage: {
      findOwned(userId: string, id: string) {
        return first<OwnedRecord>(
          db,
          sql`select id, user_id as "ownerUserId"
                from usage_ledger
               where id = ${id} and user_id = ${userId}
               limit 1`,
        );
      },
      listReconcilable(input: { cutoff: Date; limit: number }) {
        return rows<{
          sessionId: string;
          ownerUserId: string;
          arkSessionId: string;
          status: SessionRecord["status"];
        }>(
          db,
          sql`select session.id as "sessionId",
                     session.owner_user_id as "ownerUserId",
                     session.ark_session_id as "arkSessionId", session.status
                from sessions session
                left join session_event_cursors cursor
                  on cursor.session_id = session.id
               where session.ark_session_id not like 'pending:%'
                 and session.deletion_state not in ('pending', 'deleted')
                 and (
                   session.status in ('running', 'rescheduled')
                   or session.updated_at >= ${input.cutoff}
                 )
               order by cursor.last_reconciled_at asc nulls first,
                        session.updated_at, session.id
               limit ${input.limit}`,
        );
      },
      async markReconciled(
        userId: string,
        sessionId: string,
        reconciledAt: Date,
      ) {
        await db.execute(
          sql`insert into session_event_cursors
                (session_id, last_reconciled_at)
              select id, ${reconciledAt}
                from sessions
               where id = ${sessionId}
                 and owner_user_id = ${userId}
              on conflict (session_id) do update
                set last_reconciled_at = greatest(
                      coalesce(
                        session_event_cursors.last_reconciled_at,
                        excluded.last_reconciled_at
                      ),
                      excluded.last_reconciled_at
                    ),
                    updated_at = now()`,
        );
      },
      monthlyTokens(userId: string, now: Date) {
        const window = utcMonthWindow(now);
        return first<{ total: number }>(
          db,
          sql`select coalesce(sum(quantity), 0)::bigint as total
                from usage_ledger
               where user_id = ${userId}
                 and metric_type in ('input_tokens', 'output_tokens')
                 and recorded_at >= ${window.start}
                 and recorded_at < ${window.end}`,
        ).then((row) => Number(row?.total ?? 0));
      },
      async summary(userId: string, now: Date) {
        const month = utcMonthWindow(now);
        const dayStart = new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
        );
        const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60_000);
        const [quota, counters] = await Promise.all([
          effectiveQuota(db, userId),
          first<{
            personalAgents: number;
            concurrentSessions: number;
            dailySessions: number;
            inputTokens: number;
            outputTokens: number;
            runtimeMs: number;
            toolCalls: number;
          }>(
            db,
            sql`select
                  (select count(*)::integer
                     from personal_agents
                    where owner_user_id = ${userId}
                      and not (
                        status = 'failed'
                        and ark_version = '0'
                        and ark_agent_id like 'pending:%'
                      )) as "personalAgents",
                  (select count(*)::integer
                     from sessions
                    where owner_user_id = ${userId}
                      and status in ('running', 'rescheduled')
                      and deletion_state <> 'deleted')
                    as "concurrentSessions",
                  (select count(*)::integer
                     from sessions
                    where owner_user_id = ${userId}
                      and created_at >= ${dayStart}
                      and created_at < ${dayEnd})
                    as "dailySessions",
                  coalesce(sum(quantity) filter (
                    where metric_type = 'input_tokens'
                  ), 0)::bigint as "inputTokens",
                  coalesce(sum(quantity) filter (
                    where metric_type = 'output_tokens'
                  ), 0)::bigint as "outputTokens",
                  coalesce(sum(quantity) filter (
                    where metric_type = 'runtime_ms'
                  ), 0)::bigint as "runtimeMs",
                  coalesce(sum(quantity) filter (
                    where metric_type = 'tool_calls'
                  ), 0)::bigint as "toolCalls"
                from usage_ledger
               where user_id = ${userId}
                 and recorded_at >= ${month.start}
                 and recorded_at < ${month.end}`,
          ),
        ]);
        if (!counters) throw new Error("Unable to read quota usage");
        const usage = {
          personalAgents: Number(counters.personalAgents),
          concurrentSessions: Number(counters.concurrentSessions),
          dailySessions: Number(counters.dailySessions),
          inputTokens: Number(counters.inputTokens),
          outputTokens: Number(counters.outputTokens),
          tokens: Number(counters.inputTokens) + Number(counters.outputTokens),
          runtimeMs: Number(counters.runtimeMs),
          toolCalls: Number(counters.toolCalls),
        };
        return {
          period: { startsAt: month.start, endsAt: month.end },
          quota,
          usage,
          exhausted: {
            personalAgents: usage.personalAgents >= quota.personalAgentLimit,
            concurrentSessions:
              usage.concurrentSessions >= quota.concurrentSessionLimit,
            dailySessions: usage.dailySessions >= quota.dailySessionLimit,
            monthlyTokens: usage.tokens >= quota.monthlyTokenLimit,
          },
        };
      },
      async record(input: {
        id: string;
        userId: string;
        arkSessionId: string;
        arkEventId: string;
        metricType: UsageMetricType;
        quantity: number;
        recordedAt?: Date;
      }) {
        const inserted = await rows(
          db,
          sql`insert into usage_ledger
                (id, user_id, ark_session_id, ark_event_id, metric_type,
                 quantity, recorded_at)
              values
                (${input.id}, ${input.userId}, ${input.arkSessionId},
                 ${input.arkEventId}, ${input.metricType}, ${input.quantity},
                 ${input.recordedAt ?? new Date()})
              on conflict
                (user_id, ark_session_id, ark_event_id, metric_type)
              do nothing
              returning id`,
        );
        return inserted.length === 1;
      },
    },

    quotaInterrupts: {
      claim(input: { workerId: string; limit: number; now?: Date }) {
        const now = input.now ?? new Date();
        const leaseExpiredAt = new Date(now.getTime() - JOB_LEASE_DURATION_MS);
        return db.transaction(async (transaction) => {
          await transaction.execute(
            sql`update quota_interrupt_jobs
                  set status = 'failed',
                      locked_at = null,
                      locked_by = null,
                      last_error = 'QUOTA_INTERRUPT_LEASE_EXPIRED',
                      updated_at = ${now}
                where status = 'running'
                  and locked_at <= ${leaseExpiredAt}
                  and attempts >= max_attempts`,
          );
          const claimed = await rows<QuotaInterruptJobRecord>(
            transaction,
            sql`with claimable as (
                  select id
                    from quota_interrupt_jobs
                   where (
                         (status = 'pending' and run_after <= ${now})
                         or
                         (status = 'running' and locked_at <= ${leaseExpiredAt})
                       )
                     and attempts < max_attempts
                   order by run_after, created_at, id
                   for update skip locked
                   limit ${input.limit}
                )
                update quota_interrupt_jobs job
                   set status = 'running',
                       attempts = job.attempts + 1,
                       locked_at = ${now},
                       locked_by = ${input.workerId},
                       updated_at = ${now}
                  from claimable
                 where job.id = claimable.id
                returning job.id, job.user_id as "userId",
                          job.session_id as "sessionId",
                          (select ark_session_id from sessions
                            where sessions.id = job.session_id
                              and sessions.owner_user_id = job.user_id)
                            as "arkSessionId",
                          job.month_start as "monthStart",
                          job.attempts,
                          job.max_attempts as "maxAttempts"`,
          );
          return claimed.map((job) => ({
            ...job,
            monthStart: new Date(job.monthStart),
          }));
        });
      },
      async succeed(id: string, workerId: string) {
        await db.execute(
          sql`update quota_interrupt_jobs
                set status = 'succeeded',
                    locked_at = null,
                    locked_by = null,
                    last_error = null,
                    updated_at = now()
              where id = ${id}
                and status = 'running'
                and locked_by = ${workerId}`,
        );
      },
      async retry(
        id: string,
        workerId: string,
        error: string,
        final: boolean,
        now = new Date(),
      ) {
        await db.execute(
          sql`update quota_interrupt_jobs
                set status = ${final ? "failed" : "pending"}::background_job_status,
                    run_after = case
                      when ${final} then run_after
                      else ${new Date(now.getTime() + 30_000)}
                    end,
                    locked_at = null,
                    locked_by = null,
                    last_error = ${error},
                    updated_at = ${now}
              where id = ${id}
                and status = 'running'
                and locked_by = ${workerId}`,
        );
      },
    },

    jobs: {
      async claim(input: {
        workerId: string;
        limit: number;
        now?: Date;
        types?: JobRecord["type"][];
      }) {
        const now = input.now ?? new Date();
        const leaseExpiredAt = new Date(now.getTime() - JOB_LEASE_DURATION_MS);
        const types = input.types ?? [
          "delete_session",
          "delete_artifact",
          "cleanup_artifact_object",
          "cleanup_upload",
          "reconcile_session",
          "reconcile_personal_agent",
        ];
        const jobTypes = sql.join(
          types.map((type) => sql`${type}`),
          sql`, `,
        );
        const claimed = await db.transaction(async (transaction) => {
          await transaction.execute(
            sql`with exhausted as (
                  select id
                    from background_jobs
                   where status = 'running'
                     and locked_at <= ${leaseExpiredAt}
                     and type in (${jobTypes})
                     and attempts >= max_attempts
                   for update skip locked
                ),
                failed_jobs as (
                  update background_jobs job
                   set status = 'failed',
                       locked_at = null,
                       locked_by = null,
                       last_error = case
                         when job.type = 'delete_session'
                           then 'SESSION_DELETE_LEASE_EXPIRED'
                         when job.type = 'delete_artifact'
                           then 'ARTIFACT_DELETE_LEASE_EXPIRED'
                         when job.type = 'cleanup_artifact_object'
                           then 'ARTIFACT_CLEANUP_LEASE_EXPIRED'
                         else coalesce(
                           job.last_error,
                           'Job lease expired after final attempt'
                         )
                       end,
                       updated_at = ${now}
                  from exhausted
                 where job.id = exhausted.id
                 returning job.id, job.owner_user_id, job.type
                ),
                failed_uploads as (
                  update session_inputs input
                     set status = 'failed',
                         last_error_code = 'Cleanup lease expired after final attempt',
                         updated_at = ${now}
                    from failed_jobs job
                   where job.type = 'cleanup_upload'
                     and input.id = job.id
                     and input.owner_user_id = job.owner_user_id
                     and input.session_id is null
                  returning input.id
                ),
                failed_artifacts as (
                  update artifacts artifact
                     set deletion_state = 'deletion_failed',
                         last_error_code = 'ARTIFACT_DELETE_LEASE_EXPIRED',
                         updated_at = ${now}
                    from failed_jobs job
                   where job.type = 'delete_artifact'
                     and artifact.id = job.id
                     and artifact.owner_user_id = job.owner_user_id
                  returning artifact.id
                ),
                failed_delete_sessions as (
                  update sessions session
                     set deletion_state = 'deletion_failed',
                         updated_at = ${now}
                    from failed_jobs job
                   where job.type = 'delete_session'
                     and session.id = job.id
                     and session.owner_user_id = job.owner_user_id
                  returning session.id
                ),
                failed_sessions as (
                  update sessions session
                     set status = 'terminated',
                         deletion_state = 'deletion_failed',
                         updated_at = ${now}
                    from failed_jobs job
                   where job.type = 'reconcile_session'
                     and session.id = job.id
                     and session.owner_user_id = job.owner_user_id
                  returning session.id, session.owner_user_id
                )
                update quota_reservations reservation
                   set status = 'consumed',
                       resolved_at = coalesce(reservation.resolved_at, ${now})
                  from failed_sessions session
                 where reservation.id = session.id
                   and reservation.user_id = session.owner_user_id`,
          );
          return rows<JobRecord>(
            transaction,
            sql`with claimable as (
                  select id
                    from background_jobs
                   where (
                         (status = 'pending' and run_after <= ${now})
                         or
                         (status = 'running' and locked_at <= ${leaseExpiredAt})
                       )
                     and type in (${jobTypes})
                     and attempts < max_attempts
                   order by priority asc, run_after asc, created_at asc, id asc
                   for update skip locked
                   limit ${input.limit}
                )
                update background_jobs job
                   set status = 'running',
                       locked_at = ${now},
                       locked_by = ${input.workerId},
                       attempts = job.attempts + 1,
                       updated_at = ${now}
                  from claimable
                 where job.id = claimable.id
                returning job.id,
                          job.owner_user_id as "ownerUserId",
                          job.type,
                          job.status,
                          job.priority,
                          job.payload,
                          job.attempts,
                          job.max_attempts as "maxAttempts",
                          job.run_after as "runAfter",
                          job.locked_at as "lockedAt",
                          job.locked_by as "lockedBy",
                          job.created_at as "createdAt"`,
          );
        });
        return claimed.sort(
          (left, right) =>
            left.priority - right.priority ||
            left.runAfter.getTime() - right.runAfter.getTime() ||
            left.createdAt.getTime() - right.createdAt.getTime() ||
            left.id.localeCompare(right.id),
        );
      },
      async succeed(id: string, workerId: string) {
        await db.execute(
          sql`update background_jobs
                set status = 'succeeded',
                    locked_at = null,
                    locked_by = null,
                    last_error = null,
                    updated_at = now()
              where id = ${id}
                and status = 'running'
                and locked_by = ${workerId}`,
        );
      },
      async succeedArtifactCleanup(
        id: string,
        workerId: string,
        cleanupGeneration: number,
      ) {
        const updated = await rows(
          db,
          sql`update background_jobs
                set status = 'succeeded',
                    locked_at = null,
                    locked_by = null,
                    last_error = null,
                    updated_at = now()
              where id = ${id}
                and type = 'cleanup_artifact_object'
                and status = 'running'
                and locked_by = ${workerId}
                and coalesce(
                      (payload ->> 'cleanupGeneration')::integer,
                      0
                    ) = ${cleanupGeneration}
              returning id`,
        );
        return updated.length === 1;
      },
      async deferArtifactCleanup(
        id: string,
        workerId: string,
        cleanupGeneration: number,
      ) {
        const updated = await rows(
          db,
          sql`update background_jobs
                set status = 'pending',
                    attempts = greatest(attempts - 1, 0),
                    run_after = case
                      when payload ? 'uploadInProgressUntil'
                        then greatest(
                          now(),
                          (payload ->> 'uploadInProgressUntil')::timestamptz
                        )
                      else now()
                    end,
                    locked_at = null,
                    locked_by = null,
                    last_error = null,
                    updated_at = now()
              where id = ${id}
                and type = 'cleanup_artifact_object'
                and status = 'running'
                and locked_by = ${workerId}
                and coalesce(
                      (payload ->> 'cleanupGeneration')::integer,
                      0
                    ) = ${cleanupGeneration}
              returning id`,
        );
        return updated.length === 1;
      },
      async retryArtifactCleanup(
        id: string,
        workerId: string,
        cleanupGeneration: number,
        error: string,
        final: boolean,
        now = new Date(),
      ) {
        return db.transaction(async (transaction) => {
          const leased = await first<{ attempts: number }>(
            transaction,
            sql`select attempts
                  from background_jobs
                 where id = ${id}
                   and type = 'cleanup_artifact_object'
                   and status = 'running'
                   and locked_by = ${workerId}
                   and coalesce(
                         (payload ->> 'cleanupGeneration')::integer,
                         0
                       ) = ${cleanupGeneration}
                 for update`,
          );
          if (!leased) return false;
          const runAfter = new Date(
            now.getTime() + Math.min(60_000, 2 ** leased.attempts * 100),
          );
          const updated = await rows(
            transaction,
            sql`update background_jobs
                  set status = ${final ? "failed" : "pending"}::background_job_status,
                      run_after = ${runAfter},
                      locked_at = null,
                      locked_by = null,
                      last_error = ${artifactCleanupErrorCode(error)},
                      updated_at = ${now}
                where id = ${id}
                  and type = 'cleanup_artifact_object'
                  and status = 'running'
                  and locked_by = ${workerId}
                  and coalesce(
                        (payload ->> 'cleanupGeneration')::integer,
                        0
                      ) = ${cleanupGeneration}
                returning id`,
          );
          return updated.length === 1;
        });
      },
      async updatePayload(
        id: string,
        workerId: string,
        payload: Record<string, unknown>,
      ) {
        await requiredFirst(
          db,
          sql`update background_jobs
                set payload = ${JSON.stringify(payload)}::jsonb,
                    updated_at = now()
              where id = ${id}
                and type = 'delete_session'
                and status = 'running'
                and locked_by = ${workerId}
              returning id`,
        );
      },
      async retry(
        id: string,
        workerId: string,
        error: string,
        final: boolean,
        now = new Date(),
      ) {
        const artifactError = artifactDeletionErrorCode(error);
        const artifactCleanupError = artifactCleanupErrorCode(error);
        const sessionError = sessionDeletionErrorCode(error);
        await db.transaction(async (transaction) => {
          const leased = await first<{ attempts: number }>(
            transaction,
            sql`select attempts
                  from background_jobs
                 where id = ${id}
                   and status = 'running'
                   and locked_by = ${workerId}
                 for update`,
          );
          if (!leased) return;
          const runAfter = new Date(
            now.getTime() + Math.min(60_000, 2 ** leased.attempts * 100),
          );
          const updated = await first<{
            id: string;
            ownerUserId: string | null;
            type: JobRecord["type"];
          }>(
            transaction,
            sql`update background_jobs
                  set status = ${final ? "failed" : "pending"}::background_job_status,
                      run_after = ${runAfter},
                      locked_at = null,
                      locked_by = null,
                      last_error = case
                        when type = 'delete_session' then ${sessionError}
                        when type = 'delete_artifact' then ${artifactError}
                        when type = 'cleanup_artifact_object'
                          then ${artifactCleanupError}
                        else ${error}
                      end,
                      updated_at = ${now}
                where id = ${id}
                  and status = 'running'
                  and locked_by = ${workerId}
                returning id, owner_user_id as "ownerUserId", type`,
          );
          if (updated?.type === "cleanup_upload" && updated.ownerUserId) {
            await transaction.execute(
              sql`update session_inputs
                    set status = ${final ? "failed" : "deleting"}::upload_status,
                        last_error_code = ${error},
                        updated_at = ${now}
                  where id = ${updated.id}
                    and owner_user_id = ${updated.ownerUserId}
                    and session_id is null`,
            );
            return;
          }
          if (updated?.type === "delete_artifact" && updated.ownerUserId) {
            await transaction.execute(
              sql`update artifacts
                    set deletion_state = 'deletion_failed',
                        last_error_code = ${artifactError},
                        updated_at = ${now}
                  where id = ${updated.id}
                    and owner_user_id = ${updated.ownerUserId}`,
            );
            return;
          }
          if (updated?.type === "delete_session" && updated.ownerUserId) {
            await transaction.execute(
              sql`update sessions
                    set deletion_state = 'deletion_failed',
                        updated_at = ${now}
                  where id = ${updated.id}
                    and owner_user_id = ${updated.ownerUserId}`,
            );
            return;
          }
          if (
            !final ||
            updated?.type !== "reconcile_session" ||
            !updated.ownerUserId
          ) {
            return;
          }
          await transaction.execute(
            sql`update sessions
                  set status = 'terminated',
                      deletion_state = 'deletion_failed',
                      updated_at = ${now}
                where id = ${updated.id}
                  and owner_user_id = ${updated.ownerUserId}`,
          );
          await transaction.execute(
            sql`update quota_reservations
                  set status = 'consumed',
                      resolved_at = coalesce(resolved_at, ${now})
                where id = ${updated.id}
                  and user_id = ${updated.ownerUserId}`,
          );
        });
      },
    },
  };
}

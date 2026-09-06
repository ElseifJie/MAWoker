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
  archivedAt: Date | null;
  deletionState: "none" | "pending" | "deletion_failed" | "deleted";
  lastEventAt: Date | null;
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
  title, status, archived_at as "archivedAt",
  deletion_state as "deletionState", last_event_at as "lastEventAt",
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

interface JobRecord extends Row {
  id: string;
  ownerUserId: string | null;
  type:
    | "delete_session"
    | "delete_artifact"
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

const JOB_LEASE_DURATION_MS = 5 * 60 * 1_000;

export class QuotaExceededError extends Error {
  constructor(
    public readonly dimension:
      "concurrent_sessions" | "daily_sessions" | "monthly_tokens",
  ) {
    super(`Quota exceeded: ${dimension}`);
    this.name = "QuotaExceededError";
  }
}

async function rows<T extends Row>(
  database: DatabaseClient,
  query: SQL,
): Promise<T[]> {
  const result = await database.execute<T>(query);
  return result.rows;
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
  return quota;
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
        return rows<{
          id: string;
          email: string;
          status: "active" | "disabled";
          defaultAgentId: string | null;
        }>(
          db,
          sql`select u.id, u.email, u.status,
                     uda.platform_agent_id as "defaultAgentId"
                from users u
                left join user_default_agents uda on uda.user_id = u.id
               where u.role = 'user'
               order by u.created_at asc, u.id asc`,
        );
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
          return first<{
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
    sessions: tenantRepository(db, sql.raw("sessions")),
    sessionLifecycle: {
      prepareCreate(input: SessionRecord) {
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

          const quota = await effectiveQuota(transaction, input.ownerUserId);
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
                      and recorded_at >= date_trunc(
                        'month',
                        ${input.createdAt}::timestamptz
                      ))
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

          const quota = await effectiveQuota(transaction, userId);
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
                      and recorded_at >= date_trunc('month', now()))
                    as "monthlyTokens"`,
          );
          if (!usage) throw new Error("Unable to read message quota");
          if (usage.monthlyTokens >= quota.monthlyTokenLimit) {
            throw new QuotaExceededError("monthly_tokens");
          }
          if (session.status !== "idle") {
            if (session.status === "terminated") {
              return {
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
                  returning ${sessionSelection}`,
            );
            return {
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
                returning ${sessionSelection}`,
          );
          return {
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
    sessionInputs: tenantRepository(db, sql.raw("session_inputs")),
    artifacts: tenantRepository(db, sql.raw("artifacts")),

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
                      and recorded_at >= date_trunc('month', ${now}::timestamptz))
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
      async record(input: {
        id: string;
        userId: string;
        arkSessionId: string;
        arkEventId: string;
        metricType:
          "input_tokens" | "output_tokens" | "runtime_ms" | "tool_calls";
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
                       last_error = coalesce(
                         job.last_error,
                         'Job lease expired after final attempt'
                       ),
                       updated_at = ${now}
                  from exhausted
                 where job.id = exhausted.id
                 returning job.id, job.owner_user_id, job.type
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
      async retry(
        id: string,
        workerId: string,
        error: string,
        final: boolean,
        now = new Date(),
      ) {
        const runAfter = new Date(
          now.getTime() + Math.min(60_000, 2 ** 10 * 100),
        );
        await db.transaction(async (transaction) => {
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
                      last_error = ${error},
                      updated_at = ${now}
                where id = ${id}
                  and status = 'running'
                  and locked_by = ${workerId}
                returning id, owner_user_id as "ownerUserId", type`,
          );
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

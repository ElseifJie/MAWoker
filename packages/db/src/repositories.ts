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
    | "reconcile_session";
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
        return first(
          db,
          sql`select * from platform_agents where id = ${id} limit 1`,
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
    },

    personalAgents: tenantRepository(db, sql.raw("personal_agents")),
    sessions: tenantRepository(db, sql.raw("sessions")),
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
      async claim(input: { workerId: string; limit: number; now?: Date }) {
        const now = input.now ?? new Date();
        const claimed = await rows<JobRecord>(
          db,
          sql`with claimable as (
                select id
                  from background_jobs
                 where status = 'pending'
                   and run_after <= ${now}
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
        return claimed.sort(
          (left, right) =>
            left.priority - right.priority ||
            left.runAfter.getTime() - right.runAfter.getTime() ||
            left.createdAt.getTime() - right.createdAt.getTime() ||
            left.id.localeCompare(right.id),
        );
      },
    },
  };
}

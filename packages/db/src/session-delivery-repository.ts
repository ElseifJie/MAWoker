import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { appendAccountChange } from "./sync-repository.js";

interface Database {
  execute<T extends Record<string, unknown> = Record<string, unknown>>(
    query: SQL,
  ): PromiseLike<{ rows: T[] }>;
  transaction<T>(callback: (transaction: Database) => Promise<T>): Promise<T>;
}

export interface Observation {
  boundaryEventId: string;
  inputEventId: string;
  outcome: "completed" | "waiting" | "failed" | "confirming";
  summary: string;
  expectedNames: string[];
  startedAt: Date;
  endedAt: Date;
  usageState: "pending" | "complete";
}
export interface Turn extends Observation, Record<string, unknown> {
  id: string;
  ownerUserId: string;
  sessionId: string;
  artifactState: "pending" | "syncing" | "synced" | "failed" | "none";
  artifactIds: string[];
  errorCode: string | null;
  retryUntil: Date;
  createdAt: Date;
  updatedAt: Date;
}
export interface Notification extends Record<string, unknown> {
  id: string;
  ownerUserId: string;
  sessionId: string;
  turnId: string;
  kind: "completed" | "failed" | "needs_action" | "sync_failed";
  readAt: Date | null;
  createdAt: Date;
}
const turnSelection = sql`id,owner_user_id as "ownerUserId",session_id as "sessionId",
  boundary_event_id as "boundaryEventId",input_event_id as "inputEventId",outcome,summary,
  expected_names as "expectedNames",started_at as "startedAt",ended_at as "endedAt",
  artifact_state as "artifactState",artifact_ids as "artifactIds",usage_state as "usageState",
  error_code as "errorCode",retry_until as "retryUntil",created_at as "createdAt",updated_at as "updatedAt"`;

function dates(row: Turn): Turn {
  return {
    ...row,
    startedAt: new Date(row.startedAt),
    endedAt: new Date(row.endedAt),
    retryUntil: new Date(row.retryUntil),
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

export function createSessionDeliveryRepository(db: Database) {
  async function write<T>(
    signal: AbortSignal | undefined,
    callback: (transaction: Database) => Promise<T>,
  ) {
    signal?.throwIfAborted();
    return db.transaction(async (transaction) => {
      // PostgreSQL bounds lock waits; checking again before commit prevents a
      // cancelled operation from publishing a late result after the wait.
      await transaction.execute(sql`set local statement_timeout='10000'`);
      await transaction.execute(sql`set local lock_timeout='5000'`);
      signal?.throwIfAborted();
      const result = await callback(transaction);
      signal?.throwIfAborted();
      return result;
    });
  }
  async function notify(
    transaction: Database,
    turn: Turn,
    kind: Notification["kind"],
  ) {
    const inserted = await transaction.execute<{ id: string }>(
      sql`insert into user_notifications
        (id,owner_user_id,session_id,turn_id,kind)
        values(${randomUUID()},${turn.ownerUserId},${turn.sessionId},${turn.id},${kind})
        on conflict (owner_user_id,session_id,turn_id,kind) do nothing
        returning id`,
    );
    const row = inserted.rows[0];
    if (row) {
      await appendAccountChange(transaction, {
        ownerUserId: turn.ownerUserId,
        resourceType: "notification",
        resourceId: row.id,
      });
    }
  }
  async function ownedSession(
    transaction: Database,
    userId: string,
    sessionId: string,
  ) {
    const result = await transaction.execute<{
      id: string;
      arkSessionId: string;
      blocked: boolean;
    }>(sql`select session.id,session.ark_session_id as "arkSessionId",
      (session.message_unknown_outcome or session.message_start_pending or session.message_in_flight_count>0
       or exists(select 1 from message_submissions ms where ms.session_id=session.id and ms.status in ('queued','sending','unknown'))) as blocked
      from sessions session join users u on u.id=session.owner_user_id
      where session.id=${sessionId} and session.owner_user_id=${userId}
      and session.deletion_state='none' and session.ark_session_id not like 'pending:%'
      and u.status='active' for update of session`);
    return result.rows[0];
  }
  async function lease(
    transaction: Database,
    userId: string,
    turnId: string,
    workerId: string,
    generation: number,
  ) {
    const result = await transaction.execute(sql`select id from background_jobs
      where id=${turnId} and owner_user_id=${userId} and type='reconcile_session'
      and payload->>'operation'='sync_artifacts' and status='running'
      and locked_by=${workerId} and lease_generation=${generation}
      and locked_at>clock_timestamp()-interval '5 minutes' for update`);
    return result.rows.length > 0;
  }
  async function findTurn(transaction: Database, userId: string, id: string) {
    const result =
      await transaction.execute<Turn>(sql`select ${turnSelection} from session_turns
      where id=${id} and owner_user_id=${userId}`);
    return result.rows[0] ? dates(result.rows[0]) : undefined;
  }

  return {
    async recoverSyncJobs(now: Date, signal?: AbortSignal) {
      await write(signal, async (transaction) => {
        const result =
          await transaction.execute<Turn>(sql`select ${turnSelection}
          from session_turns where artifact_state in ('pending','syncing')
          and exists(select 1 from background_jobs j where j.id=session_turns.id
            and j.payload->>'operation'='sync_artifacts'
            and (j.status='failed' or (j.status='running' and j.attempts>=j.max_attempts
              and j.locked_at<clock_timestamp()-interval '5 minutes')))
          limit 25`);
        for (const row of result.rows) {
          signal?.throwIfAborted();
          const turn = dates(row);
          const session = await ownedSession(
            transaction,
            turn.ownerUserId,
            turn.sessionId,
          );
          if (!session) continue;
          const job =
            await transaction.execute(sql`select id from background_jobs where id=${turn.id}
            and (status='failed' or (status='running' and attempts>=max_attempts
              and locked_at<clock_timestamp()-interval '5 minutes')) for update`);
          if (!job.rows.length) continue;
          await transaction.execute(sql`update session_turns set artifact_state='failed',
            error_code='ARTIFACT_SYNC_ATTEMPTS_EXHAUSTED',updated_at=${now}
            where id=${turn.id} and artifact_state in ('pending','syncing')`);
          await transaction.execute(sql`update background_jobs set status='failed',locked_by=null,
            locked_at=null,last_error='ARTIFACT_SYNC_ATTEMPTS_EXHAUSTED',updated_at=${now} where id=${turn.id}`);
          await notify(transaction, turn, "sync_failed");
        }
      });
    },
    async listDiscoveryCandidates(input: {
      now: Date;
      limit: number;
      signal?: AbortSignal;
    }) {
      return write(input.signal, async (transaction) => {
        const result = await transaction.execute<{
          ownerUserId: string;
          sessionId: string;
          arkSessionId: string;
        }>(sql`select s.owner_user_id as "ownerUserId",s.id as "sessionId",s.ark_session_id as "arkSessionId"
          from sessions s join users u on u.id=s.owner_user_id
          left join session_event_cursors c on c.session_id=s.id
          where s.deletion_state='none' and s.ark_session_id not like 'pending:%' and u.status='active'
          and (s.delivery_checked_at is null or s.delivery_checked_at<${new Date(input.now.getTime() - 60_000)})
          and (c.history_next_attempt_at is null or c.history_next_attempt_at<=${input.now}
            or (not c.history_repair_required and c.history_scanned_at is not null))
          order by s.delivery_checked_at asc nulls first,s.updated_at,s.id limit ${Math.min(input.limit, 25)}
          for update of s skip locked`);
        for (const candidate of result.rows) {
          input.signal?.throwIfAborted();
          await transaction.execute(
            sql`update sessions set delivery_checked_at=${input.now} where id=${candidate.sessionId}`,
          );
        }
        return result.rows;
      });
    },
    async markDiscoveryChecked(
      userId: string,
      sessionId: string,
      now: Date,
      success: boolean,
      signal?: AbortSignal,
    ) {
      // A failed upstream read gets a longer delay without changing task state.
      const checkedAt = success ? now : new Date(now.getTime() + 60_000);
      await write(signal, async (transaction) => {
        await transaction.execute(sql`update sessions set delivery_checked_at=${checkedAt}
          where id=${sessionId} and owner_user_id=${userId} and deletion_state='none'
          and delivery_checked_at=${now}`);
      });
    },
    async recordObservations(
      userId: string,
      sessionId: string,
      observations: Observation[],
      input: {
        upstreamStatus: string;
        now: Date;
        retryWindowMs: number;
        signal?: AbortSignal;
      },
    ) {
      await write(input.signal, async (transaction) => {
        const session = await ownedSession(transaction, userId, sessionId);
        if (!session) return;
        for (const observation of observations) {
          input.signal?.throwIfAborted();
          const id = randomUUID();
          const result =
            await transaction.execute<Turn>(sql`insert into session_turns
            (id,owner_user_id,session_id,boundary_event_id,input_event_id,outcome,summary,expected_names,
             started_at,ended_at,artifact_state,usage_state,retry_until,created_at,updated_at)
            values(${id},${userId},${sessionId},${observation.boundaryEventId},${observation.inputEventId},
              ${observation.outcome},${observation.summary},${JSON.stringify(observation.expectedNames)}::jsonb,
              ${observation.startedAt},${observation.endedAt},
              ${observation.outcome === "completed" ? "pending" : "none"},${observation.usageState},
              ${new Date(input.now.getTime() + input.retryWindowMs)},${input.now},${input.now})
            on conflict(owner_user_id,session_id,boundary_event_id) do update set
              usage_state=case when excluded.usage_state='complete' then 'complete' else session_turns.usage_state end,
              outcome=case when session_turns.outcome='confirming' then excluded.outcome else session_turns.outcome end,
              artifact_state=case when session_turns.outcome='confirming' and excluded.outcome='completed'
                then 'pending' else session_turns.artifact_state end,
              summary=excluded.summary,expected_names=excluded.expected_names
            returning ${turnSelection}`);
          const turn = dates(result.rows[0]!);
          // Link the observed turn back to the Run created with its durable
          // submission. The status guard prevents a repeated discovery scan
          // from bumping the version once the Run already reached the target.
          const linkedRun = await transaction.execute<{
            id: string;
            version: number;
          }>(sql`update runs r
            set turn_id = ${turn.id},
                started_at = coalesce(r.started_at, ${turn.startedAt}::timestamptz),
                ended_at = case
                  when ${turn.outcome}::text in ('completed','failed')
                    then coalesce(r.ended_at, ${turn.endedAt}::timestamptz)
                  else r.ended_at
                end,
                status = case
                  when r.status in ('completed','failed','canceled') then r.status
                  when ${turn.outcome}::text = 'completed' then 'completed'::run_status
                  when ${turn.outcome}::text = 'failed' then 'failed'::run_status
                  when ${turn.outcome}::text = 'waiting' then 'waiting_user'::run_status
                  else r.status
                end,
                version = r.version + 1,
                updated_at = ${input.now}
            where r.owner_user_id = ${userId}
              and r.submission_id = (
                select ms.submission_id from message_submissions ms
                 where ms.owner_user_id = ${userId}
                   and ms.upstream_event_id = ${turn.inputEventId}
                 limit 1
              )
              and (
                r.turn_id is distinct from ${turn.id}
                or (
                  r.status not in ('completed','failed','canceled')
                  and ${turn.outcome}::text in ('completed','failed','waiting')
                  and r.status <> case
                        when ${turn.outcome}::text = 'completed' then 'completed'::run_status
                        when ${turn.outcome}::text = 'failed' then 'failed'::run_status
                        else 'waiting_user'::run_status
                      end
                )
              )
            returning id, version`);
          const linked = linkedRun.rows[0];
          if (linked) {
            await appendAccountChange(transaction, {
              ownerUserId: userId,
              resourceType: "run",
              resourceId: linked.id,
              revision: linked.version,
              now: input.now,
            });
          }
          if (
            turn.outcome === "completed" &&
            turn.artifactState === "pending"
          ) {
            await transaction.execute(sql`insert into background_jobs
              (id,owner_user_id,type,status,priority,payload,max_attempts,run_after)
              values(${turn.id},${userId},'reconcile_session','pending',150,
                ${JSON.stringify({ operation: "sync_artifacts", sessionId, turnId: turn.id })}::jsonb,100,${input.now})
              on conflict(id) do nothing`);
          }
          if (
            !session.blocked &&
            (input.upstreamStatus === "idle" ||
              input.upstreamStatus === "terminated")
          ) {
            if (turn.outcome === "failed")
              await notify(transaction, turn, "failed");
            const superseded = observations.some(
              (other) =>
                other.startedAt.getTime() === turn.startedAt.getTime() &&
                other.endedAt > turn.endedAt &&
                (other.outcome === "completed" || other.outcome === "failed"),
            );
            if (
              (turn.outcome === "waiting" || turn.outcome === "confirming") &&
              !superseded
            ) {
              await notify(transaction, turn, "needs_action");
            }
          }
        }
        await transaction.execute(sql`delete from user_notifications n
          using session_turns stale where n.turn_id=stale.id and n.owner_user_id=${userId}
          and n.session_id=${sessionId} and n.kind='needs_action'
          and (stale.outcome in ('completed','failed') or exists(
            select 1 from session_turns final where final.session_id=stale.session_id
            and final.started_at=stale.started_at and final.ended_at>stale.ended_at
            and final.outcome in ('completed','failed')))`);
      });
    },
    async listTurns(userId: string, sessionId: string): Promise<Turn[]> {
      const result =
        await db.execute<Turn>(sql`select ${turnSelection} from session_turns
        where owner_user_id=${userId} and session_id=${sessionId}
        and exists(select 1 from sessions where id=${sessionId} and owner_user_id=${userId} and deletion_state='none')
        order by ended_at desc,created_at desc limit 50`);
      return result.rows.map(dates);
    },
    async listNotifications(
      userId: string,
      limit: number,
    ): Promise<Notification[]> {
      const result =
        await db.execute<Notification>(sql`select id,owner_user_id as "ownerUserId",
        session_id as "sessionId",turn_id as "turnId",kind,read_at as "readAt",created_at as "createdAt"
        from user_notifications where owner_user_id=${userId}
        and exists(select 1 from sessions s where s.id=user_notifications.session_id and s.deletion_state='none')
        order by created_at desc,id desc limit ${Math.max(1, Math.min(limit, 100))}`);
      return result.rows.map((row) => ({
        ...row,
        readAt: row.readAt ? new Date(row.readAt) : null,
        createdAt: new Date(row.createdAt),
      }));
    },
    async markNotificationRead(userId: string, id: string) {
      return db.transaction(async (transaction) => {
        const result = await transaction.execute<{ id: string }>(
          sql`update user_notifications set read_at=coalesce(read_at,now())
              where id=${id} and owner_user_id=${userId} returning id`,
        );
        const row = result.rows[0];
        if (!row) return false;
        await appendAccountChange(transaction, {
          ownerUserId: userId,
          resourceType: "notification",
          resourceId: row.id,
        });
        return true;
      });
    },
    async claimSync(
      userId: string,
      id: string,
      workerId: string,
      generation: number,
      signal?: AbortSignal,
    ) {
      return write(signal, async (transaction) => {
        const turn = await findTurn(transaction, userId, id);
        if (!turn) return;
        const session = await ownedSession(transaction, userId, turn.sessionId);
        if (
          !session ||
          !(await lease(transaction, userId, id, workerId, generation))
        )
          return;
        const pause = await transaction.execute<{
          windowMs: string | null;
        }>(sql`select
          payload->>'artifactRetryWindowMs' as "windowMs" from background_jobs
          where id=${id} and last_error='ARTIFACT_SYNC_PAUSED'`);
        if (pause.rows[0]?.windowMs) {
          const resumed = await transaction.execute<{
            retryUntil: Date;
          }>(sql`update session_turns set
            retry_until=greatest(retry_until,clock_timestamp()+${pause.rows[0].windowMs}::bigint*interval '1 millisecond')
            where id=${id} returning retry_until as "retryUntil"`);
          turn.retryUntil = new Date(resumed.rows[0]!.retryUntil);
        }
        const inputs = await transaction.execute<{
          fileId: string;
        }>(sql`select ark_file_id as "fileId"
          from session_inputs where session_id=${turn.sessionId} and owner_user_id=${userId}`);
        // Timestamps alone cannot order a next input tied with the terminal
        // event. Use persisted upstream position; when that evidence is absent,
        // keep the file boundary conservative rather than refreshing old turns.
        const next = await transaction.execute<{
          startedAt: Date;
        }>(sql`select min(started_at) as "startedAt" from (
          select started_at from session_turns where session_id=${turn.sessionId} and owner_user_id=${userId}
            and started_at>${turn.endedAt}
          union all select input.occurred_at from session_events input
            left join session_events boundary on boundary.session_id=input.session_id
              and boundary.event_id=${turn.boundaryEventId}
            where input.session_id=${turn.sessionId} and input.source_type='user.message'
              and (input.occurred_at>${turn.endedAt} or (
                input.occurred_at=${turn.endedAt} and input.event_id<>${turn.inputEventId}
                and (input.history_position>boundary.history_position
                  or input.history_position is null or boundary.history_position is null)
              ))
        ) later`);
        if (
          turn.artifactState === "pending" ||
          turn.artifactState === "failed" ||
          turn.artifactState === "syncing"
        ) {
          await transaction.execute(
            sql`update session_turns set artifact_state='syncing',updated_at=now() where id=${id}`,
          );
        }
        return {
          turn,
          arkSessionId: session.arkSessionId,
          blocked: session.blocked,
          nextStartedAt: next.rows[0]?.startedAt
            ? new Date(next.rows[0].startedAt)
            : null,
          inputFileIds: inputs.rows.map((row) => row.fileId),
        };
      });
    },
    async finishSync(
      userId: string,
      id: string,
      workerId: string,
      generation: number,
      result: {
        artifactState: "pending" | "synced" | "failed";
        artifactIds: string[];
        errorCode: string | null;
        now: Date;
        signal?: AbortSignal;
      },
    ) {
      return write(result.signal, async (transaction) => {
        const turn = await findTurn(transaction, userId, id);
        if (!turn) return false;
        const session = await ownedSession(transaction, userId, turn.sessionId);
        if (
          !session ||
          session.blocked ||
          !(await lease(transaction, userId, id, workerId, generation))
        )
          return false;
        // Every referenced file must still be available to this session and owner.
        if (result.artifactIds.length) {
          const drives =
            await transaction.execute(sql`select id from drive_files where
            id in (select drive_file_id from artifacts where
              id in (${sql.join(
                result.artifactIds.map((file) => sql`${file}::uuid`),
                sql`,`,
              )}))
            and owner_user_id=${userId} and deletion_state='none' and orphaned_at is null
            order by id for update`);
          const files =
            await transaction.execute(sql`select id from artifacts where
            id in (${sql.join(
              result.artifactIds.map((file) => sql`${file}::uuid`),
              sql`,`,
            )})
            and owner_user_id=${userId} and session_id=${turn.sessionId} and deletion_state='none'
            order by id for update`);
          if (
            !drives.rows.length ||
            files.rows.length !== new Set(result.artifactIds).size
          )
            return false;
          const unavailable =
            await transaction.execute(sql`select id from artifacts where
            id in (${sql.join(
              result.artifactIds.map((file) => sql`${file}::uuid`),
              sql`,`,
            )})
            and not exists(select 1 from drive_files d where d.id=artifacts.drive_file_id
              and d.owner_user_id=${userId} and d.deletion_state='none' and d.orphaned_at is null)`);
          if (unavailable.rows.length) return false;
        }
        await transaction.execute(sql`update session_turns set artifact_state=${result.artifactState},
          artifact_ids=${JSON.stringify(result.artifactIds)}::jsonb,error_code=${result.errorCode},updated_at=${result.now}
          where id=${id} and owner_user_id=${userId}`);
        if (result.artifactState === "synced")
          await notify(transaction, turn, "completed");
        if (result.artifactState === "failed")
          await notify(transaction, turn, "sync_failed");
        return true;
      });
    },
    async requestSyncRetry(
      userId: string,
      id: string,
      now: Date,
      windowMs: number,
      sessionId?: string,
    ) {
      return write(undefined, async (transaction) => {
        const turn = await findTurn(transaction, userId, id);
        if (
          !turn ||
          turn.outcome !== "completed" ||
          (sessionId !== undefined && turn.sessionId !== sessionId)
        )
          return false;
        const session = await ownedSession(transaction, userId, turn.sessionId);
        if (!session || session.blocked) return false;
        const job =
          await transaction.execute(sql`select id from background_jobs where id=${id}
          and owner_user_id=${userId} and status in ('succeeded','failed') for update`);
        if (!job.rows.length || turn.artifactState === "synced") return false;
        await transaction.execute(sql`update session_turns set artifact_state='pending',error_code=null,
          retry_until=${new Date(now.getTime() + windowMs)},updated_at=${now} where id=${id}`);
        await transaction.execute(sql`update background_jobs set status='pending',attempts=0,
          locked_at=null,locked_by=null,run_after=${now},last_error=null,updated_at=${now} where id=${id}`);
        return true;
      });
    },
  };
}

import { sql, type SQL } from "drizzle-orm";

type Row = Record<string, unknown>;
interface Database {
  execute<T extends Row = Row>(query: SQL): PromiseLike<{ rows: T[] }>;
  transaction<T>(callback: (transaction: Database) => Promise<T>): Promise<T>;
}
export interface EventInput {
  eventId: string;
  sourceType: string;
  type: string;
  occurredAt: Date;
  payload: Record<string, unknown>;
  historyPosition?: number;
}
export interface EventRow extends EventInput, Row {
  localSequence: string;
}
export interface HistoryRow extends Row {
  complete: boolean;
  repairRequired: boolean;
  scannedAt: Date | null;
  persistedSequence: string;
  scanGeneration: number;
}

const selection = sql`event.event_id as "eventId", event.source_type as "sourceType",
  event.type, event.occurred_at as "occurredAt", event.payload,
  event.local_sequence::text as "localSequence"`;

function staleScan() {
  return Object.assign(new Error("History scan was superseded"), {
    code: "EVENT_HISTORY_SCAN_STALE",
  });
}

export function createSessionEventRepository(db: Database) {
  async function lock(
    transaction: Database,
    userId: string,
    id: string,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const result = await transaction.execute(sql`select id from sessions
      where id=${id} and owner_user_id=${userId} and deletion_state='none' for update`);
    signal?.throwIfAborted();
    if (!result.rows.length) return false;
    await transaction.execute(sql`insert into session_event_cursors (session_id)
      values (${id}) on conflict (session_id) do nothing`);
    signal?.throwIfAborted();
    return true;
  }

  async function state(userId: string, id: string): Promise<HistoryRow> {
    const result = await db.execute<HistoryRow>(sql`select
      (cursor.history_backfilled_at is not null and not coalesce(cursor.history_repair_required,true)) as complete,
      coalesce(cursor.history_repair_required,true) as "repairRequired",
      cursor.history_scanned_at as "scannedAt",
      coalesce(cursor.persisted_sequence,0)::text as "persistedSequence",
      coalesce(cursor.history_scan_generation,0) as "scanGeneration"
      from sessions session left join session_event_cursors cursor on cursor.session_id=session.id
      where session.id=${id} and session.owner_user_id=${userId} and session.deletion_state='none'`);
    const row = result.rows[0];
    if (!row)
      throw Object.assign(new Error("Resource not found"), {
        name: "ResourceNotFoundError",
      });
    return {
      ...row,
      scannedAt: row.scannedAt === null ? null : new Date(row.scannedAt),
    };
  }

  async function list(
    userId: string,
    id: string,
    after?: string,
    limit?: number,
  ): Promise<EventRow[]> {
    const result = await db.execute<EventRow>(sql`select ${selection}
      from session_events event join sessions session on session.id=event.session_id
      where session.id=${id} and session.owner_user_id=${userId} and session.deletion_state='none'
      ${after === undefined ? sql`` : sql`and event.local_sequence > ${after}::bigint`}
      order by ${
        after === undefined
          ? sql`event.occurred_at, event.history_position nulls last, event.local_sequence`
          : sql`event.local_sequence`
      }
      ${limit === undefined ? sql`` : sql`limit ${limit}`}`);
    return result.rows.map((row) => ({
      ...row,
      occurredAt: new Date(row.occurredAt),
    }));
  }

  return {
    async listHistoryReconcilable(input: {
      now: Date;
      limit: number;
      cooldownMs: number;
      signal?: AbortSignal;
    }) {
      return db.transaction(async (transaction) => {
        input.signal?.throwIfAborted();
        const selected = await transaction.execute<{
          sessionId: string;
          ownerUserId: string;
          arkSessionId: string;
        }>(sql`select session.id as "sessionId",session.owner_user_id as "ownerUserId",
          session.ark_session_id as "arkSessionId" from sessions session
          join users owner on owner.id=session.owner_user_id
          left join session_event_cursors cursor on cursor.session_id=session.id
          where owner.status='active' and owner.role='user' and session.deletion_state='none'
            and session.ark_session_id not like 'pending:%'
            and (cursor.history_next_attempt_at is null or cursor.history_next_attempt_at <= ${input.now})
          order by cursor.history_attempted_at nulls first, session.created_at, session.id
          limit ${Math.max(1, Math.min(5, input.limit))} for update of session skip locked`);
        input.signal?.throwIfAborted();
        for (const session of selected.rows) {
          input.signal?.throwIfAborted();
          await transaction.execute(sql`insert into session_event_cursors
            (session_id,history_attempted_at,history_next_attempt_at)
            values (${session.sessionId},${input.now},${new Date(input.now.getTime() + input.cooldownMs)})
            on conflict(session_id) do update set history_attempted_at=excluded.history_attempted_at,
              history_next_attempt_at=excluded.history_next_attempt_at`);
          input.signal?.throwIfAborted();
        }
        return selected.rows;
      });
    },
    async finishHistoryAttempt(
      userId: string,
      id: string,
      input: {
        now: Date;
        succeeded: boolean;
        cooldownMs: number;
        maxBackoffMs: number;
        attemptedAt?: Date;
        signal?: AbortSignal;
      },
    ) {
      await db.transaction(async (transaction) => {
        if (!(await lock(transaction, userId, id, input.signal))) return;
        const failures = await transaction.execute<{
          count: number;
        }>(sql`select history_failure_count as count
          from session_event_cursors where session_id=${id}
          ${input.attemptedAt === undefined ? sql`` : sql`and history_attempted_at=${input.attemptedAt}`}`);
        input.signal?.throwIfAborted();
        if (!failures.rows.length) return;
        const count = input.succeeded
          ? 0
          : Math.min(20, failures.rows[0]!.count + 1);
        const delay = input.succeeded
          ? input.cooldownMs
          : Math.min(input.maxBackoffMs, input.cooldownMs * 2 ** (count - 1));
        await transaction.execute(sql`update session_event_cursors set history_failure_count=${count},
          history_next_attempt_at=${new Date(input.now.getTime() + delay)},updated_at=now() where session_id=${id}`);
        input.signal?.throwIfAborted();
      });
    },
    listEvents: (userId: string, id: string) => list(userId, id),
    listEventsAfter(userId: string, id: string, after: string, limit: number) {
      if (
        !/^\d+$/.test(after) ||
        BigInt(after) > 9223372036854775807n ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 500
      )
        throw new Error("Invalid event cursor or limit");
      return list(userId, id, after, limit);
    },
    historyState: state,
    async historyBackfilled(userId: string, id: string) {
      return (await state(userId, id)).complete;
    },
    async beginHistoryScan(
      userId: string,
      id: string,
      signal?: AbortSignal,
    ): Promise<number> {
      return db.transaction(async (transaction) => {
        if (!(await lock(transaction, userId, id, signal)))
          throw Object.assign(new Error("Resource not found"), {
            name: "ResourceNotFoundError",
          });
        const result = await transaction.execute<{
          generation: number;
        }>(sql`update session_event_cursors
          set history_scan_generation=history_scan_generation+1, history_repair_required=true,
              history_backfilled_at=null, updated_at=now()
          where session_id=${id} returning history_scan_generation as generation`);
        signal?.throwIfAborted();
        return result.rows[0]!.generation;
      });
    },
    async invalidateHistory(userId: string, id: string, generation?: number) {
      await db.transaction(async (transaction) => {
        if (!(await lock(transaction, userId, id))) return;
        await transaction.execute(sql`update session_event_cursors set
          history_scan_generation=history_scan_generation+1, history_repair_required=true,
          history_backfilled_at=null, updated_at=now() where session_id=${id}
          ${generation === undefined ? sql`` : sql`and history_scan_generation=${generation}`}`);
      });
    },
    async markHistoryBackfilled(
      userId: string,
      id: string,
      generation?: number,
      signal?: AbortSignal,
    ): Promise<boolean> {
      // Legacy callers must start a scan; never certify an unfenced snapshot.
      if (generation === undefined) return false;
      return db.transaction(async (transaction) => {
        if (!(await lock(transaction, userId, id, signal))) return false;
        const result =
          await transaction.execute(sql`update session_event_cursors set
          history_backfilled_at=now(), history_scanned_at=now(), history_repair_required=false,
          updated_at=now() where session_id=${id} and history_scan_generation=${generation} returning session_id`);
        signal?.throwIfAborted();
        return result.rows.length > 0;
      });
    },
    async appendEvents(
      userId: string,
      id: string,
      events: EventInput[],
      generation?: number,
      signal?: AbortSignal,
    ) {
      signal?.throwIfAborted();
      if (!events.length) return;
      await db.transaction(async (transaction) => {
        // Sequence allocation happens only after this lock. A concurrent batch
        // cannot expose a later cursor while an earlier one is still uncommitted.
        if (!(await lock(transaction, userId, id, signal))) return;
        if (generation !== undefined) {
          const current =
            await transaction.execute(sql`select session_id from session_event_cursors
            where session_id=${id} and history_scan_generation=${generation}`);
          signal?.throwIfAborted();
          if (!current.rows.length) throw staleScan();
        }
        const batch = [
          ...new Map(events.map((event) => [event.eventId, event])).values(),
        ];
        const values = sql.join(
          batch.map(
            (event) => sql`(${id}::uuid,${event.eventId}::text,
          ${event.sourceType}::text,${event.type}::text,${event.occurredAt}::timestamptz,
          ${JSON.stringify(event.payload)}::jsonb,${event.historyPosition ?? null}::bigint)`,
          ),
          sql`,`,
        );
        await transaction.execute(sql`insert into session_events
          (session_id,event_id,source_type,type,occurred_at,payload,history_position) values ${values}
          on conflict (session_id,event_id) do update set
            history_position=coalesce(excluded.history_position,session_events.history_position),
            payload=case when session_events.source_type='user.message' then
              excluded.payload || session_events.payload ||
              case when coalesce(session_events.payload->>'content','')='' then
                jsonb_build_object('content',excluded.payload->'content') else '{}'::jsonb end
              else session_events.payload end`);
        signal?.throwIfAborted();
        await transaction.execute(sql`update session_event_cursors set
          persisted_sequence=(select max(local_sequence) from session_events where session_id=${id}),
          updated_at=now() where session_id=${id}`);
        signal?.throwIfAborted();
      });
    },
  };
}

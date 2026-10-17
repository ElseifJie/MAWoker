import { sql, type SQL } from "drizzle-orm";

type Row = Record<string, unknown>;

interface Database {
  execute<T extends Row = Row>(query: SQL): PromiseLike<{ rows: T[] }>;
  transaction<T>(callback: (transaction: Database) => Promise<T>): Promise<T>;
}

export type RunTriggerKind = "manual" | "automation";

export type RunStatus =
  | "queued"
  | "starting"
  | "running"
  | "waiting_user"
  | "waiting_device"
  | "completed"
  | "failed"
  | "canceled"
  | "unknown";

export interface RunRecord extends Row {
  id: string;
  ownerUserId: string;
  conversationId: string;
  triggerKind: RunTriggerKind;
  submissionId: string;
  status: RunStatus;
  arkSessionId: string | null;
  turnId: string | null;
  automationId: string | null;
  errorCode: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

const runSelection = sql`id, owner_user_id as "ownerUserId",
  conversation_id as "conversationId", trigger_kind as "triggerKind",
  submission_id as "submissionId", status,
  ark_session_id as "arkSessionId", turn_id as "turnId",
  automation_id as "automationId", error_code as "errorCode",
  started_at as "startedAt", ended_at as "endedAt", version,
  created_at as "createdAt", updated_at as "updatedAt"`;

/**
 * PGlite returns `timestamptz` values as strings while `pg` returns Dates.
 * Normalize at the repository boundary so callers and the API can rely on
 * Date methods.
 */
function dates(run: RunRecord): RunRecord {
  return {
    ...run,
    startedAt: run.startedAt ? new Date(run.startedAt) : null,
    endedAt: run.endedAt ? new Date(run.endedAt) : null,
    createdAt: new Date(run.createdAt),
    updatedAt: new Date(run.updatedAt),
  };
}

/**
 * Runs are created inside the durable-submission transaction so a replayed
 * submission can never produce a second Run. This repository exposes read
 * paths; state transitions are added with the execution service.
 */
export function createRunRepository(db: Database) {
  return {
    async findOwned(
      ownerUserId: string,
      id: string,
    ): Promise<RunRecord | undefined> {
      const result = await db.execute<RunRecord>(
        sql`select ${runSelection}
              from runs
             where owner_user_id = ${ownerUserId}
               and id = ${id}
             limit 1`,
      );
      const row = result.rows[0];
      return row ? dates(row) : undefined;
    },

    async findBySubmission(
      ownerUserId: string,
      submissionId: string,
    ): Promise<RunRecord | undefined> {
      const result = await db.execute<RunRecord>(
        sql`select ${runSelection}
              from runs
             where owner_user_id = ${ownerUserId}
               and submission_id = ${submissionId}
             limit 1`,
      );
      const row = result.rows[0];
      return row ? dates(row) : undefined;
    },

    async transition(input: {
      ownerUserId: string;
      id: string;
      from: readonly RunStatus[];
      to: RunStatus;
      errorCode?: string | null;
      arkSessionId?: string | null;
      turnId?: string | null;
      startedAt?: Date | null;
      endedAt?: Date | null;
      now?: Date;
    }): Promise<RunRecord | undefined> {
      const now = input.now ?? new Date();
      const from = sql.join(
        input.from.map((status) => sql`${status}::run_status`),
        sql`, `,
      );
      const result = await db.execute<RunRecord>(
        sql`update runs
               set status = ${input.to}::run_status,
                   error_code = ${input.errorCode ?? null}::text,
                   ark_session_id = coalesce(
                     ${input.arkSessionId ?? null}::text,
                     ark_session_id
                   ),
                   turn_id = coalesce(
                     ${input.turnId ?? null}::uuid,
                     turn_id
                   ),
                   started_at = coalesce(
                     ${input.startedAt ?? null}::timestamptz,
                     started_at
                   ),
                   ended_at = ${input.endedAt ?? null}::timestamptz,
                   version = version + 1,
                   updated_at = ${now}::timestamptz
             where owner_user_id = ${input.ownerUserId}
               and id = ${input.id}
               and status in (${from})
             returning ${runSelection}`,
      );
      const row = result.rows[0];
      return row ? dates(row) : undefined;
    },

    async listForConversation(
      ownerUserId: string,
      conversationId: string,
      limit = 20,
    ): Promise<RunRecord[]> {
      const result = await db.execute<RunRecord>(
        sql`select ${runSelection}
              from runs
             where owner_user_id = ${ownerUserId}
               and conversation_id = ${conversationId}
             order by created_at desc
             limit ${limit}`,
      );
      return result.rows.map(dates);
    },
  };
}

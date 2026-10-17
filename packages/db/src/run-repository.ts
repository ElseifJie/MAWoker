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
      return result.rows[0];
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
      return result.rows[0];
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
      return result.rows;
    },
  };
}

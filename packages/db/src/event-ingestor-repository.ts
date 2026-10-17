import { sql, type SQL } from "drizzle-orm";

type Row = Record<string, unknown>;

interface Database {
  execute<T extends Row = Row>(query: SQL): PromiseLike<{ rows: T[] }>;
  transaction<T>(callback: (transaction: Database) => Promise<T>): Promise<T>;
}

export interface EventConsumerCandidate extends Row {
  sessionId: string;
  ownerUserId: string;
}

export interface EventConsumerClaim {
  generation: number;
  lastEventId: string | null;
}

function toNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

export function createEventIngestorRepository(db: Database) {
  return {
    async listCandidates(
      now: Date,
      limit: number,
    ): Promise<EventConsumerCandidate[]> {
      const bounded = Math.max(1, Math.min(limit, 20));
      const result = await db.execute<EventConsumerCandidate>(
        sql`select session.id as "sessionId",
                   session.owner_user_id as "ownerUserId"
              from sessions session
              left join session_event_consumers consumer
                on consumer.session_id = session.id
             where session.status in ('running', 'rescheduled')
               and session.deletion_state = 'none'
               and session.ark_session_id not like 'pending:%'
               and (consumer.session_id is null or consumer.lease_until < ${now})
             order by session.last_event_at desc nulls last, session.updated_at desc
             limit ${bounded}`,
      );
      return result.rows;
    },

    async claim(input: {
      sessionId: string;
      ownerUserId: string;
      consumerId: string;
      now: Date;
      leaseUntil: Date;
    }): Promise<EventConsumerClaim | undefined> {
      const result = await db.execute<{
        generation: number | string;
        lastEventId: string | null;
      }>(
        sql`insert into session_event_consumers
              (session_id, owner_user_id, consumer_id, lease_until, generation,
               created_at, updated_at)
            values (
              ${input.sessionId}, ${input.ownerUserId}, ${input.consumerId},
              ${input.leaseUntil}, 1, ${input.now}, ${input.now}
            )
            on conflict (session_id) do update
              set consumer_id = excluded.consumer_id,
                  lease_until = excluded.lease_until,
                  generation = session_event_consumers.generation + 1,
                  updated_at = excluded.updated_at
              where session_event_consumers.lease_until < excluded.updated_at
            returning generation, last_event_id as "lastEventId"`,
      );
      const row = result.rows[0];
      if (!row) return undefined;
      return {
        generation: toNumber(row.generation),
        lastEventId: row.lastEventId,
      };
    },

    async checkpoint(input: {
      sessionId: string;
      consumerId: string;
      generation: number;
      lastEventId: string | null;
      now: Date;
      leaseUntil: Date;
    }): Promise<boolean> {
      const result = await db.execute<{ sessionId: string }>(
        sql`update session_event_consumers
               set last_event_id = coalesce(${input.lastEventId}, last_event_id),
                   last_consumed_at = ${input.now},
                   lease_until = ${input.leaseUntil},
                   last_error_code = null,
                   updated_at = ${input.now}
             where session_id = ${input.sessionId}
               and consumer_id = ${input.consumerId}
               and generation = ${input.generation}
               and lease_until > ${input.now}
             returning session_id as "sessionId"`,
      );
      return result.rows.length > 0;
    },

    async release(input: {
      sessionId: string;
      consumerId: string;
      generation: number;
      now: Date;
      errorCode?: string | null;
    }): Promise<void> {
      await db.execute(
        sql`update session_event_consumers
               set lease_until = ${input.now},
                   last_error_code = ${input.errorCode ?? null},
                   updated_at = ${input.now}
             where session_id = ${input.sessionId}
               and consumer_id = ${input.consumerId}
               and generation = ${input.generation}`,
      );
    },
  };
}

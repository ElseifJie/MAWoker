import { sql, type SQL } from "drizzle-orm";

type Row = Record<string, unknown>;

interface Database {
  execute<T extends Row = Row>(query: SQL): PromiseLike<{ rows: T[] }>;
  transaction<T>(callback: (transaction: Database) => Promise<T>): Promise<T>;
}

export interface AccountChangeInput {
  ownerUserId: string;
  resourceType: string;
  resourceId: string;
  revision?: number | null;
  deleted?: boolean;
  now?: Date;
}

export interface SyncChange {
  seq: number;
  resourceType: string;
  resourceId: string;
  revision: number | null;
  deleted: boolean;
  changedAt: Date;
}

export interface SyncChangePage {
  changes: SyncChange[];
  hasMore: boolean;
}

function toNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

/**
 * Appends one account change inside the caller's transaction. The counter row
 * is locked by `UPDATE ... seq = seq + 1`, which serializes writes for one
 * owner and guarantees that commit order matches `seq` order.
 */
export async function appendAccountChange(
  db: Database,
  input: AccountChangeInput,
): Promise<number> {
  const now = input.now ?? new Date();
  await db.execute(
    sql`insert into sync_counters (owner_user_id)
        values (${input.ownerUserId})
        on conflict (owner_user_id) do nothing`,
  );
  const counter = await db.execute<{ seq: number | string }>(
    sql`update sync_counters
           set seq = seq + 1, updated_at = ${now}::timestamptz
         where owner_user_id = ${input.ownerUserId}
         returning seq`,
  );
  const raw = counter.rows[0]?.seq;
  if (raw === undefined) throw new Error("Sync counter unavailable");
  const seq = toNumber(raw);
  await db.execute(
    sql`insert into account_changes
          (owner_user_id, seq, resource_type, resource_id, revision, deleted, changed_at)
        values (
          ${input.ownerUserId}, ${seq}, ${input.resourceType},
          ${input.resourceId}, ${input.revision ?? null}, ${input.deleted ?? false},
          ${now}::timestamptz
        )`,
  );
  return seq;
}

export function createSyncRepository(db: Database) {
  return {
    async getCursor(ownerUserId: string): Promise<number> {
      const result = await db.execute<{ seq: number | string }>(
        sql`select coalesce(
              (select seq from sync_counters where owner_user_id = ${ownerUserId}),
              (select coalesce(max(seq), 0) from account_changes where owner_user_id = ${ownerUserId}),
              0
            ) as seq`,
      );
      return toNumber(result.rows[0]?.seq ?? 0);
    },

    async listChanges(
      ownerUserId: string,
      cursor: number,
      limit: number,
    ): Promise<SyncChangePage> {
      const bounded = Math.max(1, Math.min(limit, 200));
      const result = await db.execute<{
        seq: number | string;
        resourceType: string;
        resourceId: string;
        revision: number | null;
        deleted: boolean;
        changedAt: Date | string;
      }>(
        sql`select seq, resource_type as "resourceType",
                   resource_id as "resourceId", revision, deleted,
                   changed_at as "changedAt"
              from account_changes
             where owner_user_id = ${ownerUserId}
               and seq > ${cursor}
             order by seq
             limit ${bounded + 1}`,
      );
      const hasMore = result.rows.length > bounded;
      return {
        hasMore,
        changes: result.rows.slice(0, bounded).map((row) => ({
          seq: toNumber(row.seq),
          resourceType: row.resourceType,
          resourceId: row.resourceId,
          revision: row.revision,
          deleted: row.deleted,
          changedAt: new Date(row.changedAt),
        })),
      };
    },
  };
}

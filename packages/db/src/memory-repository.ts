import { sql, type SQL } from "drizzle-orm";

export interface MemoryState {
  userId: string;
  revision: number;
  status: "provisioning" | "active" | "draining" | "applying" | "repairing";
  storeId: string | null;
  policyEpoch: number;
  protectedPaths: string[];
  revokedPaths: string[];
  autoDream: boolean;
  /** Skeleton generation; absent means a pre-episodes layout. */
  structureVersion?: number;
  // The domain owns the versioned run/cleanup manifest; persist it opaquely.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run: any | null;
  lastMonitorAt: number;
  lastCompactAt: number;
  summarizedSources?: string[];
}

interface MemoryStoreMeta {
  createdAt: string;
  updatedAt: string;
}

export interface MemoryRepository {
  reserve(userId: string): Promise<{ created: boolean; state: MemoryState }>;
  get(userId: string): Promise<MemoryState | undefined>;
  meta(userId: string): Promise<MemoryStoreMeta | undefined>;
  save(
    userId: string,
    expectedRevision: number,
    state: MemoryState,
  ): Promise<void>;
  list(): Promise<MemoryState[]>;
  sessions(userId: string): Promise<
    Array<{
      id: string;
      arkSessionId: string;
      memoryStoreId: string | null;
      pending: boolean;
    }>
  >;
  gate(userId: string): Promise<void>;
}

interface DatabaseClient {
  execute<T extends Record<string, unknown> = Record<string, unknown>>(
    query: SQL,
  ): PromiseLike<{ rows: T[] }>;
  transaction<T>(
    callback: (transaction: DatabaseClient) => Promise<T>,
  ): Promise<T>;
}

function conflict(): Error {
  return Object.assign(new Error("Memory state revision conflict"), {
    code: "MEMORY_CONFLICT",
  });
}

export function createMemoryRepository(database: unknown): MemoryRepository {
  const db = database as DatabaseClient;

  const get = async (userId: string): Promise<MemoryState | undefined> => {
    const result = await db.execute<{ state: MemoryState }>(
      sql`select state from user_memory_stores where user_id = ${userId}`,
    );
    return result.rows[0]?.state;
  };

  const meta = async (userId: string): Promise<MemoryStoreMeta | undefined> => {
    const result = await db.execute<{
      createdAt: Date | string;
      updatedAt: Date | string;
    }>(
      sql`select created_at as "createdAt", updated_at as "updatedAt"
            from user_memory_stores where user_id = ${userId}`,
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(),
    };
  };

  return {
    async reserve(userId) {
      const state: MemoryState = {
        userId,
        revision: 0,
        status: "provisioning",
        storeId: null,
        policyEpoch: 0,
        protectedPaths: [],
        revokedPaths: [],
        autoDream: true,
        run: null,
        lastMonitorAt: 0,
        lastCompactAt: 0,
      };
      const inserted = await db.execute<{ state: MemoryState }>(
        sql`insert into user_memory_stores (user_id, fixed_store_id, state, revision)
            values (${userId}, null, ${JSON.stringify(state)}::jsonb, 0)
            on conflict (user_id) do nothing
            returning state`,
      );
      if (inserted.rows[0])
        return { created: true, state: inserted.rows[0].state };
      const existing = await get(userId);
      if (!existing) throw new Error("Memory reservation not found");
      return { created: false, state: existing };
    },
    get,
    meta,
    async save(userId, expectedRevision, state) {
      if (
        state.userId !== userId ||
        !Number.isInteger(expectedRevision) ||
        expectedRevision < 0 ||
        state.revision !== expectedRevision
      )
        throw conflict();

      const serialized = JSON.stringify({
        ...state,
        revision: expectedRevision + 1,
      });
      const update = async (client: DatabaseClient) => {
        const result = await client.execute(
          sql`update user_memory_stores
                 set state = ${serialized}::jsonb,
                     revision = revision + 1,
                     fixed_store_id = ${state.storeId},
                     updated_at = now()
               where user_id = ${userId} and revision = ${expectedRevision}
               returning user_id`,
        );
        if (result.rows.length !== 1) throw conflict();
      };
      if (state.status === "draining") {
        await db.transaction(async (transaction) => {
          // Matches Session create/message admission lock order.
          await transaction.execute(
            sql`select id from users where id = ${userId} for update`,
          );
          await update(transaction);
        });
      } else {
        await update(db);
      }
    },
    async list() {
      const result = await db.execute<{ state: MemoryState }>(
        sql`select state from user_memory_stores order by user_id`,
      );
      return result.rows.map((row) => row.state);
    },
    async sessions(userId) {
      const result = await db.execute<{
        id: string;
        arkSessionId: string;
        memoryStoreId: string | null;
        pending: boolean;
      }>(
        // Deletion is deliberately absent from this predicate: a Session
        // being deleted (or one whose deletion job exhausted retries) has no
        // in-flight message work, and its consolidation is coordinated by
        // fenceDeletion, which holds the upstream delete until no run is
        // active. Counting deletion here deadlocked the two sides — the run
        // waited for deletion_state to clear while deletion waited for the
        // run to finish.
        sql`select id, ark_session_id as "arkSessionId",
                   memory_store_id as "memoryStoreId",
                   (message_in_flight_count > 0 or message_start_pending
                    or message_unknown_outcome
                    or ark_session_id like 'pending:%') as pending
              from sessions where owner_user_id = ${userId}
             order by created_at, id`,
      );
      return result.rows;
    },
    async gate(userId) {
      const state = await get(userId);
      if (state?.status !== "active") {
        throw Object.assign(new Error("Personal memory is busy"), {
          code: "MEMORY_BUSY",
        });
      }
    },
  };
}

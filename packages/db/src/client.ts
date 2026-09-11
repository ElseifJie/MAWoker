import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient, type QueryConfig } from "pg";
import * as schema from "./schema.js";

interface DatabaseOptions {
  probeTimeoutMs?: number;
}

function abortError(): Error {
  return Object.assign(new Error("Database readiness probe aborted"), {
    name: "AbortError",
  });
}

export function createDatabase(
  databaseUrl: string,
  options: DatabaseOptions = {},
) {
  const pool = new Pool({ connectionString: databaseUrl });
  const probeTimeoutMs = options.probeTimeoutMs ?? 1_000;
  const probePool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: probeTimeoutMs,
    query_timeout: probeTimeoutMs,
    statement_timeout: probeTimeoutMs,
    max: 1,
    idleTimeoutMillis: probeTimeoutMs,
    allowExitOnIdle: true,
  });
  return {
    db: drizzle(pool, { schema }),
    probe: async (signal?: AbortSignal) => {
      if (signal?.aborted) throw abortError();

      let client: PoolClient | undefined;
      const release = (error?: Error) => {
        const connected = client;
        client = undefined;
        connected?.release(error);
      };
      const abort = () => release(abortError());
      signal?.addEventListener("abort", abort, { once: true });
      try {
        client = await probePool.connect();
        if (signal?.aborted) {
          const error = abortError();
          release(error);
          throw error;
        }
        await client.query({
          text: "select 1",
          query_timeout: probeTimeoutMs,
        } as QueryConfig & { query_timeout: number });
      } catch (error) {
        const failure =
          error instanceof Error
            ? error
            : new Error("Database readiness probe failed");
        release(failure);
        throw error;
      } finally {
        signal?.removeEventListener("abort", abort);
        release();
      }
    },
    close: async () => {
      await Promise.all([pool.end(), probePool.end()]);
    },
  };
}

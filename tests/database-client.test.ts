import { describe, expect, it, vi } from "vitest";

const pg = vi.hoisted(() => {
  class TestPool {
    static instances: TestPool[] = [];

    readonly options: Record<string, unknown>;
    activeCount = 0;
    waitingCount = 0;
    releaseErrors: unknown[] = [];
    ended = false;

    constructor(options: Record<string, unknown>) {
      this.options = options;
      TestPool.instances.push(this);
    }

    query() {
      return new Promise<never>(() => undefined);
    }

    async connect() {
      this.activeCount += 1;
      return {
        query: (config: { query_timeout?: number }) =>
          new Promise<never>((_resolve, reject) => {
            setTimeout(
              () => reject(new Error("Query read timeout")),
              config.query_timeout,
            );
          }),
        release: (error?: unknown) => {
          this.releaseErrors.push(error);
          this.activeCount -= 1;
        },
      };
    }

    async end() {
      this.ended = true;
    }
  }

  return { TestPool };
});

vi.mock("pg", () => ({ Pool: pg.TestPool }));

import { createDatabase } from "../packages/db/src/client.js";

describe("PostgreSQL readiness probe", () => {
  it("uses real connection/query timeouts and releases a timed-out client", async () => {
    const database = createDatabase("postgres://localhost/pwa", {
      probeTimeoutMs: 20,
    });
    const probePool = pg.TestPool.instances[1]!;

    const outcome = await Promise.race([
      database.probe().then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise<"pending">((resolve) =>
        setTimeout(() => resolve("pending"), 100),
      ),
    ]);

    expect(probePool.options).toMatchObject({
      connectionTimeoutMillis: 20,
      query_timeout: 20,
      statement_timeout: 20,
      max: 1,
    });
    expect(outcome).toBe("rejected");
    expect(probePool.waitingCount).toBe(0);
    expect(probePool.activeCount).toBe(0);
    expect(probePool.releaseErrors[0]).toBeInstanceOf(Error);

    await database.close();
    expect(pg.TestPool.instances.every((pool) => pool.ended)).toBe(true);
  });
});

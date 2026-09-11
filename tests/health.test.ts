import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../apps/api/src/app.js";

describe("API health checks", () => {
  it("reports process liveness without probing dependencies", async () => {
    const checkDatabase = vi.fn(async () => {
      throw new Error("must not run");
    });
    const app = buildApp({
      readiness: {
        configurationReady: true,
        checkDatabase,
        timeoutMs: 50,
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/health/live",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "live" });
    expect(checkDatabase).not.toHaveBeenCalled();
    await app.close();
  });

  it("reports readiness only after required config and the DB probe pass", async () => {
    const checkDatabase = vi.fn(async () => undefined);
    const app = buildApp({
      readiness: {
        configurationReady: true,
        checkDatabase,
        timeoutMs: 50,
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/health/ready",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ready",
      checks: { configuration: "ok", database: "ok" },
    });
    expect(checkDatabase).toHaveBeenCalledOnce();
    await app.close();
  });

  it("fails readiness without probing the DB when configuration is invalid", async () => {
    const checkDatabase = vi.fn(async () => undefined);
    const app = buildApp({
      readiness: {
        configurationReady: false,
        checkDatabase,
        timeoutMs: 50,
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/health/ready",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: "not_ready",
      checks: { configuration: "failed", database: "skipped" },
    });
    expect(checkDatabase).not.toHaveBeenCalled();
    await app.close();
  });

  it("aborts and releases a timed-out injectable DB probe", async () => {
    let pendingProbes = 0;
    const app = buildApp({
      readiness: {
        configurationReady: true,
        checkDatabase: (signal) => {
          pendingProbes += 1;
          return new Promise<void>((resolve) => {
            signal?.addEventListener(
              "abort",
              () => {
                pendingProbes -= 1;
                resolve();
              },
              { once: true },
            );
          });
        },
        timeoutMs: 20,
      },
    });
    const startedAt = Date.now();

    const response = await app.inject({
      method: "GET",
      url: "/health/ready",
    });

    expect(Date.now() - startedAt).toBeLessThan(200);
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("database-password");
    expect(response.json()).toEqual({
      status: "not_ready",
      checks: { configuration: "ok", database: "failed" },
    });
    expect(pendingProbes).toBe(0);
    await app.close();
  });
});

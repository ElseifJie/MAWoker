import { describe, expect, it, vi } from "vitest";
import { AUTH_COOKIE_NAME, buildApp } from "../apps/api/src/app.js";

const adminId = "00000000-0000-4000-8000-000000000001";

function auth(role: "admin" | "user" = "admin") {
  return {
    login: vi.fn(),
    authenticate: vi.fn(async () => ({
      userId: adminId,
      authSubject: "subject-admin",
      email: "admin@example.com",
      role,
    })),
    renew: vi.fn(async () => ({
      expiresAt: new Date("2026-09-07T00:00:00.000Z"),
    })),
    logout: vi.fn(),
  };
}

describe("admin system API", () => {
  it("returns the queue and run snapshot to an administrator", async () => {
    const snapshot = {
      generatedAt: "2026-10-17T00:00:00.000Z",
      database: { latencyMs: 4 },
      jobs: {
        pending: 2,
        running: 1,
        failedLast24h: 0,
        oldestPendingSeconds: 30,
      },
      runs: { running: 1 },
    };
    const app = buildApp({
      auth: auth(),
      adminSystem: { snapshot: async () => snapshot },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/system",
      cookies: { [AUTH_COOKIE_NAME]: "token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(snapshot);
    await app.close();
  });

  it("hides the system snapshot from ordinary users", async () => {
    const app = buildApp({
      auth: auth("user"),
      adminSystem: { snapshot: async () => ({}) },
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/system",
      cookies: { [AUTH_COOKIE_NAME]: "token" },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });
});

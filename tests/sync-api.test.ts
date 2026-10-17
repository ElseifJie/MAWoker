import { describe, expect, it, vi } from "vitest";
import { AUTH_COOKIE_NAME, buildApp } from "../apps/api/src/app.js";
import { AuthRequiredError } from "../packages/auth/src/index.js";

const userId = "00000000-0000-4000-8000-000000000001";

const snapshot = {
  cursor: 2,
  resources: {
    runs: [{ id: "run-1", status: "completed" }],
    notifications: [{ id: "notification-1", kind: "completed" }],
  },
};

function auth(overrides: { reject?: boolean } = {}) {
  return {
    login: vi.fn(),
    authenticate: vi.fn(async () => {
      if (overrides.reject) throw new AuthRequiredError();
      return {
        userId,
        authSubject: "subject-user",
        email: "user@example.com",
        role: "user" as const,
      };
    }),
    renew: vi.fn(async () => ({
      expiresAt: new Date("2026-09-07T00:00:00.000Z"),
    })),
    logout: vi.fn(),
  };
}

describe("Sync API", () => {
  it("returns the account snapshot for the caller", async () => {
    const syncSnapshot = vi.fn(async () => snapshot);
    const syncChanges = vi.fn(async () => ({
      cursor: 2,
      hasMore: false,
      changes: [],
    }));
    const app = buildApp({
      auth: auth(),
      sync: { snapshot: syncSnapshot, changes: syncChanges },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/sync/snapshot",
      cookies: { [AUTH_COOKIE_NAME]: "token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(snapshot);
    expect(syncSnapshot).toHaveBeenCalledWith(userId);
    await app.close();
  });

  it("reads changes from a cursor with bounded pagination", async () => {
    const syncChanges = vi.fn(async () => ({
      cursor: 5,
      hasMore: false,
      changes: [],
    }));
    const app = buildApp({
      auth: auth(),
      sync: {
        snapshot: vi.fn(async () => snapshot),
        changes: syncChanges,
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/sync/changes?cursor=4&limit=10",
      cookies: { [AUTH_COOKIE_NAME]: "token" },
    });

    expect(response.statusCode).toBe(200);
    expect(syncChanges).toHaveBeenCalledWith(userId, 4, 10);
    await app.close();
  });

  it("applies cursor and limit defaults", async () => {
    const syncChanges = vi.fn(async () => ({
      cursor: 0,
      hasMore: false,
      changes: [],
    }));
    const app = buildApp({
      auth: auth(),
      sync: {
        snapshot: vi.fn(async () => snapshot),
        changes: syncChanges,
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/sync/changes",
      cookies: { [AUTH_COOKIE_NAME]: "token" },
    });

    expect(response.statusCode).toBe(200);
    expect(syncChanges).toHaveBeenCalledWith(userId, 0, 100);
    await app.close();
  });

  it("does not serve sync without authentication", async () => {
    const app = buildApp({
      auth: auth({ reject: true }),
      sync: {
        snapshot: vi.fn(async () => snapshot),
        changes: vi.fn(async () => ({
          cursor: 0,
          hasMore: false,
          changes: [],
        })),
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/sync/snapshot",
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });
});

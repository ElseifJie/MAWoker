import { describe, expect, it, vi } from "vitest";
import { AuthRequiredError } from "../packages/auth/src/index.js";
import {
  AUTH_COOKIE_NAME,
  buildApp,
  type ApiAuthService,
  type AuditApiService,
} from "../apps/api/src/app.js";

const adminId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";

function auth(): ApiAuthService {
  return {
    async login(email: string, password: string) {
      if (email === "admin@example.com" && password === "correct-password") {
        return {
          token: "admin-token",
          expiresAt: new Date(Date.now() + 60_000),
        };
      }
      throw new AuthRequiredError();
    },
    async authenticate(token) {
      if (token === "admin-token") {
        return { userId: adminId, authSubject: "managed:admin", role: "admin" };
      }
      throw new AuthRequiredError();
    },
    async renew() {
      return { expiresAt: new Date(Date.now() + 60_000) };
    },
    async logout() {},
  };
}

function entry(
  overrides: Partial<Parameters<AuditApiService["list"]>[0]> & {
    id: string;
    createdAt: Date;
  },
) {
  return {
    id: overrides.id,
    actorUserId: adminId,
    actorEmail: "admin@example.com",
    ownerUserId: userId,
    ownerEmail: "user@example.com",
    action: "user.status.update",
    resourceType: "user",
    resourceId: userId,
    result: "succeeded" as const,
    requestId: "req-1",
    arkRequestId: null,
    errorCode: null,
    metadata: { from: "active", to: "disabled" },
    createdAt: overrides.createdAt,
  };
}

function auditService(): AuditApiService {
  return {
    list: vi.fn(async () => ({
      entries: [
        entry({
          id: "00000000-0000-4000-8000-0000000000aa",
          createdAt: new Date("2026-09-10T00:00:00.000Z"),
        }),
      ],
      nextCursor: {
        createdAt: "2026-09-09T00:00:00.000Z",
        id: "00000000-0000-4000-8000-0000000000bb",
      },
    })),
    listForUser: vi.fn(async () => ({ entries: [], nextCursor: null })),
    recordLogin: vi.fn(async () => undefined),
    recordUserView: vi.fn(async () => undefined),
  };
}

describe("admin audit API", () => {
  it("lists audit entries with filters and an opaque cursor", async () => {
    const audit = auditService();
    const app = buildApp({ auth: auth(), audit });

    const cursor = Buffer.from(
      JSON.stringify({
        createdAt: "2026-09-09T00:00:00.000Z",
        id: "00000000-0000-4000-8000-0000000000bb",
      }),
      "utf8",
    ).toString("base64url");
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/admin/audit-logs?action=user.status.update&result=succeeded&since=2026-09-01T00:00:00.000Z&until=2026-09-12T00:00:00.000Z&actorId=${adminId}&cursor=${cursor}`,
      cookies: { [AUTH_COOKIE_NAME]: "admin-token" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toMatchObject({
      action: "user.status.update",
      actorEmail: "admin@example.com",
      metadata: { from: "active", to: "disabled" },
      createdAt: "2026-09-10T00:00:00.000Z",
    });
    expect(body.nextCursor).toBe(cursor);
    expect(audit.list).toHaveBeenCalledWith({
      since: "2026-09-01T00:00:00.000Z",
      until: "2026-09-12T00:00:00.000Z",
      actorId: adminId,
      action: "user.status.update",
      resourceType: undefined,
      resourceId: undefined,
      result: "succeeded",
      limit: 50,
      before: {
        createdAt: "2026-09-09T00:00:00.000Z",
        id: "00000000-0000-4000-8000-0000000000bb",
      },
    });
    await app.close();
  });

  it("records login outcomes without credentials", async () => {
    const audit = auditService();
    const app = buildApp({ auth: auth(), audit });

    const success = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: " Admin@Example.com ", password: "correct-password" },
    });
    const failure = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "admin@example.com", password: "wrong-password" },
    });

    expect(success.statusCode).toBe(204);
    expect(failure.statusCode).toBe(401);
    expect(audit.recordLogin).toHaveBeenNthCalledWith(1, {
      email: "admin@example.com",
      userId: adminId,
      success: true,
      requestId: expect.any(String),
    });
    expect(audit.recordLogin).toHaveBeenNthCalledWith(2, {
      email: "admin@example.com",
      userId: null,
      success: false,
      requestId: expect.any(String),
    });
    await app.close();
  });

  it("hides the audit route from non-admin callers and rejects bad cursors", async () => {
    const audit = auditService();
    const app = buildApp({ auth: auth(), audit });

    const asUser = await app.inject({
      method: "GET",
      url: "/api/v1/admin/audit-logs",
      cookies: { [AUTH_COOKIE_NAME]: "invalid" },
    });
    const badCursor = await app.inject({
      method: "GET",
      url: `/api/v1/admin/audit-logs?cursor=${encodeURIComponent("junk")}`,
      cookies: { [AUTH_COOKIE_NAME]: "admin-token" },
    });

    expect(asUser.statusCode).toBe(401);
    expect(badCursor.statusCode).toBe(400);
    expect(badCursor.json().error).toMatchObject({ code: "VALIDATION_FAILED" });
    await app.close();
  });
});

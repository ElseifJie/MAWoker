import { describe, expect, it, vi } from "vitest";
import {
  AUTH_COOKIE_NAME,
  buildApp,
  requireAdmin,
  requireUser,
  type ApiAuthService,
} from "../apps/api/src/app.js";
import {
  AuthRequiredError,
  AuthVerificationError,
} from "../packages/auth/src/index.js";

const userContext = {
  userId: "00000000-0000-4000-8000-000000000001",
  authSubject: "managed:user@example.com",
  role: "user" as const,
};
const adminContext = {
  userId: "00000000-0000-4000-8000-000000000002",
  authSubject: "managed:admin@example.com",
  role: "admin" as const,
};

function createAuthService(): ApiAuthService & {
  requestEmailCode: ReturnType<typeof vi.fn>;
  verifyEmailCode: ReturnType<typeof vi.fn>;
  authenticate: ReturnType<typeof vi.fn>;
  renew: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
} {
  return {
    requestEmailCode: vi.fn(async () => undefined),
    verifyEmailCode: vi.fn(async () => ({
      token: "opaque-token",
      expiresAt: new Date("2026-09-07T00:00:00.000Z"),
    })),
    authenticate: vi.fn(async (token?: string) => {
      if (token === "user-token") return userContext;
      if (token === "admin-token") return adminContext;
      throw new AuthRequiredError();
    }),
    renew: vi.fn(async () => ({
      expiresAt: new Date("2026-09-07T00:00:00.000Z"),
    })),
    logout: vi.fn(async () => undefined),
  };
}

describe("Fastify authentication routes", () => {
  it("fails closed when no managed identity integration is configured", async () => {
    const app = buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/me",
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("requests an email code without disclosing identity state", async () => {
    const auth = createAuthService();
    const app = buildApp({ auth });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/email-code",
      payload: { email: " User@Example.COM " },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: true });
    expect(auth.requestEmailCode).toHaveBeenCalledWith("user@example.com");
    await app.close();
  });

  it("normalizes request and verification failures", async () => {
    const auth = createAuthService();
    auth.requestEmailCode.mockRejectedValueOnce(new AuthVerificationError());
    auth.verifyEmailCode.mockRejectedValueOnce(new AuthVerificationError());
    const app = buildApp({ auth });

    const requestFailure = await app.inject({
      method: "POST",
      url: "/api/v1/auth/email-code",
      payload: { email: "user@example.com" },
    });
    const verifyFailure = await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify",
      payload: { email: "user@example.com", code: "bad-code" },
    });

    expect(requestFailure.statusCode).toBe(401);
    expect(verifyFailure.statusCode).toBe(401);
    expect(requestFailure.json().error).toMatchObject({
      code: "AUTH_REQUIRED",
      message: "Authentication required",
      retryable: false,
    });
    expect(verifyFailure.json().error).toMatchObject({
      code: "AUTH_REQUIRED",
      message: "Authentication required",
      retryable: false,
    });
    expect(verifyFailure.json().error.requestId).not.toBe(
      requestFailure.json().error.requestId,
    );
    await app.close();
  });

  it("sets an opaque HttpOnly SameSite=Lax cookie after verification", async () => {
    const auth = createAuthService();
    const app = buildApp({ auth, isProduction: true });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify",
      payload: { email: "user@example.com", code: "123456" },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["set-cookie"]).toContain(
      `${AUTH_COOKIE_NAME}=opaque-token`,
    );
    expect(response.headers["set-cookie"]).toContain("HttpOnly");
    expect(response.headers["set-cookie"]).toContain("Secure");
    expect(response.headers["set-cookie"]).toContain("SameSite=Lax");
    expect(response.headers["set-cookie"]).toContain("Path=/");
    await app.close();
  });

  it("rejects client role and owner authority in verification payloads", async () => {
    const auth = createAuthService();
    const app = buildApp({ auth });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify",
      payload: {
        email: "user@example.com",
        code: "123456",
        role: "admin",
        ownerId: adminContext.userId,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(auth.verifyEmailCode).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns the server-derived identity from /me", async () => {
    const auth = createAuthService();
    const app = buildApp({ auth });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      cookies: { [AUTH_COOKIE_NAME]: "user-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ user: userContext });
    expect(auth.renew).toHaveBeenCalledWith("user-token");
    expect(response.headers["set-cookie"]).toContain(
      `${AUTH_COOKIE_NAME}=user-token`,
    );
    await app.close();
  });

  it("revokes the server session and clears the cookie on logout", async () => {
    const auth = createAuthService();
    const app = buildApp({ auth, isProduction: true });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      cookies: { [AUTH_COOKIE_NAME]: "user-token" },
    });

    expect(response.statusCode).toBe(204);
    expect(auth.logout).toHaveBeenCalledWith("user-token");
    expect(response.headers["set-cookie"]).toContain(`${AUTH_COOKIE_NAME}=;`);
    expect(response.headers["set-cookie"]).toContain("HttpOnly");
    await app.close();
  });

  it("normalizes missing, invalid, expired, and revoked cookies", async () => {
    const auth = createAuthService();
    const app = buildApp({ auth });

    for (const token of [undefined, "invalid", "expired", "revoked"]) {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/me",
        ...(token ? { cookies: { [AUTH_COOKIE_NAME]: token } } : {}),
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().error).toMatchObject({
        code: "AUTH_REQUIRED",
        message: "Authentication required",
        retryable: false,
      });
    }
    await app.close();
  });
});

describe("route authorization helpers", () => {
  it("protects business routes and separates user content from admin APIs", async () => {
    const auth = createAuthService();
    const app = buildApp({ auth });
    app.get("/api/v1/business", async (request) => ({
      auth: request.auth,
    }));
    app.get(
      "/api/v1/sessions/:id",
      { preHandler: requireUser(auth) },
      async () => ({ content: "private" }),
    );
    app.get(
      "/api/v1/admin/platform-agents",
      { preHandler: requireAdmin(auth) },
      async () => ({ managed: true }),
    );
    for (const resource of ["sessions", "uploads", "artifacts"]) {
      app.get(`/api/v1/admin/${resource}/:id`, async () => ({
        content: "must-not-be-exposed",
      }));
    }

    const unauthenticated = await app.inject({
      method: "GET",
      url: "/api/v1/business",
    });
    const userAdminRequest = await app.inject({
      method: "GET",
      url: "/api/v1/admin/platform-agents",
      cookies: { [AUTH_COOKIE_NAME]: "user-token" },
    });
    const adminContentRequest = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/00000000-0000-4000-8000-000000000099`,
      cookies: { [AUTH_COOKIE_NAME]: "admin-token" },
    });
    const adminRequest = await app.inject({
      method: "GET",
      url: "/api/v1/admin/platform-agents",
      cookies: { [AUTH_COOKIE_NAME]: "admin-token" },
    });
    const forbiddenAdminContent = await Promise.all(
      ["sessions", "uploads", "artifacts"].map((resource) =>
        app.inject({
          method: "GET",
          url: `/api/v1/admin/${resource}/00000000-0000-4000-8000-000000000099`,
          cookies: { [AUTH_COOKIE_NAME]: "admin-token" },
        }),
      ),
    );

    expect(unauthenticated.statusCode).toBe(401);
    expect(userAdminRequest.statusCode).toBe(403);
    expect(adminContentRequest.statusCode).toBe(403);
    expect(adminRequest.statusCode).toBe(200);
    expect(forbiddenAdminContent.map(({ statusCode }) => statusCode)).toEqual([
      404, 404, 404,
    ]);
    await app.close();
  });
});

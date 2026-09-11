import { describe, expect, it, vi } from "vitest";
import { AuthRequiredError } from "../packages/auth/src/index.js";
import {
  ResourceNotFoundError,
  UserEmailConflictError,
} from "../packages/domain/src/index.js";
import {
  AUTH_COOKIE_NAME,
  buildApp,
  type AdminService,
  type ApiAuthService,
} from "../apps/api/src/app.js";

const adminId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
const createdUserId = "00000000-0000-4000-8000-000000000003";

function auth(): ApiAuthService {
  return {
    async login() {
      return { token: "admin-token", expiresAt: new Date(Date.now() + 60_000) };
    },
    async authenticate(token) {
      if (token === "user-token") {
        return { userId, authSubject: "managed:user", role: "user" };
      }
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

function adminService() {
  return {
    listPlatformAgents: vi.fn(async () => []),
    createPlatformAgent: vi.fn(),
    updatePlatformAgent: vi.fn(),
    deletePlatformAgent: vi.fn(),
    listUsers: vi.fn(async () => [
      {
        id: adminId,
        email: "admin@example.com",
        role: "admin" as const,
        status: "active" as const,
        hasPassword: true,
        defaultAgentId: null,
        quota: {
          personalAgentLimit: 10,
          concurrentSessionLimit: 2,
          dailySessionLimit: 25,
          monthlyTokenLimit: 1_000_000,
        },
      },
      {
        id: userId,
        email: "user@example.com",
        role: "user" as const,
        status: "active" as const,
        hasPassword: false,
        defaultAgentId: null,
        quota: {
          personalAgentLimit: 10,
          concurrentSessionLimit: 2,
          dailySessionLimit: 25,
          monthlyTokenLimit: 1_000_000,
        },
      },
    ]),
    createUser: vi.fn(
      async (input: { email: string; role?: "user" | "admin" }) => ({
        id: createdUserId,
        email: input.email.trim().toLowerCase(),
        role: input.role ?? ("user" as const),
        status: "active" as const,
      }),
    ),
    resetUserPassword: vi.fn(async () => undefined),
    assignDefaultAgent: vi.fn(),
    updateUserQuota: vi.fn(),
  } satisfies AdminService;
}

describe("admin user API", () => {
  it("lists every account with role and credential state", async () => {
    const app = buildApp({ auth: auth(), admin: adminService() });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/users",
      cookies: { [AUTH_COOKIE_NAME]: "admin-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      users: [
        {
          id: adminId,
          email: "admin@example.com",
          role: "admin",
          status: "active",
          hasPassword: true,
          defaultAgentId: null,
          quota: {
            personalAgentLimit: 10,
            concurrentSessionLimit: 2,
            dailySessionLimit: 25,
            monthlyTokenLimit: 1_000_000,
          },
        },
        {
          id: userId,
          email: "user@example.com",
          role: "user",
          status: "active",
          hasPassword: false,
          defaultAgentId: null,
          quota: {
            personalAgentLimit: 10,
            concurrentSessionLimit: 2,
            dailySessionLimit: 25,
            monthlyTokenLimit: 1_000_000,
          },
        },
      ],
    });
    expect(response.body).not.toContain("passwordHash");
    await app.close();
  });

  it("creates an account and hands the credentials to the admin service", async () => {
    const admin = adminService();
    const app = buildApp({ auth: auth(), admin });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/users",
      cookies: { [AUTH_COOKIE_NAME]: "admin-token" },
      payload: {
        email: " Newcomer@Example.com ",
        password: "newcomer-password",
        role: "user",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      id: createdUserId,
      email: "newcomer@example.com",
      role: "user",
      status: "active",
    });
    expect(admin.createUser).toHaveBeenCalledWith(
      {
        email: " Newcomer@Example.com ",
        password: "newcomer-password",
        role: "user",
      },
      { adminId, requestId: expect.any(String) },
    );
    await app.close();
  });

  it("rejects duplicate emails and short passwords", async () => {
    const admin = adminService();
    admin.createUser.mockRejectedValueOnce(new UserEmailConflictError());
    const app = buildApp({ auth: auth(), admin });

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/v1/admin/users",
      cookies: { [AUTH_COOKIE_NAME]: "admin-token" },
      payload: { email: "user@example.com", password: "another-password" },
    });
    const shortPassword = await app.inject({
      method: "POST",
      url: "/api/v1/admin/users",
      cookies: { [AUTH_COOKIE_NAME]: "admin-token" },
      payload: { email: "newcomer@example.com", password: "short" },
    });

    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error).toMatchObject({
      code: "USER_EMAIL_CONFLICT",
      retryable: false,
    });
    expect(shortPassword.statusCode).toBe(400);
    expect(admin.createUser).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("rejects client-supplied authority in account payloads", async () => {
    const admin = adminService();
    const app = buildApp({ auth: auth(), admin });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/users",
      cookies: { [AUTH_COOKIE_NAME]: "admin-token" },
      payload: {
        email: "newcomer@example.com",
        password: "newcomer-password",
        ownerId: userId,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(admin.createUser).not.toHaveBeenCalled();
    await app.close();
  });

  it("resets a password and reports unknown accounts as not found", async () => {
    const admin = adminService();
    const app = buildApp({ auth: auth(), admin });

    const reset = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${userId}/password`,
      cookies: { [AUTH_COOKIE_NAME]: "admin-token" },
      payload: { password: "rotated-password" },
    });

    admin.resetUserPassword.mockRejectedValueOnce(new ResourceNotFoundError());
    const unknown = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${createdUserId}/password`,
      cookies: { [AUTH_COOKIE_NAME]: "admin-token" },
      payload: { password: "rotated-password" },
    });

    expect(reset.statusCode).toBe(204);
    expect(admin.resetUserPassword).toHaveBeenCalledWith(
      userId,
      "rotated-password",
      {
        adminId,
        requestId: expect.any(String),
      },
    );
    expect(unknown.statusCode).toBe(404);
    await app.close();
  });

  it("hides the new endpoints from non-admin callers", async () => {
    const admin = adminService();
    const app = buildApp({ auth: auth(), admin });

    const requests = [
      [
        "POST",
        "/api/v1/admin/users",
        { email: "newcomer@example.com", password: "newcomer-password" },
      ],
      [
        "POST",
        `/api/v1/admin/users/${userId}/password`,
        { password: "rotated-password" },
      ],
    ] as const;

    for (const [method, url, payload] of requests) {
      const unauthenticated = await app.inject({ method, url, payload });
      const asUser = await app.inject({
        method,
        url,
        cookies: { [AUTH_COOKIE_NAME]: "user-token" },
        payload,
      });

      expect(unauthenticated.statusCode).toBe(401);
      expect(asUser.statusCode).toBe(403);
    }
    expect(admin.createUser).not.toHaveBeenCalled();
    expect(admin.resetUserPassword).not.toHaveBeenCalled();
    await app.close();
  });
});

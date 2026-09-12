import { describe, expect, it, vi } from "vitest";
import { ArkGatewayError } from "../packages/ark-client/src/index.js";
import {
  AgentConflictError,
  AgentReferencedError,
  ResourceNotFoundError,
} from "../packages/domain/src/index.js";
import {
  AUTH_COOKIE_NAME,
  buildApp,
  type AdminService,
  type ApiAuthService,
} from "../apps/api/src/app.js";

const adminId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
const agentId = "00000000-0000-4000-8000-000000000003";
const agent = {
  id: agentId,
  arkAgentId: "upstream-secret-id",
  name: "Research",
  description: "Evidence",
  modelId: "model-a",
  systemPrompt: "Private platform prompt",
  arkVersion: "1",
  status: "active" as const,
  createdBy: adminId,
  updatedBy: adminId,
  lastErrorCode: null,
};

function auth(): ApiAuthService {
  return {
    async login() {
      return { token: "admin-token", expiresAt: new Date(Date.now() + 60_000) };
    },
    async authenticate(token) {
      if (token === "user-token") {
        return { userId, authSubject: "managed:user", role: "user" };
      }
      return { userId: adminId, authSubject: "managed:admin", role: "admin" };
    },
    async renew() {
      return { expiresAt: new Date(Date.now() + 60_000) };
    },
    async logout() {},
  };
}

function adminService() {
  const service = {
    listPlatformAgents: vi.fn(async () => [agent]),
    createPlatformAgent: vi.fn(async () => agent),
    updatePlatformAgent: vi.fn(async () => ({ ...agent, arkVersion: "2" })),
    deletePlatformAgent: vi.fn(async () => undefined),
    listUsers: vi.fn(async () => ({
      users: [
        {
          id: userId,
          email: "user@example.com",
          role: "user" as const,
          status: "active" as const,
          hasPassword: true,
          authSubject: "must-not-leak",
          defaultAgentId: agentId,
          createdAt: new Date("2026-09-01T00:00:00.000Z"),
          quota: {
            personalAgentLimit: 10,
            concurrentSessionLimit: 2,
            dailySessionLimit: 20,
            monthlyTokenLimit: 1000,
          },
        },
      ],
      nextCursor: null,
    })),
    createUser: vi.fn(async () => ({
      id: userId,
      email: "user@example.com",
      role: "user" as const,
      status: "active" as const,
    })),
    resetUserPassword: vi.fn(async () => undefined),
    setUserStatus: vi.fn(),
    setUserRole: vi.fn(),
    revokeUserSessions: vi.fn(),
    assignDefaultAgent: vi.fn(async () => ({
      userId,
      platformAgentId: agentId,
      assignedBy: adminId,
      assignedAt: new Date("2026-09-06T00:00:00.000Z"),
    })),
    updateUserQuota: vi.fn(async () => ({
      userId,
      personalAgentLimit: 10,
      concurrentSessionLimit: 2,
      dailySessionLimit: 20,
      monthlyTokenLimit: 1000,
      secret: "must-not-leak",
    })),
  };
  return service satisfies AdminService;
}

describe("admin platform Agent API", () => {
  it("serves create/list/update/delete with strict schemas and minimized output", async () => {
    const admin = adminService();
    const app = buildApp({ auth: auth(), admin });
    const cookie = { [AUTH_COOKIE_NAME]: "admin-token" };
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/admin/platform-agents",
      cookies: cookie,
      payload: {
        name: "Research",
        description: "Evidence",
        modelId: "model-a",
        systemPrompt: "Private platform prompt",
      },
    });
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/admin/platform-agents",
      cookies: cookie,
    });
    const update = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/platform-agents/${agentId}`,
      cookies: cookie,
      payload: { name: "Updated", arkVersion: "1" },
    });
    const remove = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/platform-agents/${agentId}`,
      cookies: cookie,
    });

    expect([
      create.statusCode,
      list.statusCode,
      update.statusCode,
      remove.statusCode,
    ]).toEqual([201, 200, 200, 204]);
    expect(create.json()).not.toHaveProperty("arkAgentId");
    expect(create.json()).not.toHaveProperty("createdBy");
    expect(list.json().agents[0]).not.toHaveProperty("updatedBy");
    expect(admin.createPlatformAgent).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "model-a" }),
      expect.objectContaining({ adminId }),
    );

    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/admin/platform-agents",
      cookies: cookie,
      payload: {
        name: "Bad",
        modelId: "model-a",
        systemPrompt: "",
        role: "admin",
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(admin.createPlatformAgent).toHaveBeenCalledTimes(1);

    const mixedUpdate = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/platform-agents/${agentId}`,
      cookies: cookie,
      payload: {
        name: "Updated again",
        arkVersion: "1",
        status: "disabled",
      },
    });
    expect(mixedUpdate.statusCode).toBe(400);
    expect(admin.updatePlatformAgent).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("maps version conflicts, Ark failures, missing resources, and references", async () => {
    const admin = adminService();
    admin.updatePlatformAgent
      .mockRejectedValueOnce(new AgentConflictError())
      .mockRejectedValueOnce(new ArkGatewayError("unavailable"));
    admin.deletePlatformAgent.mockRejectedValueOnce(
      new AgentReferencedError(1, 2),
    );
    admin.updatePlatformAgent.mockRejectedValueOnce(
      new ResourceNotFoundError(),
    );
    const app = buildApp({ auth: auth(), admin });
    const request = (method: "PATCH" | "DELETE", payload?: object) =>
      app.inject({
        method,
        url: `/api/v1/admin/platform-agents/${agentId}`,
        cookies: { [AUTH_COOKIE_NAME]: "admin-token" },
        ...(payload ? { payload } : {}),
      });

    const conflict = await request("PATCH", { name: "x", arkVersion: "1" });
    const unavailable = await request("PATCH", { name: "x", arkVersion: "1" });
    const referenced = await request("DELETE");
    const missing = await request("PATCH", { status: "disabled" });

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("ARK_CONFLICT");
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json().error.code).toBe("ARK_UNAVAILABLE");
    expect(referenced.statusCode).toBe(409);
    expect(referenced.json().error).toMatchObject({
      code: "VALIDATION_FAILED",
      retryable: false,
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it("keeps all admin routes forbidden to ordinary users", async () => {
    const admin = adminService();
    const app = buildApp({ auth: auth(), admin });
    const requests = [
      ["GET", "/api/v1/admin/platform-agents", undefined],
      [
        "POST",
        "/api/v1/admin/platform-agents",
        {
          name: "Agent",
          modelId: "model-a",
          systemPrompt: "",
        },
      ],
      [
        "PATCH",
        `/api/v1/admin/platform-agents/${agentId}`,
        {
          status: "disabled",
        },
      ],
      ["DELETE", `/api/v1/admin/platform-agents/${agentId}`, undefined],
      ["GET", "/api/v1/admin/users", undefined],
      [
        "PUT",
        `/api/v1/admin/users/${userId}/default-agent`,
        {
          platformAgentId: agentId,
        },
      ],
      [
        "PUT",
        `/api/v1/admin/users/${userId}/quota`,
        {
          personalAgentLimit: 10,
          concurrentSessionLimit: 2,
          dailySessionLimit: 20,
          monthlyTokenLimit: 1000,
        },
      ],
    ] as const;

    for (const [method, url, payload] of requests) {
      const response = await app.inject({
        method,
        url,
        cookies: { [AUTH_COOKIE_NAME]: "user-token" },
        ...(payload ? { payload } : {}),
      });
      expect(response.statusCode).toBe(403);
    }
    expect(
      Object.values(admin).every((call) => call.mock.calls.length === 0),
    ).toBe(true);
    await app.close();
  });

  it("lists minimized users and supports strict default and quota updates", async () => {
    const admin = adminService();
    const app = buildApp({ auth: auth(), admin });
    const cookie = { [AUTH_COOKIE_NAME]: "admin-token" };
    const users = await app.inject({
      method: "GET",
      url: "/api/v1/admin/users",
      cookies: cookie,
    });
    const assignment = await app.inject({
      method: "PUT",
      url: `/api/v1/admin/users/${userId}/default-agent`,
      cookies: cookie,
      payload: { platformAgentId: agentId },
    });
    const quota = await app.inject({
      method: "PUT",
      url: `/api/v1/admin/users/${userId}/quota`,
      cookies: cookie,
      payload: {
        personalAgentLimit: 10,
        concurrentSessionLimit: 2,
        dailySessionLimit: 20,
        monthlyTokenLimit: 1000,
      },
    });

    expect(users.statusCode).toBe(200);
    expect(users.json()).toEqual({
      users: [
        {
          id: userId,
          email: "user@example.com",
          role: "user",
          status: "active",
          hasPassword: true,
          defaultAgentId: agentId,
          createdAt: "2026-09-01T00:00:00.000Z",
          quota: {
            personalAgentLimit: 10,
            concurrentSessionLimit: 2,
            dailySessionLimit: 20,
            monthlyTokenLimit: 1000,
          },
        },
      ],
    });
    expect(users.body).not.toContain("authSubject");
    expect(users.body).not.toContain("sessions");
    expect(users.body).not.toContain("artifacts");
    expect(assignment.json()).toEqual({
      userId,
      platformAgentId: agentId,
      assignedAt: "2026-09-06T00:00:00.000Z",
    });
    expect(quota.json()).not.toHaveProperty("secret");

    const invalidQuota = await app.inject({
      method: "PUT",
      url: `/api/v1/admin/users/${userId}/quota`,
      cookies: cookie,
      payload: {
        personalAgentLimit: 10,
        concurrentSessionLimit: 2,
        dailySessionLimit: 20,
        monthlyTokenLimit: 1000,
        ownerId: userId,
      },
    });
    expect(invalidQuota.statusCode).toBe(400);
    expect(admin.updateUserQuota).toHaveBeenCalledTimes(1);
    await app.close();
  });
});

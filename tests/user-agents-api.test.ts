import { describe, expect, it, vi } from "vitest";
import { ArkGatewayError } from "../packages/ark-client/src/index.js";
import {
  AgentConflictError,
  PersonalAgentQuotaExceededError,
  ResourceNotFoundError,
} from "../packages/domain/src/index.js";
import {
  AUTH_COOKIE_NAME,
  buildApp,
  type ApiAuthService,
  type UserAgentApiService,
} from "../apps/api/src/app.js";

const userId = "00000000-0000-4000-8000-000000000001";
const agentId = "00000000-0000-4000-8000-000000000002";
const platformId = "00000000-0000-4000-8000-000000000003";

function auth(): ApiAuthService {
  return {
    async login() {
      return { token: "user-token", expiresAt: new Date(Date.now() + 60_000) };
    },
    async authenticate(token) {
      return token === "admin-token"
        ? { userId: "admin", authSubject: "managed:admin", role: "admin" }
        : { userId, authSubject: "managed:user", role: "user" };
    },
    async renew() {
      return { expiresAt: new Date(Date.now() + 60_000) };
    },
    async logout() {},
  };
}

const platform = {
  id: platformId,
  arkAgentId: "ark-platform-secret",
  name: "Platform",
  description: "Shared",
  modelId: "model-a",
  systemPrompt: "Private platform prompt",
  arkVersion: "4",
  version: "4",
  status: "active" as const,
  kind: "platform" as const,
  editable: false,
};

const personal = {
  id: agentId,
  ownerUserId: userId,
  arkAgentId: "ark-personal-secret",
  name: "Personal",
  description: "Mine",
  modelId: "model-a",
  systemPrompt: "My prompt",
  arkVersion: "2",
  version: "2",
  status: "active" as const,
  kind: "personal" as const,
  editable: true,
  lastErrorCode: null,
};

function userAgentService() {
  return {
    list: vi.fn(async () => ({
      agents: [platform, personal],
      selection: { agentId, source: "recent" as const },
      blocker: null,
    })),
    get: vi.fn(async () => personal),
    create: vi.fn(async () => personal),
    update: vi.fn(async () => ({ ...personal, arkVersion: "3" })),
    delete: vi.fn(async () => undefined),
  } satisfies UserAgentApiService;
}

describe("user Agent API", () => {
  it("serves strict list/get/create/update/delete routes with minimized output", async () => {
    const service = userAgentService();
    const app = buildApp({ auth: auth(), userAgents: service });
    const cookies = { [AUTH_COOKIE_NAME]: "user-token" };
    service.get.mockResolvedValueOnce(platform);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/agents",
      cookies,
    });
    const getPlatform = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${platformId}`,
      cookies,
    });
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      cookies,
      payload: {
        name: "Personal",
        description: "Mine",
        modelId: "model-a",
        systemPrompt: "My prompt",
      },
    });
    const update = await app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${agentId}`,
      cookies,
      payload: { name: "Updated", arkVersion: "2" },
    });
    const remove = await app.inject({
      method: "DELETE",
      url: `/api/v1/agents/${agentId}`,
      cookies,
    });

    expect([
      list.statusCode,
      getPlatform.statusCode,
      create.statusCode,
      update.statusCode,
      remove.statusCode,
    ]).toEqual([200, 200, 201, 200, 204]);
    expect(list.json()).toMatchObject({
      agents: [
        { id: platformId, kind: "platform", editable: false, version: "4" },
        { id: agentId, kind: "personal", editable: true, version: "2" },
      ],
      selection: { agentId, source: "recent" },
      blocker: null,
    });
    expect(JSON.stringify(list.json())).not.toContain("arkAgent");
    expect(JSON.stringify(list.json())).not.toContain("systemPrompt");
    expect(getPlatform.json()).not.toHaveProperty("systemPrompt");
    expect(create.json()).toMatchObject({
      id: agentId,
      kind: "personal",
      editable: true,
      version: "2",
      systemPrompt: "My prompt",
    });
    expect(service.update).toHaveBeenCalledWith(
      agentId,
      { name: "Updated", arkVersion: "2" },
      expect.objectContaining({ userId }),
    );

    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      cookies,
      payload: {
        name: "Injected",
        modelId: "model-a",
        systemPrompt: "",
        ownerUserId: "other",
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(service.create).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("returns a clear no-default blocker and exposes no version operation routes", async () => {
    const service = userAgentService();
    service.list.mockResolvedValueOnce({
      agents: [],
      selection: null,
      blocker: {
        code: "NO_DEFAULT_AGENT",
        message: "Contact an administrator to assign a default Agent",
      },
    });
    const app = buildApp({ auth: auth(), userAgents: service });
    const cookies = { [AUTH_COOKIE_NAME]: "user-token" };

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/agents",
      cookies,
    });
    expect(list.json()).toEqual({
      agents: [],
      selection: null,
      blocker: {
        code: "NO_DEFAULT_AGENT",
        message: "Contact an administrator to assign a default Agent",
      },
    });

    for (const suffix of ["history", "diff", "rollback"]) {
      const response = await app.inject({
        method: suffix === "rollback" ? "POST" : "GET",
        url: `/api/v1/agents/${agentId}/${suffix}`,
        cookies,
      });
      expect(response.statusCode).toBe(404);
    }
    await app.close();
  });

  it("maps tenant, quota, conflict, and retryable Ark failures", async () => {
    const service = userAgentService();
    service.get.mockRejectedValueOnce(new ResourceNotFoundError());
    service.create.mockRejectedValueOnce(new PersonalAgentQuotaExceededError());
    service.update.mockRejectedValueOnce(new AgentConflictError());
    service.delete.mockRejectedValueOnce(
      Object.assign(new Error("Personal Agent creation is still pending"), {
        name: "PersonalAgentBusyError",
        code: "AGENT_BUSY",
      }),
    );
    service.delete.mockRejectedValueOnce(new ArkGatewayError("unavailable"));
    const app = buildApp({ auth: auth(), userAgents: service });
    const cookies = { [AUTH_COOKIE_NAME]: "user-token" };

    const missing = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${agentId}`,
      cookies,
    });
    const quota = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      cookies,
      payload: { name: "A", modelId: "model-a", systemPrompt: "" },
    });
    const conflict = await app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${agentId}`,
      cookies,
      payload: { name: "B", arkVersion: "2" },
    });
    const busy = await app.inject({
      method: "DELETE",
      url: `/api/v1/agents/${agentId}`,
      cookies,
    });
    const unavailable = await app.inject({
      method: "DELETE",
      url: `/api/v1/agents/${agentId}`,
      cookies,
    });

    expect(missing.statusCode).toBe(404);
    expect(quota.statusCode).toBe(429);
    expect(quota.json().error.code).toBe("QUOTA_EXCEEDED");
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("ARK_CONFLICT");
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error).toMatchObject({
      code: "AGENT_BUSY",
      retryable: true,
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json().error).toMatchObject({
      code: "ARK_UNAVAILABLE",
      retryable: true,
    });
    await app.close();
  });

  it("serves administrators every user Agent route for their own library", async () => {
    const service = userAgentService();
    const app = buildApp({ auth: auth(), userAgents: service });
    const cookies = { [AUTH_COOKIE_NAME]: "admin-token" };

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/agents",
      cookies,
    });
    expect(list.statusCode).toBe(200);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      cookies,
      payload: { name: "A", modelId: "model-a", systemPrompt: "" },
    });
    expect(created.statusCode).toBe(201);
    const get = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${agentId}`,
      cookies,
    });
    expect(get.statusCode).toBe(200);
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${agentId}`,
      cookies,
      payload: { name: "B", arkVersion: "2" },
    });
    expect(updated.statusCode).toBe(200);
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/agents/${agentId}`,
      cookies,
    });
    expect(deleted.statusCode).toBe(204);

    expect(service.list).toHaveBeenCalledWith("admin");
    expect(service.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: "A" }),
      expect.objectContaining({ userId: "admin" }),
    );
    expect(service.get).toHaveBeenCalledWith("admin", agentId);
    expect(service.update).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({ name: "B" }),
      expect.objectContaining({ userId: "admin" }),
    );
    expect(service.delete).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({ userId: "admin" }),
    );
    await app.close();
  });
});

import { describe, expect, it, vi } from "vitest";
import { AuthRequiredError } from "@pwa/auth";
import {
  AUTH_COOKIE_NAME,
  buildApp,
  type AdminService,
  type ApiAuthService,
  type SkillApiService,
  type UserAgentApiService,
} from "../apps/api/src/app.js";
import {
  InvalidSkillPackageError,
  ResourceNotFoundError,
  SkillNotSelectableError,
  type SkillRecord,
} from "../packages/domain/src/index.js";

const userAgentService = {
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
} satisfies UserAgentApiService;

const userId = "00000000-0000-4000-8000-000000000001";
const skillId = "00000000-0000-4000-8000-000000000002";

function auth(): ApiAuthService {
  return {
    async login() {
      return { token: "user-token", expiresAt: new Date(Date.now() + 60_000) };
    },
    async authenticate(token) {
      if (token !== "user-token" && token !== "admin-token") {
        throw new AuthRequiredError();
      }
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

function skill(overrides: Partial<SkillRecord> = {}): SkillRecord {
  return {
    id: skillId,
    ownerUserId: userId,
    arkSkillId: "ark-skill-secret",
    name: "demo",
    displayTitle: "Demo",
    description: "A demo skill",
    latestVersion: "3",
    source: "custom",
    fileName: "demo.zip",
    fileSize: 2048,
    status: "active",
    lastErrorCode: null,
    createdAt: new Date("2026-09-12T00:00:00Z"),
    updatedAt: new Date("2026-09-12T01:00:00Z"),
    ...overrides,
  };
}

function skillService() {
  const uploaded = skill();
  return {
    list: vi.fn(async () => [uploaded]),
    upload: vi.fn(async () => ({
      skill: uploaded,
      defaultAgentSync: { synced: true } as const,
    })),
    update: vi.fn(async () => ({
      skill: { ...uploaded, displayTitle: "Renamed" },
      defaultAgentSync: { synced: false, errorCode: "QUOTA_EXCEEDED" } as const,
    })),
    delete: vi.fn(async () => ({ synced: true }) as const),
    resolveBindings: vi.fn(async () => [
      { skillId, arkSkillId: "ark-skill-secret", arkVersion: "3" },
    ]),
  } satisfies SkillApiService & { resolveBindings: ReturnType<typeof vi.fn> };
}

function adminService(): AdminService {
  return {
    listPlatformAgents: vi.fn(async () => []),
    listUserAgents: vi.fn(async () => [
      {
        id: "00000000-0000-4000-8000-0000000000f1",
        name: "My Agent",
        description: "Auto default",
        modelId: "model-a",
        arkVersion: "2",
        status: "active" as const,
        isAutoDefault: true,
        ownerUserId: userId,
        ownerEmail: "user@example.com",
        skills: [{ id: skillId, displayTitle: "Demo" }],
        createdAt: new Date("2026-09-12T00:00:00Z"),
        updatedAt: new Date("2026-09-12T01:00:00Z"),
      },
    ]),
    createPlatformAgent: vi.fn(),
    updatePlatformAgent: vi.fn(),
    deletePlatformAgent: vi.fn(),
    listUsers: vi.fn(),
    createUser: vi.fn(),
    resetUserPassword: vi.fn(),
    setUserStatus: vi.fn(),
    setUserRole: vi.fn(),
    revokeUserSessions: vi.fn(),
    assignDefaultAgent: vi.fn(),
    updateUserQuota: vi.fn(),
  } as unknown as AdminService;
}

describe("skills API", () => {
  it("uploads, lists, edits, and deletes skills with minimized output", async () => {
    const service = skillService();
    const app = buildApp({ auth: auth(), skills: service });
    const cookies = { [AUTH_COOKIE_NAME]: "user-token" };

    const upload = await app.inject({
      method: "POST",
      url: "/api/v1/skills",
      cookies,
      payload: await (async () => {
        const form = new FormData();
        form.set(
          "file",
          new Blob([new Uint8Array([80, 75])], { type: "application/zip" }),
          "demo.zip",
        );
        form.set("displayTitle", "Demo");
        return form;
      })(),
    });
    expect(upload.statusCode).toBe(201);
    expect(upload.json()).toMatchObject({
      displayTitle: "Demo",
      status: "active",
      defaultAgentSync: { synced: true },
    });
    expect(JSON.stringify(upload.json())).not.toContain("ark-skill-secret");
    const uploadFile = service.upload.mock.calls[0]?.[0].file;
    expect(uploadFile).toMatchObject({ name: "demo.zip" });
    expect(service.upload.mock.calls[0]?.[0].displayTitle).toBe("Demo");

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/skills?scope=custom&q=demo",
      cookies,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().skills[0]).toMatchObject({
      id: skillId,
      displayTitle: "Demo",
      preset: false,
      latestVersion: "3",
    });
    expect(JSON.stringify(list.json())).not.toContain("arkSkillId");
    expect(service.list).toHaveBeenCalledWith(userId, {
      scope: "custom",
      search: "demo",
    });

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/skills/${skillId}`,
      cookies,
      payload: (() => {
        const form = new FormData();
        form.set("displayTitle", "Renamed");
        return form;
      })(),
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({
      displayTitle: "Renamed",
      defaultAgentSync: { synced: false, errorCode: "QUOTA_EXCEEDED" },
    });

    const remove = await app.inject({
      method: "DELETE",
      url: `/api/v1/skills/${skillId}`,
      cookies,
    });
    expect(remove.statusCode).toBe(200);
    expect(remove.json()).toEqual({ defaultAgentSync: { synced: true } });
    await app.close();
  });

  it("rejects uploads without a file and maps package errors", async () => {
    const service = skillService();
    const app = buildApp({ auth: auth(), skills: service });
    const cookies = { [AUTH_COOKIE_NAME]: "user-token" };

    const empty = await app.inject({
      method: "POST",
      url: "/api/v1/skills",
      cookies,
      payload: (() => {
        const form = new FormData();
        form.set("displayTitle", "No file");
        return form;
      })(),
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error.code).toBe("INVALID_MULTIPART");

    service.upload.mockRejectedValueOnce(new InvalidSkillPackageError());
    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/skills",
      cookies,
      payload: (() => {
        const form = new FormData();
        form.set(
          "file",
          new Blob([new Uint8Array([1])], { type: "text/plain" }),
          "skill.txt",
        );
        return form;
      })(),
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe("INVALID_SKILL_PACKAGE");
    await app.close();
  });

  it("maps missing skills and unavailable selections", async () => {
    const service = skillService();
    service.update.mockRejectedValueOnce(new ResourceNotFoundError());
    const app = buildApp({
      auth: auth(),
      skills: service,
      userAgents: userAgentService,
    });
    userAgentService.create.mockResolvedValueOnce({} as never);
    const cookies = { [AUTH_COOKIE_NAME]: "user-token" };

    const missing = await app.inject({
      method: "PATCH",
      url: `/api/v1/skills/${skillId}`,
      cookies,
      payload: (() => {
        const form = new FormData();
        form.set("displayTitle", "Ghost");
        return form;
      })(),
    });
    expect(missing.statusCode).toBe(404);

    service.resolveBindings.mockRejectedValueOnce(new SkillNotSelectableError());
    const unavailable = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      cookies,
      payload: {
        name: "Bound",
        modelId: "model-a",
        systemPrompt: "",
        skillIds: [skillId],
      },
    });
    expect(unavailable.statusCode).toBe(400);
    expect(unavailable.json().error.code).toBe("SKILL_NOT_AVAILABLE");
    await app.close();
  });

  it("keeps skill routes tenant-scoped and rejects administrators", async () => {
    const service = skillService();
    const app = buildApp({ auth: auth(), skills: service });
    const adminCookies = { [AUTH_COOKIE_NAME]: "admin-token" };

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/skills",
      cookies: adminCookies,
    });
    expect(list.statusCode).toBe(404);
    const upload = await app.inject({
      method: "POST",
      url: "/api/v1/skills",
      cookies: adminCookies,
      payload: (() => {
        const form = new FormData();
        form.set(
          "file",
          new Blob([new Uint8Array([80, 75])], { type: "application/zip" }),
          "demo.zip",
        );
        return form;
      })(),
    });
    expect(upload.statusCode).toBe(404);
    expect(service.list).not.toHaveBeenCalled();
    expect(service.upload).not.toHaveBeenCalled();

    const unauthenticated = await app.inject({
      method: "GET",
      url: "/api/v1/skills",
    });
    expect(unauthenticated.statusCode).toBe(401);
    await app.close();
  });

  it("lets administrators list every user Agent with owner and skills", async () => {
    const service = skillService();
    const admin = adminService();
    const app = buildApp({ auth: auth(), skills: service, admin });
    const cookies = { [AUTH_COOKIE_NAME]: "admin-token" };

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/user-agents",
      cookies,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      agents: [
        {
          id: "00000000-0000-4000-8000-0000000000f1",
          name: "My Agent",
          description: "Auto default",
          modelId: "model-a",
          version: "2",
          status: "active",
          isAutoDefault: true,
          ownerUserId: userId,
          ownerEmail: "user@example.com",
          skills: [{ id: skillId, displayTitle: "Demo" }],
          createdAt: "2026-09-12T00:00:00.000Z",
          updatedAt: "2026-09-12T01:00:00.000Z",
        },
      ],
    });

    // The same route stays invisible to ordinary users.
    const forbidden = await app.inject({
      method: "GET",
      url: "/api/v1/admin/user-agents",
      cookies: { [AUTH_COOKIE_NAME]: "user-token" },
    });
    expect(forbidden.statusCode).toBe(403);
    await app.close();
  });
});

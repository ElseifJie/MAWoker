import { describe, expect, it, vi } from "vitest";
import { AUTH_COOKIE_NAME, buildApp } from "../apps/api/src/app.js";
import { AuthRequiredError } from "../packages/auth/src/index.js";
import { AssistantProfileConflictError } from "../packages/domain/src/index.js";

const userId = "00000000-0000-4000-8000-000000000001";

const view = {
  profile: {
    ownerUserId: userId,
    defaultAgentId: "00000000-0000-4000-8000-000000000010",
    displayName: "Assistant",
    persona: "Concise.",
    preferences: { tone: "brief" },
    revision: 2,
    createdAt: new Date("2026-10-17T00:00:00.000Z"),
    updatedAt: new Date("2026-10-17T00:01:00.000Z"),
  },
  agent: {
    id: "00000000-0000-4000-8000-000000000010",
    name: "Assistant",
    modelId: "model-a",
    status: "active",
    arkAgentId: "ark-agent-1",
  },
};

function auth(reject = false) {
  return {
    login: vi.fn(),
    authenticate: vi.fn(async () => {
      if (reject) throw new AuthRequiredError();
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

describe("Assistant profile API", () => {
  it("returns the default assistant with the linked agent", async () => {
    const get = vi.fn(async () => view);
    const app = buildApp({
      auth: auth(),
      assistant: { get, update: vi.fn(async () => view) },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/assistant/profile",
      cookies: { [AUTH_COOKIE_NAME]: "token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      profile: {
        displayName: "Assistant",
        revision: 2,
        createdAt: "2026-10-17T00:00:00.000Z",
      },
      agent: { id: view.agent.id, modelId: "model-a" },
    });
    expect(get).toHaveBeenCalledWith(userId);
    await app.close();
  });

  it("updates identity and preferences for the caller", async () => {
    const update = vi.fn(async () => view);
    const app = buildApp({
      auth: auth(),
      assistant: { get: vi.fn(async () => view), update },
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/assistant/profile",
      cookies: { [AUTH_COOKIE_NAME]: "token" },
      payload: {
        displayName: "Assistant",
        persona: "Concise.",
        preferences: { tone: "brief" },
        expectedRevision: 2,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(update).toHaveBeenCalledWith(userId, {
      displayName: "Assistant",
      persona: "Concise.",
      preferences: { tone: "brief" },
      expectedRevision: 2,
    });
    await app.close();
  });

  it("returns one conflict envelope for a stale revision", async () => {
    const app = buildApp({
      auth: auth(),
      assistant: {
        get: vi.fn(async () => view),
        update: vi.fn(async () => {
          throw new AssistantProfileConflictError();
        }),
      },
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/assistant/profile",
      cookies: { [AUTH_COOKIE_NAME]: "token" },
      payload: { displayName: "Stale", expectedRevision: 1 },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: "ASSISTANT_PROFILE_CONFLICT" },
    });
    await app.close();
  });

  it("does not serve the assistant without authentication", async () => {
    const app = buildApp({
      auth: auth(true),
      assistant: { get: vi.fn(async () => view), update: vi.fn() },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/assistant/profile",
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });
});

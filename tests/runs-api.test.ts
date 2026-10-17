import { describe, expect, it, vi } from "vitest";
import { AUTH_COOKIE_NAME, buildApp } from "../apps/api/src/app.js";
import { AuthRequiredError } from "../packages/auth/src/index.js";
import { ResourceNotFoundError } from "../packages/domain/src/index.js";

const userId = "00000000-0000-4000-8000-000000000001";
const runId = "00000000-0000-4000-8000-000000000010";

const run = {
  id: runId,
  ownerUserId: userId,
  conversationId: "00000000-0000-4000-8000-000000000002",
  triggerKind: "manual" as const,
  submissionId: "00000000-0000-4000-8000-000000000003",
  status: "running" as const,
  arkSessionId: "ark-session-1",
  turnId: null,
  automationId: null,
  errorCode: null,
  startedAt: new Date("2026-10-17T00:01:00.000Z"),
  endedAt: null,
  version: 2,
  createdAt: new Date("2026-10-17T00:00:00.000Z"),
  updatedAt: new Date("2026-10-17T00:01:00.000Z"),
};

function appWith(get: (userId: string, id: string) => Promise<typeof run>) {
  return buildApp({
    auth: {
      login: vi.fn(),
      authenticate: vi.fn(async () => ({
        userId,
        authSubject: "subject-user",
        email: "user@example.com",
        role: "user" as const,
      })),
      renew: vi.fn(async () => ({
        expiresAt: new Date("2026-09-07T00:00:00.000Z"),
      })),
      logout: vi.fn(),
    },
    runs: { get },
  });
}

describe("Run API", () => {
  it("returns the caller's Run with ISO timestamps", async () => {
    const get = vi.fn(async () => run);
    const app = appWith(get);

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}`,
      cookies: { [AUTH_COOKIE_NAME]: "token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: runId,
      conversationId: run.conversationId,
      triggerKind: "manual",
      submissionId: run.submissionId,
      status: "running",
      arkSessionId: "ark-session-1",
      turnId: null,
      errorCode: null,
      startedAt: "2026-10-17T00:01:00.000Z",
      endedAt: null,
      createdAt: "2026-10-17T00:00:00.000Z",
      updatedAt: "2026-10-17T00:01:00.000Z",
    });
    expect(get).toHaveBeenCalledWith(userId, runId);
    await app.close();
  });

  it("returns one 404 envelope for a Run the caller cannot see", async () => {
    const app = appWith(async () => {
      throw new ResourceNotFoundError();
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}`,
      cookies: { [AUTH_COOKIE_NAME]: "token" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { code: "RESOURCE_NOT_FOUND" },
    });
    await app.close();
  });

  it("does not serve Runs without authentication", async () => {
    const app = buildApp({
      auth: {
        login: vi.fn(),
        authenticate: vi.fn(async () => {
          throw new AuthRequiredError();
        }),
        renew: vi.fn(),
        logout: vi.fn(),
      },
      runs: { get: async () => run },
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}`,
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });
});

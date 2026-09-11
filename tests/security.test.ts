import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "@pwa/domain";
import {
  AUTH_COOKIE_NAME,
  buildApp,
  type ApiAuthService,
  type ArtifactApiService,
  type SessionApiService,
  type UserAgentApiService,
} from "../apps/api/src/app.js";

const userId = "00000000-0000-4000-8000-000000000001";
const resourceId = "00000000-0000-4000-8000-000000000099";
const now = new Date("2026-09-07T00:00:00.000Z");

function streamSession(): SessionRecord {
  return {
    id: resourceId,
    ownerUserId: userId,
    arkSessionId: "ark-session-1",
    agentKind: "personal",
    platformAgentId: null,
    personalAgentId: "00000000-0000-4000-8000-000000000002",
    arkAgentId: "ark-agent-1",
    agentName: "Research Agent",
    agentVersion: "7",
    environmentId: "environment-1",
    title: "Task",
    status: "running",
    lastErrorCode: null,
    errorRecoverable: null,
    archivedAt: null,
    deletionState: "none",
    lastEventAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function authService(): ApiAuthService {
  return {
    async login() {
      return {
        token: "opaque-session-token",
        expiresAt: new Date("2026-09-08T00:00:00.000Z"),
      };
    },
    async authenticate(token) {
      if (token !== "user-token") throw new Error("unexpected token");
      return {
        userId,
        authSubject: "managed:user@example.com",
        role: "user",
      };
    },
    async renew() {
      return { expiresAt: new Date("2026-09-08T00:00:00.000Z") };
    },
    async logout() {},
  };
}

describe("API perimeter security", () => {
  it("rejects cross-origin requests and applies restrictive browser headers", async () => {
    const app = buildApp({
      appOrigin: "https://assistant.example.com",
      isProduction: true,
    });

    const rejected = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://attacker.example.com" },
    });
    const sameOrigin = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://assistant.example.com" },
    });

    expect(rejected.statusCode).toBe(403);
    expect(rejected.headers["access-control-allow-origin"]).toBeUndefined();
    expect(sameOrigin.statusCode).toBe(200);
    expect(sameOrigin.headers["access-control-allow-origin"]).toBe(
      "https://assistant.example.com",
    );
    expect(sameOrigin.headers["content-security-policy"]).toContain(
      "default-src 'self'",
    );
    expect(sameOrigin.headers["content-security-policy"]).toContain(
      "object-src 'none'",
    );
    expect(sameOrigin.headers["x-content-type-options"]).toBe("nosniff");
    expect(sameOrigin.headers["x-frame-options"]).toBe("DENY");
    expect(sameOrigin.headers["referrer-policy"]).toBe("no-referrer");
    expect(sameOrigin.headers["permissions-policy"]).toBe(
      "camera=(), microphone=(), geolocation=()",
    );
    expect(sameOrigin.headers["strict-transport-security"]).toContain(
      "max-age=31536000",
    );
    await app.close();
  });

  it("rate limits bounded API requests deterministically", async () => {
    const app = buildApp({
      auth: authService(),
      rateLimit: { max: 2, windowMs: 60_000 },
    });

    const responses = await Promise.all(
      Array.from({ length: 3 }, () =>
        app.inject({
          method: "POST",
          url: "/api/v1/auth/login",
          remoteAddress: "192.0.2.10",
          payload: { email: "user@example.com", password: "secret-password" },
        }),
      ),
    );

    expect(responses.map(({ statusCode }) => statusCode)).toEqual([
      204, 204, 429,
    ]);
    expect(responses[2]?.headers["retry-after"]).toBe("60");
    expect(responses[2]?.json()).toMatchObject({
      error: { code: "RATE_LIMITED", retryable: true },
    });
    await app.close();
  });

  it("evicts old request windows when the bounded store reaches capacity", async () => {
    const app = buildApp({
      auth: authService(),
      rateLimit: { max: 1, windowMs: 60_000, maxEntries: 2 },
    });

    for (const remoteAddress of ["192.0.2.1", "192.0.2.2", "192.0.2.3"]) {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/me",
        remoteAddress,
        cookies: { [AUTH_COOKIE_NAME]: "user-token" },
      });
      expect(response.statusCode).toBe(200);
    }

    const evictedClient = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      remoteAddress: "192.0.2.1",
      cookies: { [AUTH_COOKIE_NAME]: "user-token" },
    });

    expect(evictedClient.statusCode).toBe(200);
    await app.close();
  });

  it("does not spend the bounded API budget on SSE or artifact downloads", async () => {
    const sessions = {
      openEvents: vi.fn(async () => ({
        session: streamSession(),
        events: (async function* () {})(),
      })),
    } as unknown as SessionApiService;
    const artifacts = {
      download: vi.fn(async () => ({
        name: "result.txt",
        mimeType: "text/plain",
        sizeBytes: 2,
        stream: Readable.from(["ok"]),
      })),
    } as unknown as ArtifactApiService;
    const app = buildApp({
      auth: authService(),
      sessions,
      artifacts,
      rateLimit: { max: 1, windowMs: 60_000 },
    });
    const request = {
      remoteAddress: "192.0.2.11",
      cookies: { [AUTH_COOKIE_NAME]: "user-token" },
    };

    const limitedBudget = await app.inject({
      ...request,
      method: "GET",
      url: "/api/v1/me",
    });
    const events = await app.inject({
      ...request,
      method: "GET",
      url: `/api/v1/sessions/${resourceId}/events`,
    });
    const download = await app.inject({
      ...request,
      method: "GET",
      url: `/api/v1/artifacts/${resourceId}/download`,
    });
    const repeatedEvents = await app.inject({
      ...request,
      method: "GET",
      url: `/api/v1/sessions/${resourceId}/events`,
    });
    const repeatedDownload = await app.inject({
      ...request,
      method: "GET",
      url: `/api/v1/artifacts/${resourceId}/download`,
    });

    expect(limitedBudget.statusCode).toBe(200);
    expect(events.statusCode).toBe(200);
    expect(events.headers["content-type"]).toContain("text/event-stream");
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe("ok");
    expect(repeatedEvents.statusCode).toBe(429);
    expect(repeatedDownload.statusCode).toBe(429);
    await app.close();
  });

  it("limits active SSE streams per authenticated user and session across windows", async () => {
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let openCount = 0;
    const sessions = {
      openEvents: vi.fn(async () => {
        openCount += 1;
        if (openCount > 1) {
          return { session: streamSession(), events: Readable.from([]) };
        }
        return {
          session: streamSession(),
          events: (async function* () {
            markFirstStarted();
            yield {
              id: "event-active",
              sourceType: "agent.message",
              type: "message" as const,
              createdAt: "2026-09-07T00:00:00.000Z",
              payload: { content: "active" },
            };
            await firstReleased;
          })(),
        };
      }),
    } as unknown as SessionApiService;
    const app = buildApp({
      auth: authService(),
      sessions,
      rateLimit: { max: 1, windowMs: 10 },
    });
    const request = {
      method: "GET" as const,
      url: `/api/v1/sessions/${resourceId}/events`,
      remoteAddress: "192.0.2.12",
      cookies: { [AUTH_COOKIE_NAME]: "user-token" },
    };

    const firstResponse = app.inject(request);
    await firstStarted;
    await new Promise((resolve) => setTimeout(resolve, 15));

    const whileActive = await app.inject(request);
    expect(whileActive.statusCode).toBe(429);
    expect(sessions.openEvents).toHaveBeenCalledTimes(1);

    releaseFirst();
    expect((await firstResponse).statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 15));

    const afterCompletion = await app.inject(request);
    expect(afterCompletion.statusCode).toBe(200);
    expect(sessions.openEvents).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("releases the active SSE slot when opening the upstream fails", async () => {
    const sessions = {
      openEvents: vi
        .fn()
        .mockRejectedValueOnce(new Error("upstream unavailable"))
        .mockResolvedValueOnce({
          session: streamSession(),
          events: Readable.from([]),
        }),
    } as unknown as SessionApiService;
    const app = buildApp({
      auth: authService(),
      sessions,
      rateLimit: { max: 1, windowMs: 10 },
    });
    const request = {
      method: "GET" as const,
      url: `/api/v1/sessions/${resourceId}/events`,
      remoteAddress: "192.0.2.13",
      cookies: { [AUTH_COOKIE_NAME]: "user-token" },
    };

    expect((await app.inject(request)).statusCode).toBe(500);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect((await app.inject(request)).statusCode).toBe(200);
    expect(sessions.openEvents).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("releases the active SSE slot after a downstream disconnect", async () => {
    let streamStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      streamStarted = resolve;
    });
    let streamReleased = false;
    let openCount = 0;
    const sessions = {
      openEvents: vi.fn(async (_id, _context, signal?: AbortSignal) => {
        openCount += 1;
        if (openCount > 1) {
          return { session: streamSession(), events: Readable.from([]) };
        }
        return {
          session: streamSession(),
          events: (async function* () {
            try {
              streamStarted();
              yield {
                id: "event-disconnect",
                sourceType: "agent.message",
                type: "message" as const,
                createdAt: "2026-09-07T00:00:00.000Z",
                payload: { content: "connected" },
              };
              await new Promise<void>((resolve) => {
                signal?.addEventListener("abort", () => resolve(), {
                  once: true,
                });
              });
            } finally {
              streamReleased = true;
            }
          })(),
        };
      }),
    } as unknown as SessionApiService;
    const app = buildApp({
      auth: authService(),
      sessions,
      rateLimit: { max: 1, windowMs: 10 },
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as AddressInfo;
    let closeFirst!: () => void;
    const connected = new Promise<void>((resolve) => {
      const request = httpRequest({
        host: "127.0.0.1",
        port,
        path: `/api/v1/sessions/${resourceId}/events`,
        headers: { cookie: `${AUTH_COOKIE_NAME}=user-token` },
      });
      request.on("response", (response) => {
        response.once("data", () => resolve());
        closeFirst = () => response.destroy();
      });
      request.on("error", () => {});
      request.end();
    });

    await started;
    await connected;
    await new Promise((resolve) => setTimeout(resolve, 15));
    const whileConnected = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${resourceId}/events`,
      remoteAddress: "127.0.0.1",
      cookies: { [AUTH_COOKIE_NAME]: "user-token" },
    });
    expect(whileConnected.statusCode).toBe(429);

    closeFirst();
    await vi.waitFor(() => expect(streamReleased).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 15));
    const reconnected = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${resourceId}/events`,
      remoteAddress: "127.0.0.1",
      cookies: { [AUTH_COOKIE_NAME]: "user-token" },
    });
    expect(reconnected.statusCode).toBe(200);
    await app.close();
  });

  it.each(["apiKey", "environmentId", "provider", "tools", "temperature"])(
    "rejects undeclared personal Agent field %s before calling the service",
    async (field) => {
      const create = vi.fn();
      const app = buildApp({
        auth: authService(),
        userAgents: { create } as unknown as UserAgentApiService,
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/agents",
        cookies: { [AUTH_COOKIE_NAME]: "user-token" },
        payload: {
          name: "Agent",
          modelId: "allowed-model",
          systemPrompt: "Safe prompt",
          [field]: "client-controlled",
        },
      });

      expect(response.statusCode).toBe(400);
      expect(create).not.toHaveBeenCalled();
      await app.close();
    },
  );
});

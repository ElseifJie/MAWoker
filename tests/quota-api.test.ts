import { describe, expect, it, vi } from "vitest";
import { AUTH_COOKIE_NAME, buildApp } from "../apps/api/src/app.js";

const userId = "00000000-0000-4000-8000-000000000001";

describe("quota and usage API", () => {
  it("returns a minimized summary for the authenticated user", async () => {
    const quotaUsage = {
      getSummary: vi.fn(async () => ({
        period: {
          startsAt: new Date("2026-09-01T00:00:00.000Z"),
          endsAt: new Date("2026-10-01T00:00:00.000Z"),
        },
        quota: {
          personalAgentLimit: 10,
          concurrentSessionLimit: 2,
          dailySessionLimit: 25,
          monthlyTokenLimit: 1000,
        },
        usage: {
          personalAgents: 3,
          concurrentSessions: 1,
          dailySessions: 4,
          inputTokens: 120,
          outputTokens: 30,
          tokens: 150,
          runtimeMs: 5000,
          toolCalls: 6,
        },
        exhausted: {
          personalAgents: false,
          concurrentSessions: false,
          dailySessions: false,
          monthlyTokens: false,
        },
      })),
    };
    const app = buildApp({
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
      quotaUsage,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/usage",
      cookies: { [AUTH_COOKIE_NAME]: "token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      period: {
        startsAt: "2026-09-01T00:00:00.000Z",
        endsAt: "2026-10-01T00:00:00.000Z",
      },
      quota: {
        personalAgentLimit: 10,
        concurrentSessionLimit: 2,
        dailySessionLimit: 25,
        monthlyTokenLimit: 1000,
      },
      usage: {
        personalAgents: 3,
        concurrentSessions: 1,
        dailySessions: 4,
        inputTokens: 120,
        outputTokens: 30,
        tokens: 150,
        runtimeMs: 5000,
        toolCalls: 6,
      },
      exhausted: {
        personalAgents: false,
        concurrentSessions: false,
        dailySessions: false,
        monthlyTokens: false,
      },
    });
    expect(quotaUsage.getSummary).toHaveBeenCalledWith(userId);
    expect(response.body).not.toContain("arkSessionId");
    expect(response.body).not.toContain("model_usage");
    await app.close();
  });
});

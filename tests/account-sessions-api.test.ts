import { describe, expect, it, vi } from "vitest";
import { AUTH_COOKIE_NAME, buildApp } from "../apps/api/src/app.js";

const userId = "00000000-0000-4000-8000-000000000001";
const sessionId = "00000000-0000-4000-8000-000000000010";

function auth() {
  return {
    login: vi.fn(),
    authenticate: vi.fn(async () => ({
      userId,
      sessionId,
      authSubject: "subject-user",
      email: "user@example.com",
      role: "user" as const,
    })),
    renew: vi.fn(async () => ({
      expiresAt: new Date("2026-09-07T00:00:00.000Z"),
    })),
    logout: vi.fn(),
  };
}

describe("account session API", () => {
  it("lists sessions and revokes the others", async () => {
    const accountSessions = {
      list: vi.fn(async () => [
        {
          id: sessionId,
          current: true,
          createdAt: new Date("2026-10-17T00:00:00.000Z"),
          expiresAt: new Date("2026-10-24T00:00:00.000Z"),
        },
        {
          id: "00000000-0000-4000-8000-000000000011",
          current: false,
          createdAt: new Date("2026-10-16T00:00:00.000Z"),
          expiresAt: new Date("2026-10-23T00:00:00.000Z"),
        },
      ]),
      revokeOthers: vi.fn(async () => 1),
    };
    const app = buildApp({ auth: auth(), accountSessions });

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/account/sessions",
      cookies: { [AUTH_COOKIE_NAME]: "token" },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().sessions).toEqual([
      expect.objectContaining({ id: sessionId, current: true }),
      expect.objectContaining({ current: false }),
    ]);
    expect(accountSessions.list).toHaveBeenCalledWith(
      userId,
      sessionId,
      expect.any(Date),
    );

    const revoked = await app.inject({
      method: "POST",
      url: "/api/v1/account/sessions/revoke",
      cookies: { [AUTH_COOKIE_NAME]: "token" },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toEqual({ revoked: 1 });
    await app.close();
  });
});

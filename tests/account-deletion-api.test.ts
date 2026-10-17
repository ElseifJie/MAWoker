import { describe, expect, it, vi } from "vitest";
import { AUTH_COOKIE_NAME, buildApp } from "../apps/api/src/app.js";

const userId = "00000000-0000-4000-8000-000000000001";

function auth(password = "password123") {
  return {
    login: vi.fn(async (_email: string, candidate: string) => {
      if (candidate !== password) throw new Error("bad password");
      return {
        token: "token",
        expiresAt: new Date("2026-10-24T00:00:00.000Z"),
      };
    }),
    authenticate: vi.fn(async () => ({
      userId,
      sessionId: "session-1",
      email: "owner@example.com",
      authSubject: "subject-user",
      role: "user" as const,
    })),
    renew: vi.fn(async () => ({
      expiresAt: new Date("2026-09-07T00:00:00.000Z"),
    })),
    logout: vi.fn(),
  };
}

describe("account deletion API", () => {
  it("verifies the password and deletes the account", async () => {
    const authService = auth();
    const accountDeletion = { delete: vi.fn(async () => undefined) };
    const app = buildApp({
      auth: authService,
      accountDeletion,
    });

    const response = await app.inject({
      method: "DELETE",
      url: "/api/v1/account",
      cookies: { [AUTH_COOKIE_NAME]: "token" },
      payload: { password: "password123", confirmation: "DELETE" },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ deleted: true });
    expect(authService.login).toHaveBeenCalledWith(
      "owner@example.com",
      "password123",
    );
    expect(accountDeletion.delete).toHaveBeenCalledWith(userId);
    expect(response.headers["set-cookie"]?.toString()).toContain("Max-Age=0");
    await app.close();
  });

  it("rejects a wrong password without deleting", async () => {
    const accountDeletion = { delete: vi.fn(async () => undefined) };
    const app = buildApp({ auth: auth(), accountDeletion });
    const response = await app.inject({
      method: "DELETE",
      url: "/api/v1/account",
      cookies: { [AUTH_COOKIE_NAME]: "token" },
      payload: { password: "wrong", confirmation: "DELETE" },
    });
    expect(response.statusCode).toBe(401);
    expect(accountDeletion.delete).not.toHaveBeenCalled();
    await app.close();
  });
});

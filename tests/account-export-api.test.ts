import { describe, expect, it, vi } from "vitest";
import { AUTH_COOKIE_NAME, buildApp } from "../apps/api/src/app.js";

const userId = "00000000-0000-4000-8000-000000000001";

function auth() {
  return {
    login: vi.fn(),
    authenticate: vi.fn(async (token?: string) => {
      if (!token) {
        throw Object.assign(new Error("Authentication required"), {
          name: "AuthRequiredError",
        });
      }
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

describe("account export API", () => {
  it("returns the caller's export as an attachment", async () => {
    const exportAccount = vi.fn(async () => ({
      schemaVersion: "1",
      exportedAt: "2026-10-17T00:00:00.000Z",
      user: { email: "user@example.com" },
      sessions: [{ id: "session-1" }],
    }));
    const app = buildApp({
      auth: auth(),
      accountExport: { export: exportAccount },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/account/export",
      cookies: { [AUTH_COOKIE_NAME]: "token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-disposition"]).toContain("attachment");
    expect(response.headers["content-disposition"]).toContain(
      "ma-worker-export-",
    );
    expect(response.json()).toMatchObject({
      schemaVersion: "1",
      user: { email: "user@example.com" },
    });
    expect(exportAccount).toHaveBeenCalledWith(userId);
    await app.close();
  });

  it("requires authentication", async () => {
    const app = buildApp({
      auth: auth(),
      accountExport: { export: vi.fn() },
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/account/export",
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});

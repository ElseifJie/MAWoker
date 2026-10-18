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

function consents() {
  return {
    list: vi.fn(async () => ({
      consents: [
        {
          document: "privacy",
          version: "2026-10-18",
          acceptedAt: new Date("2026-10-18T08:00:00.000Z"),
        },
      ],
      currentVersion: "2026-10-18",
      documents: ["terms", "privacy"],
    })),
    accept: vi.fn(
      async (
        _userId: string,
        input: { document: string; version: string },
      ) => ({
        document: input.document,
        version: input.version,
        acceptedAt: new Date("2026-10-18T09:00:00.000Z"),
      }),
    ),
  };
}

describe("account consents API", () => {
  it("returns the caller's accepted versions with ISO timestamps", async () => {
    const service = consents();
    const app = buildApp({ auth: auth(), consents: service });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/account/consents",
      cookies: { [AUTH_COOKIE_NAME]: "token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      consents: [
        {
          document: "privacy",
          version: "2026-10-18",
          acceptedAt: "2026-10-18T08:00:00.000Z",
        },
      ],
      currentVersion: "2026-10-18",
      documents: ["terms", "privacy"],
    });
    expect(service.list).toHaveBeenCalledWith(userId);
    await app.close();
  });

  it("records the current document version", async () => {
    const service = consents();
    const app = buildApp({ auth: auth(), consents: service });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/account/consents",
      cookies: { [AUTH_COOKIE_NAME]: "token" },
      payload: { document: "privacy", version: "2026-10-18" },
    });

    expect(response.statusCode).toBe(200);
    expect(service.accept).toHaveBeenCalledWith(userId, {
      document: "privacy",
      version: "2026-10-18",
    });
    expect(response.json()).toEqual({
      consent: {
        document: "privacy",
        version: "2026-10-18",
        acceptedAt: "2026-10-18T09:00:00.000Z",
      },
    });
    await app.close();
  });

  it("rejects a stale version with a typed error", async () => {
    const service = consents();
    service.accept.mockRejectedValueOnce(
      Object.assign(new Error("stale"), { name: "ConsentInvalidError" }),
    );
    const app = buildApp({ auth: auth(), consents: service });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/account/consents",
      cookies: { [AUTH_COOKIE_NAME]: "token" },
      payload: { document: "privacy", version: "2025-01-01" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "CONSENT_INVALID" },
    });
    await app.close();
  });

  it("requires authentication", async () => {
    const app = buildApp({ auth: auth(), consents: consents() });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/account/consents",
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });
});

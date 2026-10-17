import { describe, expect, it, vi } from "vitest";
import { AUTH_COOKIE_NAME, buildApp } from "../apps/api/src/app.js";
import {
  InvalidInviteError,
  UserEmailConflictError,
} from "../packages/domain/src/index.js";

const adminId = "00000000-0000-4000-8000-000000000001";
const inviteId = "00000000-0000-4000-8000-000000000010";

const invite = {
  id: inviteId,
  email: "invitee@example.com",
  createdBy: adminId,
  usedByUserId: null,
  status: "pending" as const,
  expiresAt: new Date("2026-10-24T00:00:00.000Z"),
  usedAt: null,
  revokedAt: null,
  createdAt: new Date("2026-10-17T00:00:00.000Z"),
  updatedAt: new Date("2026-10-17T00:00:00.000Z"),
};

function auth(role: "admin" | "user" = "admin") {
  return {
    login: vi.fn(),
    authenticate: vi.fn(async () => ({
      userId: adminId,
      authSubject: "subject-admin",
      email: "admin@example.com",
      role,
    })),
    renew: vi.fn(async () => ({
      expiresAt: new Date("2026-09-07T00:00:00.000Z"),
    })),
    logout: vi.fn(),
  };
}

function invites() {
  return {
    list: vi.fn(async () => [invite]),
    create: vi.fn(async () => ({ invite, code: "plaintext-code-123456" })),
    revoke: vi.fn(async () => ({ ...invite, status: "revoked" as const })),
    accept: vi.fn(async () => ({
      userId: "00000000-0000-4000-8000-000000000020",
      email: "invitee@example.com",
    })),
  };
}

describe("invite API", () => {
  it("creates, lists, and revokes invites for an administrator", async () => {
    const service = invites();
    const audit = { recordInvite: vi.fn(async () => undefined) };
    const app = buildApp({ auth: auth(), invites: service, audit });

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/admin/invites",
      cookies: { [AUTH_COOKIE_NAME]: "token" },
      payload: { email: "invitee@example.com", expiresInDays: 7 },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      invite: { id: inviteId, email: "invitee@example.com", status: "pending" },
      code: "plaintext-code-123456",
    });
    expect(service.create).toHaveBeenCalledWith(adminId, {
      email: "invitee@example.com",
      expiresInDays: 7,
    });
    expect(audit.recordInvite).toHaveBeenCalledWith(
      expect.objectContaining({ action: "invite.create", inviteId }),
    );

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/admin/invites",
      cookies: { [AUTH_COOKIE_NAME]: "token" },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().invites).toHaveLength(1);

    const revoked = await app.inject({
      method: "POST",
      url: `/api/v1/admin/invites/${inviteId}/revoke`,
      cookies: { [AUTH_COOKIE_NAME]: "token" },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().invite.status).toBe("revoked");
    expect(audit.recordInvite).toHaveBeenCalledWith(
      expect.objectContaining({ action: "invite.revoke", inviteId }),
    );
    await app.close();
  });

  it("accepts an invite without a session", async () => {
    const service = invites();
    const audit = { recordInvite: vi.fn(async () => undefined) };
    const app = buildApp({ auth: auth(), invites: service, audit });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/invite/accept",
      payload: { code: "plaintext-code-123456", password: "password123" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      user: {
        userId: "00000000-0000-4000-8000-000000000020",
        email: "invitee@example.com",
      },
    });
    expect(service.accept).toHaveBeenCalledWith(
      "plaintext-code-123456",
      "password123",
    );
    expect(audit.recordInvite).toHaveBeenCalledWith(
      expect.objectContaining({ action: "invite.accept" }),
    );
    await app.close();
  });

  it("maps invalid and duplicate-email invites to stable errors", async () => {
    const invalid = invites();
    invalid.accept.mockRejectedValueOnce(new InvalidInviteError());
    const invalidApp = buildApp({ auth: auth(), invites: invalid });
    const invalidResponse = await invalidApp.inject({
      method: "POST",
      url: "/api/v1/auth/invite/accept",
      payload: { code: "plaintext-code-123456", password: "password123" },
    });
    expect(invalidResponse.statusCode).toBe(400);
    expect(invalidResponse.json()).toMatchObject({
      error: { code: "INVITE_INVALID" },
    });
    await invalidApp.close();

    const conflict = invites();
    conflict.accept.mockRejectedValueOnce(new UserEmailConflictError());
    const conflictApp = buildApp({ auth: auth(), invites: conflict });
    const conflictResponse = await conflictApp.inject({
      method: "POST",
      url: "/api/v1/auth/invite/accept",
      payload: { code: "plaintext-code-123456", password: "password123" },
    });
    expect(conflictResponse.statusCode).toBe(409);
    expect(conflictResponse.json()).toMatchObject({
      error: { code: "USER_EMAIL_CONFLICT" },
    });
    await conflictApp.close();
  });
});

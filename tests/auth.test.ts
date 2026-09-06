import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ApplicationSessionService,
  AuthRequiredError,
  AuthVerificationError,
  DeterministicManagedIdentityStub,
  type AuthSessionRecord,
  type AuthStore,
  type AuthUser,
} from "../packages/auth/src/index.js";

const user: AuthUser = {
  id: "00000000-0000-4000-8000-000000000001",
  authSubject: "managed:user@example.com",
  email: "user@example.com",
  role: "user",
  status: "active",
};

class MemoryAuthStore implements AuthStore {
  readonly users = new Map<string, AuthUser>();
  readonly sessions = new Map<string, AuthSessionRecord>();

  constructor(initialUser: AuthUser = user) {
    this.users.set(initialUser.authSubject, initialUser);
  }

  async findOrCreateUser(identity: {
    subject: string;
    email: string;
  }): Promise<AuthUser> {
    const existing = this.users.get(identity.subject);
    if (existing) {
      return existing;
    }
    const created: AuthUser = {
      id: "00000000-0000-4000-8000-000000000002",
      authSubject: identity.subject,
      email: identity.email,
      role: "user",
      status: "active",
    };
    this.users.set(identity.subject, created);
    return created;
  }

  async createSession(session: AuthSessionRecord): Promise<void> {
    this.sessions.set(session.tokenHash, session);
  }

  async findSessionByTokenHash(
    tokenHash: string,
    now: Date,
  ): Promise<{ session: AuthSessionRecord; user: AuthUser } | undefined> {
    const session = this.sessions.get(tokenHash);
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt.getTime() <= now.getTime() ||
      [...this.users.values()].find(({ id }) => id === session.userId)
        ?.status !== "active"
    ) {
      return undefined;
    }
    const foundUser = [...this.users.values()].find(
      ({ id }) => id === session.userId,
    );
    return foundUser ? { session, user: foundUser } : undefined;
  }

  async revokeSessionByTokenHash(
    tokenHash: string,
    revokedAt: Date,
  ): Promise<void> {
    const session = this.sessions.get(tokenHash);
    if (session) {
      session.revokedAt = revokedAt;
    }
  }

  async extendSession(
    tokenHash: string,
    expiresAt: Date,
    now: Date,
  ): Promise<boolean> {
    const session = this.sessions.get(tokenHash);
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt.getTime() <= now.getTime()
    ) {
      return false;
    }
    session.expiresAt = expiresAt;
    return true;
  }
}

describe("deterministic managed identity adapter", () => {
  it("requests and verifies a normalized email with a stable subject", async () => {
    const adapter = new DeterministicManagedIdentityStub({
      code: "123456",
    });

    await adapter.requestEmailCode(" User@Example.COM ");

    await expect(
      adapter.verifyEmailCode("user@example.com", "123456"),
    ).resolves.toEqual({
      subject: "managed:user@example.com",
      email: "user@example.com",
    });
  });

  it("normalizes invalid, expired, and attempt-limited failures", async () => {
    const now = new Date("2026-09-06T00:00:00.000Z");
    const invalid = new DeterministicManagedIdentityStub({
      code: "123456",
      now: () => now,
      maxAttempts: 1,
    });
    await invalid.requestEmailCode("user@example.com");

    const invalidFailure = invalid.verifyEmailCode(
      "user@example.com",
      "000000",
    );
    const limitedFailure = invalid.verifyEmailCode(
      "user@example.com",
      "123456",
    );

    const expired = new DeterministicManagedIdentityStub({
      code: "123456",
      now: () => now,
      codeTtlMs: 1,
    });
    await expired.requestEmailCode("other@example.com");
    now.setTime(now.getTime() + 2);
    const expiredFailure = expired.verifyEmailCode(
      "other@example.com",
      "123456",
    );

    for (const failure of [invalidFailure, limitedFailure, expiredFailure]) {
      await expect(failure).rejects.toEqual(
        new AuthVerificationError("Unable to verify email code"),
      );
    }
  });

  it("rate limits repeated requests without revealing account state", async () => {
    const adapter = new DeterministicManagedIdentityStub({
      requestLimit: 1,
      requestWindowMs: 60_000,
    });
    await adapter.requestEmailCode("known@example.com");

    await expect(adapter.requestEmailCode("known@example.com")).rejects.toEqual(
      new AuthVerificationError("Unable to verify email code"),
    );
    await expect(
      adapter.verifyEmailCode("unknown@example.com", "123456"),
    ).rejects.toEqual(new AuthVerificationError("Unable to verify email code"));
  });
});

describe("application sessions", () => {
  it("stores only a SHA-256 token hash and authenticates from the opaque token", async () => {
    const store = new MemoryAuthStore();
    const identity = new DeterministicManagedIdentityStub({ code: "123456" });
    const service = new ApplicationSessionService({
      identity,
      store,
      randomToken: () =>
        Buffer.from("opaque-session-token").toString("base64url"),
    });
    await service.requestEmailCode("user@example.com");

    const issued = await service.verifyEmailCode("user@example.com", "123456");

    expect(issued.token).toBe(
      Buffer.from("opaque-session-token").toString("base64url"),
    );
    expect([...store.sessions.keys()]).toEqual([
      createHash("sha256").update(issued.token).digest("hex"),
    ]);
    expect(JSON.stringify([...store.sessions.values()])).not.toContain(
      issued.token,
    );
    await expect(service.authenticate(issued.token)).resolves.toEqual({
      userId: user.id,
      authSubject: user.authSubject,
      role: "user",
    });
  });

  it("rejects expired, revoked, missing, and disabled-user sessions", async () => {
    const now = new Date("2026-09-06T00:00:00.000Z");
    const disabledStore = new MemoryAuthStore({ ...user, status: "disabled" });
    const identity = new DeterministicManagedIdentityStub({
      code: "123456",
      now: () => now,
    });
    const service = new ApplicationSessionService({
      identity,
      store: disabledStore,
      now: () => now,
      sessionTtlMs: 10,
      randomToken: () => "token",
    });
    await identity.requestEmailCode(user.email);

    await expect(
      service.verifyEmailCode(user.email, "123456"),
    ).rejects.toBeInstanceOf(AuthRequiredError);
    await expect(service.authenticate()).rejects.toBeInstanceOf(
      AuthRequiredError,
    );

    const activeStore = new MemoryAuthStore();
    const activeService = new ApplicationSessionService({
      identity,
      store: activeStore,
      now: () => now,
      sessionTtlMs: 10,
      randomToken: () => "active-token",
    });
    await identity.requestEmailCode(user.email);
    const issued = await activeService.verifyEmailCode(user.email, "123456");

    await activeService.logout(issued.token);
    await expect(
      activeService.authenticate(issued.token),
    ).rejects.toBeInstanceOf(AuthRequiredError);

    await identity.requestEmailCode(user.email);
    const expiring = await activeService.verifyEmailCode(user.email, "123456");
    now.setTime(now.getTime() + 11);
    await expect(
      activeService.authenticate(expiring.token),
    ).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it("derives role and user authority only from the server store", async () => {
    const store = new MemoryAuthStore();
    const identity = new DeterministicManagedIdentityStub({ code: "123456" });
    const service = new ApplicationSessionService({ identity, store });
    await service.requestEmailCode(user.email);

    const issued = await service.verifyEmailCode(user.email, "123456");

    await expect(service.authenticate(issued.token)).resolves.toMatchObject({
      userId: user.id,
      role: "user",
    });
  });

  it("renews only an active opaque-token session", async () => {
    const now = new Date("2026-09-06T00:00:00.000Z");
    const store = new MemoryAuthStore();
    const identity = new DeterministicManagedIdentityStub({
      code: "123456",
      now: () => now,
    });
    const service = new ApplicationSessionService({
      identity,
      store,
      now: () => now,
      sessionTtlMs: 1_000,
      randomToken: () => "renewable-token",
    });
    await service.requestEmailCode(user.email);
    const issued = await service.verifyEmailCode(user.email, "123456");
    now.setTime(now.getTime() + 500);

    const renewed = await service.renew(issued.token);

    expect(renewed.expiresAt.toISOString()).toBe("2026-09-06T00:00:01.500Z");
    const stored = [...store.sessions.values()][0];
    expect(stored?.expiresAt).toEqual(renewed.expiresAt);

    await service.logout(issued.token);
    await expect(service.renew(issued.token)).rejects.toBeInstanceOf(
      AuthRequiredError,
    );
  });

  it("uses cryptographically generated random bytes by default", async () => {
    const store = new MemoryAuthStore();
    const identity = new DeterministicManagedIdentityStub({ code: "123456" });
    const randomBytes = vi.fn(() => Buffer.alloc(32, 7));
    const service = new ApplicationSessionService({
      identity,
      store,
      randomBytes,
    });
    await service.requestEmailCode(user.email);

    const issued = await service.verifyEmailCode(user.email, "123456");

    expect(randomBytes).toHaveBeenCalledWith(32);
    expect(Buffer.from(issued.token, "base64url")).toHaveLength(32);
  });
});

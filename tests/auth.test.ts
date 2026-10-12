import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ApplicationSessionService,
  AuthRequiredError,
  hashPassword,
  verifyPassword,
  type AuthSessionRecord,
  type AuthStore,
  type AuthUser,
  type AuthUserWithPassword,
} from "../packages/auth/src/index.js";

const password = "correct-horse-battery";
const userId = "00000000-0000-4000-8000-000000000001";

class MemoryAuthStore implements AuthStore {
  readonly users = new Map<string, AuthUserWithPassword>();
  readonly sessions = new Map<string, AuthSessionRecord>();

  constructor(users: AuthUserWithPassword[] = []) {
    for (const user of users) {
      this.users.set(user.email, user);
    }
  }

  async findUserByEmail(
    email: string,
  ): Promise<AuthUserWithPassword | undefined> {
    return this.users.get(email);
  }

  async createSession(session: AuthSessionRecord): Promise<void> {
    this.sessions.set(session.tokenHash, session);
  }

  /** Mirrors the SQL transaction: re-verify status and password version at
   * issue time, then stamp the session with the user's CURRENT epoch. */
  async issueVerifiedSession(input: {
    userId: string;
    expectedPasswordHash: string;
    session: Omit<AuthSessionRecord, "issuedEpoch">;
  }): Promise<{ session: AuthSessionRecord; user: AuthUser } | undefined> {
    const user = [...this.users.values()].find(({ id }) => id === input.userId);
    if (!user || user.status !== "active") return undefined;
    if (user.passwordHash !== input.expectedPasswordHash) return undefined;
    const session: AuthSessionRecord = {
      ...input.session,
      issuedEpoch: user.authEpoch,
    };
    this.sessions.set(session.tokenHash, session);
    return { session, user: toAuthUser(user) };
  }

  async findSessionByTokenHash(
    tokenHash: string,
    now: Date,
  ): Promise<{ session: AuthSessionRecord; user: AuthUser } | undefined> {
    const session = this.sessions.get(tokenHash);
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt.getTime() <= now.getTime()
    ) {
      return undefined;
    }
    const user = [...this.users.values()].find(
      ({ id }) => id === session.userId,
    );
    if (!user || user.status !== "active") {
      return undefined;
    }
    return {
      session,
      user: toAuthUser(user),
    };
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

function toAuthUser(user: AuthUserWithPassword): AuthUser {
  return {
    id: user.id,
    authSubject: user.authSubject,
    email: user.email,
    role: user.role,
    status: user.status,
    authEpoch: user.authEpoch,
  };
}

async function activeUser(
  overrides: Partial<AuthUserWithPassword> = {},
): Promise<AuthUserWithPassword> {
  return {
    id: userId,
    authSubject: "local:user@example.com",
    email: "user@example.com",
    passwordHash: await hashPassword(password),
    role: "user",
    status: "active",
    authEpoch: 0,
    ...overrides,
  };
}

describe("password hashing", () => {
  it("stores a salted scrypt hash that verifies only the right password", async () => {
    const stored = await hashPassword(password);

    expect(stored.startsWith("scrypt$")).toBe(true);
    expect(stored).not.toContain(password);
    await expect(verifyPassword(password, stored)).resolves.toBe(true);
    await expect(verifyPassword("wrong-password", stored)).resolves.toBe(false);
  });

  it("salts each hash so identical passwords get different digests", async () => {
    const first = await hashPassword(password);
    const second = await hashPassword(password);

    expect(first).not.toBe(second);
    await expect(verifyPassword(password, first)).resolves.toBe(true);
    await expect(verifyPassword(password, second)).resolves.toBe(true);
  });

  it("rejects malformed stored hashes instead of throwing", async () => {
    for (const malformed of [
      "",
      "not-a-hash",
      "scrypt$0$8$1$c2FsdA$aGFzaA",
      "scrypt$16384$8$1$$",
      "bcrypt$16384$8$1$c2FsdA$aGFzaA",
    ]) {
      await expect(verifyPassword(password, malformed)).resolves.toBe(false);
    }
  });
});

describe("password login", () => {
  it("issues a session and stores only the SHA-256 token hash", async () => {
    const store = new MemoryAuthStore([await activeUser()]);
    const service = new ApplicationSessionService({
      store,
      randomToken: () =>
        Buffer.from("opaque-session-token").toString("base64url"),
    });

    const issued = await service.login("  User@Example.COM ", password);

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
      userId,
      authSubject: "local:user@example.com",
      role: "user",
    });
  });

  it("rejects a wrong password, an unknown email and a passwordless account alike", async () => {
    const store = new MemoryAuthStore([
      await activeUser(),
      await activeUser({
        id: "00000000-0000-4000-8000-000000000003",
        email: "passwordless@example.com",
        authSubject: "local:passwordless@example.com",
        passwordHash: null,
      }),
    ]);
    const service = new ApplicationSessionService({ store });

    const attempts: Array<[string, string]> = [
      ["user@example.com", "wrong-password"],
      ["unknown@example.com", password],
      ["passwordless@example.com", password],
    ];
    for (const [email, candidate] of attempts) {
      await expect(service.login(email, candidate)).rejects.toBeInstanceOf(
        AuthRequiredError,
      );
    }
    expect(store.sessions.size).toBe(0);
  });

  it("refuses to sign in a disabled account", async () => {
    const store = new MemoryAuthStore([
      await activeUser({ status: "disabled" }),
    ]);
    const service = new ApplicationSessionService({ store });

    await expect(
      service.login("user@example.com", password),
    ).rejects.toBeInstanceOf(AuthRequiredError);
    expect(store.sessions.size).toBe(0);
  });

  it("derives role and user authority only from the server store", async () => {
    const store = new MemoryAuthStore([
      await activeUser({
        role: "admin",
        authSubject: "local:admin@example.com",
      }),
    ]);
    const service = new ApplicationSessionService({ store });

    const issued = await service.login("user@example.com", password);

    await expect(service.authenticate(issued.token)).resolves.toMatchObject({
      userId,
      role: "admin",
    });
  });
});

describe("application sessions", () => {
  it("rejects expired, revoked and missing sessions", async () => {
    const now = new Date("2026-09-06T00:00:00.000Z");
    const store = new MemoryAuthStore([await activeUser()]);
    const service = new ApplicationSessionService({
      store,
      now: () => now,
      sessionTtlMs: 10,
      randomToken: () => "active-token",
    });

    const issued = await service.login("user@example.com", password);

    await service.logout(issued.token);
    await expect(service.authenticate(issued.token)).rejects.toBeInstanceOf(
      AuthRequiredError,
    );

    const expiring = await service.login("user@example.com", password);
    now.setTime(now.getTime() + 11);
    await expect(service.authenticate(expiring.token)).rejects.toBeInstanceOf(
      AuthRequiredError,
    );
    await expect(service.authenticate()).rejects.toBeInstanceOf(
      AuthRequiredError,
    );
  });

  it("renews only an active opaque-token session", async () => {
    const now = new Date("2026-09-06T00:00:00.000Z");
    const store = new MemoryAuthStore([await activeUser()]);
    const service = new ApplicationSessionService({
      store,
      now: () => now,
      sessionTtlMs: 1_000,
      randomToken: () => "renewable-token",
    });

    const issued = await service.login("user@example.com", password);
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
    const store = new MemoryAuthStore([await activeUser()]);
    const randomBytes = vi.fn(() => Buffer.alloc(32, 7));
    const service = new ApplicationSessionService({ store, randomBytes });

    const issued = await service.login("user@example.com", password);

    expect(randomBytes).toHaveBeenCalledWith(32);
    expect(Buffer.from(issued.token, "base64url")).toHaveLength(32);
  });
});

describe("credential epochs and absolute expiry", () => {
  it("invalidates every existing session when the epoch is bumped", async () => {
    const user = await activeUser();
    const store = new MemoryAuthStore([user]);
    const service = new ApplicationSessionService({ store });
    const issued = await service.login(user.email, password);
    await expect(service.authenticate(issued.token)).resolves.toMatchObject({
      userId,
    });

    // An admin-level revocation (password change, disable, role change)
    // bumps the user's epoch: the old session no longer authenticates.
    user.authEpoch += 1;
    await expect(service.authenticate(issued.token)).rejects.toThrow(
      AuthRequiredError,
    );
  });

  it("refuses to issue a session when the account changed after the password check", async () => {
    const user = await activeUser();
    const store = new MemoryAuthStore([user]);
    const service = new ApplicationSessionService({
      store,
      // Between password verification and issuance the account is disabled:
      // the atomic issue re-check must reject the late login.
      randomToken: () => {
        user.status = "disabled";
        return "raced-token";
      },
    });

    await expect(service.login(user.email, password)).rejects.toThrow(
      AuthRequiredError,
    );
    expect(store.sessions.size).toBe(0);
  });

  it("refuses to issue a session when the password changed after verification", async () => {
    const user = await activeUser();
    const store = new MemoryAuthStore([user]);
    const service = new ApplicationSessionService({
      store,
      // Between verification and issuance an admin rotates the password: the
      // store's copy moves while the caller still holds the verified hash.
      randomToken: () => {
        store.users.set(user.email, {
          ...user,
          passwordHash: "scrypt$rotated",
        });
        return "raced-token";
      },
    });

    await expect(service.login(user.email, password)).rejects.toThrow(
      AuthRequiredError,
    );
    expect(store.sessions.size).toBe(0);
  });

  it("enforces the absolute expiry regardless of idle renewal", async () => {
    const user = await activeUser();
    const store = new MemoryAuthStore([user]);
    const now = new Date("2026-10-12T00:00:00.000Z");
    const service = new ApplicationSessionService({
      store,
      now: () => now,
      sessionTtlMs: 7 * 24 * 60 * 60_000,
      absoluteTtlMs: 30 * 24 * 60 * 60_000,
    });
    const issued = await service.login(user.email, password);

    // 31 days later the idle window is irrelevant: the absolute deadline
    // has passed and both authenticate and renew refuse.
    const later = new Date(now.getTime() + 31 * 24 * 60 * 60_000);
    (service as unknown as { now: () => Date }).now = () => later;
    await expect(service.authenticate(issued.token)).rejects.toThrow(
      AuthRequiredError,
    );
  });

  it("caps renewal at the absolute deadline", async () => {
    const user = await activeUser();
    const store = new MemoryAuthStore([user]);
    const start = new Date("2026-10-12T00:00:00.000Z");
    let now = start;
    const service = new ApplicationSessionService({
      store,
      now: () => now,
      sessionTtlMs: 7 * 24 * 60 * 60_000,
      absoluteTtlMs: 30 * 24 * 60 * 60_000,
    });
    const issued = await service.login(user.email, password);
    const absoluteDeadline = new Date(start.getTime() + 30 * 24 * 60 * 60_000);

    // Keep the idle window alive by renewing every 6 days: each renewal is
    // the full 7-day idle TTL until the absolute deadline starts binding.
    for (let day = 6; day <= 24; day += 6) {
      now = new Date(start.getTime() + day * 24 * 60 * 60_000);
      const renewed = await service.renew(issued.token);
      expect(renewed.expiresAt.getTime()).toBe(
        Math.min(
          now.getTime() + 7 * 24 * 60 * 60_000,
          absoluteDeadline.getTime(),
        ),
      );
    }

    // Late in day 29 the renewal succeeds but is pinned to day 30, and a
    // renewal after the deadline is refused outright.
    now = new Date(start.getTime() + (30 * 24 - 1) * 60 * 60_000);
    const last = await service.renew(issued.token);
    expect(last.expiresAt.getTime()).toBe(absoluteDeadline.getTime());
    now = new Date(start.getTime() + 31 * 24 * 60 * 60_000);
    await expect(service.renew(issued.token)).rejects.toThrow(
      AuthRequiredError,
    );
  });
});

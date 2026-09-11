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
      user: {
        id: user.id,
        authSubject: user.authSubject,
        email: user.email,
        role: user.role,
        status: user.status,
      },
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

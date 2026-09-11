import {
  createHash,
  randomBytes as cryptoRandomBytes,
  randomUUID,
} from "node:crypto";
import { hashPassword, verifyPassword } from "./password.js";

export * from "./password.js";

export type UserRole = "user" | "admin";
export type UserStatus = "active" | "disabled";

export interface AuthUser {
  id: string;
  authSubject: string;
  email: string;
  role: UserRole;
  status: UserStatus;
}

export interface AuthSessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface AuthContext {
  userId: string;
  authSubject: string;
  role: UserRole;
}

export interface AuthUserWithPassword extends AuthUser {
  passwordHash: string | null;
}

export interface AuthStore {
  findUserByEmail(email: string): Promise<AuthUserWithPassword | undefined>;
  createSession(session: AuthSessionRecord): Promise<void>;
  findSessionByTokenHash(
    tokenHash: string,
    now: Date,
  ): Promise<{ session: AuthSessionRecord; user: AuthUser } | undefined>;
  extendSession(
    tokenHash: string,
    expiresAt: Date,
    now: Date,
  ): Promise<boolean>;
  revokeSessionByTokenHash(tokenHash: string, revokedAt: Date): Promise<void>;
}

export class AuthRequiredError extends Error {
  constructor() {
    super("Authentication required");
    this.name = "AuthRequiredError";
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface ApplicationSessionServiceOptions {
  store: AuthStore;
  sessionTtlMs?: number;
  now?: () => Date;
  randomBytes?: (size: number) => Buffer;
  randomToken?: () => string;
  randomId?: () => string;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class ApplicationSessionService {
  private readonly store: AuthStore;
  private readonly sessionTtlMs: number;
  private readonly now: () => Date;
  private readonly createToken: () => string;
  private readonly randomId: () => string;
  private decoyHash: Promise<string> | undefined;

  constructor(options: ApplicationSessionServiceOptions) {
    this.store = options.store;
    this.sessionTtlMs = options.sessionTtlMs ?? 7 * 24 * 60 * 60_000;
    this.now = options.now ?? (() => new Date());
    this.createToken =
      options.randomToken ??
      (() =>
        (options.randomBytes ?? cryptoRandomBytes)(32).toString("base64url"));
    this.randomId = options.randomId ?? randomUUID;
  }

  // Unknown accounts are compared against a throwaway hash so that the response
  // time does not reveal whether the email exists.
  private timingDecoy(): Promise<string> {
    this.decoyHash ??= hashPassword("unmatched-password-placeholder");
    return this.decoyHash;
  }

  async login(
    email: string,
    password: string,
  ): Promise<{ token: string; expiresAt: Date }> {
    const user = await this.store.findUserByEmail(normalizeEmail(email));
    const stored = user?.passwordHash ?? (await this.timingDecoy());
    const matches = await verifyPassword(password, stored);
    if (!user || !user.passwordHash || !matches) {
      throw new AuthRequiredError();
    }
    if (user.status !== "active") {
      throw new AuthRequiredError();
    }

    const now = this.now();
    const token = this.createToken();
    const expiresAt = new Date(now.getTime() + this.sessionTtlMs);
    await this.store.createSession({
      id: this.randomId(),
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt,
      revokedAt: null,
      createdAt: now,
    });
    return { token, expiresAt };
  }

  async authenticate(token?: string): Promise<AuthContext> {
    if (!token) {
      throw new AuthRequiredError();
    }
    const found = await this.store.findSessionByTokenHash(
      hashToken(token),
      this.now(),
    );
    if (!found || found.user.status !== "active") {
      throw new AuthRequiredError();
    }
    return {
      userId: found.user.id,
      authSubject: found.user.authSubject,
      role: found.user.role,
    };
  }

  async logout(token?: string): Promise<void> {
    if (token) {
      await this.store.revokeSessionByTokenHash(hashToken(token), this.now());
    }
  }

  async renew(token: string): Promise<{ expiresAt: Date }> {
    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.sessionTtlMs);
    const extended = await this.store.extendSession(
      hashToken(token),
      expiresAt,
      now,
    );
    if (!extended) {
      throw new AuthRequiredError();
    }
    return { expiresAt };
  }
}

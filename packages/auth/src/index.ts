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
  /**
   * Credential version. Every admin-level revocation (password change,
   * disable, role change, revoke-all) bumps it in the same transaction;
   * sessions carry the epoch they were issued under and stop authenticating
   * the moment it moves.
   */
  authEpoch: number;
}

export interface AuthSessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  /** The user's authEpoch at issue time; a mismatch invalidates the session. */
  issuedEpoch: number;
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
  /**
   * Atomic issuance: after the caller verified the password, the store
   * re-reads the user (locked), re-checks status and the exact password
   * hash, and inserts the session stamped with the user's CURRENT epoch —
   * all in one transaction. Any change in between returns undefined.
   */
  issueVerifiedSession(input: {
    userId: string;
    expectedPasswordHash: string;
    session: Omit<AuthSessionRecord, "issuedEpoch">;
  }): Promise<{ session: AuthSessionRecord; user: AuthUser } | undefined>;
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
  /** Idle window (default 7 days). */
  sessionTtlMs?: number;
  /** Absolute lifetime cap (default 30 days); renewal cannot extend past it. */
  absoluteTtlMs?: number;
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
  private readonly absoluteTtlMs: number;
  private readonly now: () => Date;
  private readonly createToken: () => string;
  private readonly randomId: () => string;
  private decoyHash: Promise<string> | undefined;

  constructor(options: ApplicationSessionServiceOptions) {
    this.store = options.store;
    this.sessionTtlMs = options.sessionTtlMs ?? 7 * 24 * 60 * 60_000;
    this.absoluteTtlMs = options.absoluteTtlMs ?? 30 * 24 * 60 * 60_000;
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
    // The password check above raced nothing yet, but the account can change
    // between verification and issuance: the store re-verifies the status,
    // the exact password version, and stamps the current epoch atomically.
    const issued = await this.store.issueVerifiedSession({
      userId: user.id,
      expectedPasswordHash: user.passwordHash,
      session: {
        id: this.randomId(),
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt,
        revokedAt: null,
        createdAt: now,
      },
    });
    if (!issued) {
      throw new AuthRequiredError();
    }
    return { token, expiresAt: issued.session.expiresAt };
  }

  async authenticate(token?: string): Promise<AuthContext> {
    if (!token) {
      throw new AuthRequiredError();
    }
    const now = this.now();
    const found = await this.store.findSessionByTokenHash(
      hashToken(token),
      now,
    );
    if (
      !found ||
      found.user.status !== "active" ||
      // An epoch mismatch means a revocation happened after this session was
      // issued; the token is dead even though its row is not marked yet.
      found.session.issuedEpoch !== found.user.authEpoch ||
      // Absolute lifetime cap: idle renewal can never extend past it.
      found.session.createdAt.getTime() + this.absoluteTtlMs <= now.getTime()
    ) {
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
    const found = await this.store.findSessionByTokenHash(
      hashToken(token),
      now,
    );
    if (
      !found ||
      found.user.status !== "active" ||
      found.session.issuedEpoch !== found.user.authEpoch
    ) {
      throw new AuthRequiredError();
    }
    // Idle renewal, capped by the absolute deadline from creation.
    const absoluteDeadline = new Date(
      found.session.createdAt.getTime() + this.absoluteTtlMs,
    );
    const expiresAt = new Date(
      Math.min(now.getTime() + this.sessionTtlMs, absoluteDeadline.getTime()),
    );
    if (expiresAt.getTime() <= now.getTime()) {
      throw new AuthRequiredError();
    }
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

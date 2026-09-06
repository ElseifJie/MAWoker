import {
  createHash,
  randomBytes as cryptoRandomBytes,
  randomUUID,
} from "node:crypto";

export type UserRole = "user" | "admin";
export type UserStatus = "active" | "disabled";

export interface TrustedIdentity {
  subject: string;
  email: string;
}

export interface ManagedIdentityAdapter {
  requestEmailCode(email: string): Promise<void>;
  verifyEmailCode(email: string, code: string): Promise<TrustedIdentity>;
}

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

export interface AuthStore {
  findOrCreateUser(identity: TrustedIdentity): Promise<AuthUser>;
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

export class AuthVerificationError extends Error {
  constructor(message = "Unable to verify email code") {
    super(message);
    this.name = "AuthVerificationError";
  }
}

export class AuthRequiredError extends Error {
  constructor() {
    super("Authentication required");
    this.name = "AuthRequiredError";
  }
}

interface CodeState {
  attempts: number;
  issuedAt: number;
}

interface RequestWindow {
  count: number;
  startedAt: number;
}

export interface DeterministicManagedIdentityStubOptions {
  code?: string;
  codeTtlMs?: number;
  maxAttempts?: number;
  requestLimit?: number;
  requestWindowMs?: number;
  now?: () => Date;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export class DeterministicManagedIdentityStub implements ManagedIdentityAdapter {
  private readonly code: string;
  private readonly codeTtlMs: number;
  private readonly maxAttempts: number;
  private readonly requestLimit: number;
  private readonly requestWindowMs: number;
  private readonly now: () => Date;
  private readonly codes = new Map<string, CodeState>();
  private readonly requests = new Map<string, RequestWindow>();

  constructor(options: DeterministicManagedIdentityStubOptions = {}) {
    this.code = options.code ?? "123456";
    this.codeTtlMs = options.codeTtlMs ?? 5 * 60_000;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.requestLimit = options.requestLimit ?? 5;
    this.requestWindowMs = options.requestWindowMs ?? 60_000;
    this.now = options.now ?? (() => new Date());
  }

  async requestEmailCode(input: string): Promise<void> {
    const email = normalizeEmail(input);
    const now = this.now().getTime();
    if (!isEmail(email)) {
      throw new AuthVerificationError();
    }

    const previous = this.requests.get(email);
    const requestWindow =
      previous && now - previous.startedAt < this.requestWindowMs
        ? previous
        : { count: 0, startedAt: now };
    if (requestWindow.count >= this.requestLimit) {
      throw new AuthVerificationError();
    }

    requestWindow.count += 1;
    this.requests.set(email, requestWindow);
    this.codes.set(email, { attempts: 0, issuedAt: now });
  }

  async verifyEmailCode(
    input: string,
    candidate: string,
  ): Promise<TrustedIdentity> {
    const email = normalizeEmail(input);
    const state = this.codes.get(email);
    const now = this.now().getTime();
    if (
      !isEmail(email) ||
      !state ||
      state.attempts >= this.maxAttempts ||
      now - state.issuedAt >= this.codeTtlMs
    ) {
      throw new AuthVerificationError();
    }

    if (candidate !== this.code) {
      state.attempts += 1;
      throw new AuthVerificationError();
    }

    this.codes.delete(email);
    return {
      subject: `managed:${email}`,
      email,
    };
  }
}

export interface ApplicationSessionServiceOptions {
  identity: ManagedIdentityAdapter;
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
  private readonly identity: ManagedIdentityAdapter;
  private readonly store: AuthStore;
  private readonly sessionTtlMs: number;
  private readonly now: () => Date;
  private readonly createToken: () => string;
  private readonly randomId: () => string;

  constructor(options: ApplicationSessionServiceOptions) {
    this.identity = options.identity;
    this.store = options.store;
    this.sessionTtlMs = options.sessionTtlMs ?? 7 * 24 * 60 * 60_000;
    this.now = options.now ?? (() => new Date());
    this.createToken =
      options.randomToken ??
      (() =>
        (options.randomBytes ?? cryptoRandomBytes)(32).toString("base64url"));
    this.randomId = options.randomId ?? randomUUID;
  }

  requestEmailCode(email: string): Promise<void> {
    return this.identity.requestEmailCode(normalizeEmail(email));
  }

  async verifyEmailCode(
    email: string,
    code: string,
  ): Promise<{ token: string; expiresAt: Date }> {
    const identity = await this.identity.verifyEmailCode(
      normalizeEmail(email),
      code,
    );
    const user = await this.store.findOrCreateUser(identity);
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

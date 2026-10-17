import { createHash, randomBytes } from "node:crypto";
import { emailSchema, passwordSchema } from "@pwa/contracts";
import { ResourceNotFoundError } from "./errors.js";
import { UserEmailConflictError } from "./platform-agents.js";

export type InviteStatus = "pending" | "used" | "revoked" | "expired";

export interface InviteCodeRow {
  id: string;
  codeHash: string;
  email: string;
  createdBy: string;
  usedByUserId: string | null;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface InviteCodeRecord extends Omit<InviteCodeRow, "codeHash"> {
  status: InviteStatus;
}

export type InviteAcceptResult =
  | { kind: "accepted"; userId: string; email: string }
  | { kind: "invalid" }
  | { kind: "email_conflict" };

export interface InviteCodeRepository {
  create(input: {
    id: string;
    codeHash: string;
    email: string;
    createdBy: string;
    expiresAt: Date;
    now: Date;
  }): PromiseLike<InviteCodeRow>;
  list(limit: number): PromiseLike<InviteCodeRow[]>;
  revoke(id: string, now: Date): PromiseLike<InviteCodeRow | undefined>;
  accept(input: {
    codeHash: string;
    passwordHash: string;
    userId: string;
    now: Date;
  }): PromiseLike<InviteAcceptResult>;
}

export class InvalidInviteError extends Error {
  readonly code = "INVITE_INVALID";
  constructor() {
    super("Invite code is invalid, expired, or already used");
    this.name = "InvalidInviteError";
  }
}

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function statusOf(row: InviteCodeRow, now: Date): InviteStatus {
  if (row.usedAt) return "used";
  if (row.revokedAt) return "revoked";
  if (row.expiresAt.getTime() <= now.getTime()) return "expired";
  return "pending";
}

function publicRecord(row: InviteCodeRow, now: Date): InviteCodeRecord {
  return {
    id: row.id,
    email: row.email,
    createdBy: row.createdBy,
    usedByUserId: row.usedByUserId,
    expiresAt: row.expiresAt,
    usedAt: row.usedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    status: statusOf(row, now),
  };
}

export class InviteCodeService {
  constructor(
    private readonly dependencies: {
      repository: InviteCodeRepository;
      passwordHasher: { hash(password: string): PromiseLike<string> };
      createId: () => string;
      generateCode?: () => string;
      now?: () => Date;
    },
  ) {}

  private now(): Date {
    return this.dependencies.now?.() ?? new Date();
  }

  private generateCode(): string {
    return (
      this.dependencies.generateCode?.() ??
      randomBytes(24).toString("base64url")
    );
  }

  async create(
    adminId: string,
    input: { email: string; expiresInDays?: number },
  ): Promise<{ invite: InviteCodeRecord; code: string }> {
    const email = emailSchema.parse(input.email);
    const days = Math.min(
      Math.max(Math.trunc(input.expiresInDays ?? 7), 1),
      30,
    );
    const now = this.now();
    const code = this.generateCode();
    const row = await this.dependencies.repository.create({
      id: this.dependencies.createId(),
      codeHash: hashCode(code),
      email,
      createdBy: adminId,
      expiresAt: new Date(now.getTime() + days * 24 * 60 * 60 * 1_000),
      now,
    });
    return { invite: publicRecord(row, now), code };
  }

  async list(limit = 50): Promise<InviteCodeRecord[]> {
    const now = this.now();
    return (await this.dependencies.repository.list(limit)).map((row) =>
      publicRecord(row, now),
    );
  }

  async revoke(adminId: string, id: string): Promise<InviteCodeRecord> {
    const now = this.now();
    const row = await this.dependencies.repository.revoke(id, now);
    if (!row) throw new ResourceNotFoundError();
    return publicRecord(row, now);
  }

  async accept(
    code: string,
    password: string,
  ): Promise<{ userId: string; email: string }> {
    const trimmed = code.trim();
    if (trimmed.length < 16) throw new InvalidInviteError();
    const parsedPassword = passwordSchema.parse(password);
    const passwordHash =
      await this.dependencies.passwordHasher.hash(parsedPassword);
    const result = await this.dependencies.repository.accept({
      codeHash: hashCode(trimmed),
      passwordHash,
      userId: this.dependencies.createId(),
      now: this.now(),
    });
    if (result.kind === "invalid") throw new InvalidInviteError();
    if (result.kind === "email_conflict") throw new UserEmailConflictError();
    return { userId: result.userId, email: result.email };
  }
}

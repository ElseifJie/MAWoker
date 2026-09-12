export interface AuditLogEntry {
  id: string;
  actorUserId: string | null;
  actorEmail: string | null;
  ownerUserId: string | null;
  ownerEmail: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  result: "succeeded" | "failed";
  requestId: string;
  arkRequestId: string | null;
  errorCode: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export interface AuditLogCursor {
  createdAt: string;
  id: string;
}

export interface AuditLogQuery {
  /**
   * Inclusive lower bound and exclusive upper bound on `created_at`, so an
   * external system can pull incrementally with `[lastSeen, now)`.
   */
  since?: string | undefined;
  until?: string | undefined;
  actorId?: string | undefined;
  action?: string | undefined;
  resourceType?: string | undefined;
  resourceId?: string | undefined;
  result?: "succeeded" | "failed" | undefined;
  limit: number;
  before: AuditLogCursor | null;
}

export interface AuditLogPage {
  entries: AuditLogEntry[];
  nextCursor: AuditLogCursor | null;
}

export interface AuditRecordInput {
  actorUserId: string | null;
  ownerUserId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  result: "succeeded" | "failed";
  requestId: string;
  arkRequestId?: string | null;
  errorCode?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface AuditLogRepository {
  list(query: AuditLogQuery): PromiseLike<AuditLogPage>;
  listForUser(
    userId: string,
    query: Pick<AuditLogQuery, "limit" | "before">,
  ): PromiseLike<AuditLogPage>;
  record(entry: AuditRecordInput): PromiseLike<void>;
}

export class AuditService {
  constructor(
    private readonly dependencies: { repository: AuditLogRepository },
  ) {}

  list(query: AuditLogQuery): PromiseLike<AuditLogPage> {
    return this.dependencies.repository.list(query);
  }

  listForUser(
    userId: string,
    query: Pick<AuditLogQuery, "limit" | "before">,
  ): PromiseLike<AuditLogPage> {
    return this.dependencies.repository.listForUser(userId, query);
  }

  /**
   * Login outcomes carry no credentials: only the attempted email, the acting
   * user (when known), and the result.
   */
  async recordLogin(input: {
    email: string;
    userId: string | null;
    success: boolean;
    requestId: string;
  }): Promise<void> {
    await this.dependencies.repository.record({
      actorUserId: input.userId,
      ownerUserId: input.userId,
      action: "auth.login",
      resourceType: "authentication",
      resourceId: input.email,
      result: input.success ? "succeeded" : "failed",
      requestId: input.requestId,
      errorCode: input.success ? null : "AUTH_REQUIRED",
    });
  }

  async recordUserView(input: {
    adminId: string;
    userId: string;
    requestId: string;
  }): Promise<void> {
    await this.dependencies.repository.record({
      actorUserId: input.adminId,
      ownerUserId: input.userId,
      action: "user.view",
      resourceType: "user",
      resourceId: input.userId,
      result: "succeeded",
      requestId: input.requestId,
    });
  }
}

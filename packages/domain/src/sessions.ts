import type {
  ArkGateway,
  ArkRequestOptions,
  ArkSession,
} from "@pwa/ark-client";
import type { SessionStatus } from "@pwa/contracts";
import type { AvailableAgentRecord } from "./user-agents.js";
import { ResourceNotFoundError } from "./errors.js";

export interface SessionRecord {
  id: string;
  ownerUserId: string;
  arkSessionId: string;
  agentKind: "platform" | "personal";
  platformAgentId: string | null;
  personalAgentId: string | null;
  arkAgentId: string;
  agentName: string;
  agentVersion: string;
  environmentId: string;
  title: string;
  status: SessionStatus;
  archivedAt: Date | null;
  deletionState: "none" | "pending" | "deletion_failed" | "deleted";
  lastEventAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface SessionAuditEntry {
  actorUserId: string;
  ownerUserId: string;
  action: string;
  resourceType: "session";
  resourceId: string;
  result: "succeeded" | "failed";
  requestId: string;
  arkRequestId?: string | undefined;
  errorCode?: string | undefined;
}

export interface SessionRepository {
  prepareCreate(record: SessionRecord): PromiseLike<void>;
  completeCreate(
    id: string,
    userId: string,
    upstream: {
      arkSessionId: string;
      arkAgentId: string;
      agentVersion: string;
      status: SessionStatus;
    },
  ): PromiseLike<SessionRecord>;
  preserveCreateOutcome(
    id: string,
    userId: string,
    upstream?: {
      arkSessionId: string;
      arkAgentId: string;
      agentVersion: string;
      status: SessionStatus;
    },
  ): PromiseLike<void>;
  failCreate(id: string, userId: string): PromiseLike<void>;
  listOwned(userId: string, archived: boolean): PromiseLike<SessionRecord[]>;
  findOwned(userId: string, id: string): PromiseLike<SessionRecord | undefined>;
  findCreateIntent(
    userId: string,
    id: string,
  ): PromiseLike<SessionRecord | undefined>;
  beginMessage(
    userId: string,
    id: string,
  ): PromiseLike<
    | {
        session: SessionRecord;
        started: boolean;
      }
    | undefined
  >;
  finishMessage(
    userId: string,
    id: string,
    outcome: "accepted_or_unknown" | "definite_failure",
  ): PromiseLike<void>;
  audit(entry: SessionAuditEntry): PromiseLike<void>;
}

interface SessionContext {
  userId: string;
  requestId: string;
}

export class SessionTerminatedError extends Error {
  readonly code = "SESSION_TERMINATED";

  constructor() {
    super("Session is terminated");
    this.name = "SessionTerminatedError";
  }
}

function isArkCategory(error: unknown, category: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "category" in error &&
    error.category === category
  );
}

function arkErrorCode(error: unknown): string {
  const category =
    typeof error === "object" && error !== null && "category" in error
      ? String(error.category)
      : "unavailable";
  return `ARK_${category.toUpperCase()}`;
}

function arkRequestId(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "arkRequestId" in error &&
    typeof error.arkRequestId === "string"
  ) {
    return error.arkRequestId;
  }
  return undefined;
}

function createOperationId(id: string): string {
  return `session-create:${id}`;
}

export class SessionService {
  constructor(
    private readonly dependencies: {
      repository: SessionRepository;
      agentResolver: {
        resolveForNewSession(
          userId: string,
          agentId: string,
        ): PromiseLike<AvailableAgentRecord>;
      };
      ark: Pick<ArkGateway, "createSession" | "getSession" | "submitEvent">;
      environmentId: string;
      createId: () => string;
      now?: () => Date;
    },
  ) {}

  async create(
    input: { agentId: string; title?: string },
    context: SessionContext,
  ): Promise<SessionRecord> {
    const agent = await this.dependencies.agentResolver.resolveForNewSession(
      context.userId,
      input.agentId,
    );
    const id = this.dependencies.createId();
    const timestamp = (this.dependencies.now ?? (() => new Date()))();
    const intent: SessionRecord = {
      id,
      ownerUserId: context.userId,
      arkSessionId: `pending:${id}`,
      agentKind: agent.kind,
      platformAgentId: agent.kind === "platform" ? agent.id : null,
      personalAgentId: agent.kind === "personal" ? agent.id : null,
      arkAgentId: agent.arkAgentId,
      agentName: agent.name,
      agentVersion: agent.arkVersion,
      environmentId: this.dependencies.environmentId,
      title: input.title?.trim() ?? "",
      status: "idle",
      archivedAt: null,
      deletionState: "none",
      lastEventAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.dependencies.repository.prepareCreate(intent);

    let upstream: ArkSession;
    try {
      upstream = await this.dependencies.ark.createSession(
        this.arkCreateInput(intent),
        this.createOptions(id),
      );
    } catch (error) {
      if (isArkCategory(error, "unknown_write_outcome")) {
        await this.dependencies.repository.preserveCreateOutcome(
          id,
          context.userId,
        );
      } else {
        await this.dependencies.repository.failCreate(id, context.userId);
      }
      await this.audit(context, "session.create", id, "failed", error);
      throw error;
    }

    const upstreamSnapshot = this.upstreamSnapshot(upstream);
    try {
      const created = await this.dependencies.repository.completeCreate(
        id,
        context.userId,
        upstreamSnapshot,
      );
      await this.audit(context, "session.create", id, "succeeded");
      return created;
    } catch (error) {
      await this.dependencies.repository.preserveCreateOutcome(
        id,
        context.userId,
        upstreamSnapshot,
      );
      await this.audit(context, "session.create", id, "failed", {
        code: "DB_PERSISTENCE_FAILED",
      });
      throw error;
    }
  }

  list(userId: string, archived = false): PromiseLike<SessionRecord[]> {
    return this.dependencies.repository.listOwned(userId, archived);
  }

  async get(userId: string, id: string): Promise<SessionRecord> {
    return this.requireOwned(userId, id);
  }

  async sendMessage(
    id: string,
    input: { content: string },
    context: SessionContext,
  ): Promise<{ eventId: string; delivery: "accepted" | "queued" }> {
    const prepared = await this.dependencies.repository.beginMessage(
      context.userId,
      id,
    );
    if (!prepared) throw new ResourceNotFoundError();
    const { session, started } = prepared;
    this.assertNotTerminated(session);

    let event;
    try {
      event = await this.dependencies.ark.submitEvent(
        session.arkSessionId,
        {
          type: "user.message",
          data: { content: input.content.trim() },
        },
        { correlationId: context.requestId },
      );
    } catch (error) {
      await this.dependencies.repository.finishMessage(
        context.userId,
        id,
        isArkCategory(error, "unknown_write_outcome")
          ? "accepted_or_unknown"
          : "definite_failure",
      );
      await this.audit(context, "session.message", id, "failed", error);
      if (isArkCategory(error, "session_terminated")) {
        throw new SessionTerminatedError();
      }
      throw error;
    }

    await this.dependencies.repository.finishMessage(
      context.userId,
      id,
      "accepted_or_unknown",
    );
    await this.audit(context, "session.message", id, "succeeded");
    return {
      eventId: event.id,
      delivery: started ? "accepted" : "queued",
    };
  }

  async interrupt(
    id: string,
    context: SessionContext,
  ): Promise<{ eventId: string; delivery: "accepted" }> {
    const session = await this.requireOwned(context.userId, id);
    this.assertNotTerminated(session);

    try {
      const event = await this.dependencies.ark.submitEvent(
        session.arkSessionId,
        { type: "user.interrupt", data: {} },
        { correlationId: context.requestId },
      );
      await this.audit(context, "session.interrupt", id, "succeeded");
      return { eventId: event.id, delivery: "accepted" };
    } catch (error) {
      await this.audit(context, "session.interrupt", id, "failed", error);
      if (isArkCategory(error, "session_terminated")) {
        throw new SessionTerminatedError();
      }
      throw error;
    }
  }

  async reconcileCreate(
    id: string,
    context: SessionContext,
  ): Promise<SessionRecord> {
    const intent = await this.dependencies.repository.findCreateIntent(
      context.userId,
      id,
    );
    if (!intent) throw new ResourceNotFoundError();

    const upstream = intent.arkSessionId.startsWith("pending:")
      ? await this.dependencies.ark.createSession(
          this.arkCreateInput(intent),
          this.createOptions(id),
        )
      : await this.dependencies.ark.getSession(intent.arkSessionId, {
          correlationId: context.requestId,
        });
    return this.dependencies.repository.completeCreate(
      id,
      context.userId,
      this.upstreamSnapshot(upstream),
    );
  }

  private async requireOwned(
    userId: string,
    id: string,
  ): Promise<SessionRecord> {
    const session = await this.dependencies.repository.findOwned(userId, id);
    if (!session) throw new ResourceNotFoundError();
    return session;
  }

  private assertNotTerminated(session: SessionRecord): void {
    if (session.status === "terminated") throw new SessionTerminatedError();
  }

  private arkCreateInput(session: SessionRecord) {
    return {
      agentId: session.arkAgentId,
      agentVersion: Number(session.agentVersion),
      environmentId: session.environmentId,
      resources: [],
    };
  }

  private createOptions(id: string): ArkRequestOptions {
    const operationId = createOperationId(id);
    return { correlationId: operationId, idempotencyKey: operationId };
  }

  private upstreamSnapshot(upstream: ArkSession) {
    return {
      arkSessionId: upstream.id,
      arkAgentId: upstream.agentId,
      agentVersion: String(upstream.agentVersion),
      status: upstream.status,
    };
  }

  private async audit(
    context: SessionContext,
    action: string,
    resourceId: string,
    result: "succeeded" | "failed",
    error?: unknown,
  ): Promise<void> {
    try {
      await this.dependencies.repository.audit({
        actorUserId: context.userId,
        ownerUserId: context.userId,
        action,
        resourceType: "session",
        resourceId,
        result,
        requestId: context.requestId,
        ...(error
          ? {
              errorCode:
                typeof error === "object" &&
                error !== null &&
                "code" in error &&
                typeof error.code === "string"
                  ? error.code
                  : arkErrorCode(error),
              ...(arkRequestId(error)
                ? { arkRequestId: arkRequestId(error) }
                : {}),
            }
          : {}),
      });
    } catch {
      // Auditing is best-effort and must not change mutation semantics.
    }
  }
}

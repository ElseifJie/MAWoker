import type {
  ArkEvent,
  ArkGateway,
  ArkRequestOptions,
  ArkSession,
  ArkSessionConfigSnapshot,
} from "@pwa/ark-client";
import {
  normalizeArkEvent,
  projectUiEvent,
  type SessionStatus,
  type UiEvent,
} from "@pwa/contracts";
import type { AvailableAgentRecord } from "./user-agents.js";
import { arkErrorCode, arkRequestId, isArkCategory } from "./ark-errors.js";
import { ResourceNotFoundError } from "./errors.js";
import type { SessionInputRecord } from "./session-inputs.js";
import {
  isPublicSessionEvent,
  projectArkEvent,
  type ArkEventProjection,
} from "./usage.js";

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
  createAttemptedAt: Date | null;
  modelId: string | null;
  configSnapshot: SessionConfigSnapshot | null;
  configSnapshotState: "unverified" | "verified" | "incomplete" | "mismatch";
  configSnapshotErrorCode: string | null;
  memoryStoreId?: string | null;
  title: string;
  status: SessionStatus;
  lastErrorCode: string | null;
  errorRecoverable: boolean | null;
  archivedAt: Date | null;
  pinnedAt: Date | null;
  deletionState: "none" | "pending" | "deletion_failed" | "deleted";
  lastEventAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionConfigSnapshot extends ArkSessionConfigSnapshot {
  agentId: string;
  agentVersion: string;
  environmentId: string;
}

interface VerifiedCreateObservation {
  arkSessionId: string;
  status: SessionStatus;
  modelId: string;
  configSnapshot: SessionConfigSnapshot;
  configSnapshotState: "verified";
  configSnapshotErrorCode: null;
}

interface UnverifiedCreateObservation {
  arkSessionId: string;
  status: SessionStatus;
  modelId: string | null;
  configSnapshot: SessionConfigSnapshot;
  configSnapshotState: "incomplete" | "mismatch";
  configSnapshotErrorCode: SessionCreateVerificationErrorCode;
}

type CreateObservation =
  VerifiedCreateObservation | UnverifiedCreateObservation;

/**
 * A projected UI event as stored locally. Ark remains the source of truth; this
 * is a cache of events already observed, so a Session reopens from the database
 * instead of replaying its whole history upstream.
 */
export interface StoredSessionEvent {
  eventId: string;
  sourceType: string;
  /** The projected type as written; `uiEventType` re-derives it on read. */
  type: string;
  occurredAt: Date;
  payload: Record<string, unknown>;
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
  prepareCreate(
    record: SessionRecord,
    uploadIds?: string[],
  ): PromiseLike<SessionInputRecord[] | void>;
  claimCreateAttempt(
    id: string,
    userId: string,
    attemptedAt: Date,
  ): PromiseLike<boolean>;
  releaseCreateAttempt(
    id: string,
    userId: string,
    attemptedAt: Date,
  ): PromiseLike<boolean>;
  completeCreate(
    id: string,
    userId: string,
    upstream: VerifiedCreateObservation,
  ): PromiseLike<SessionRecord>;
  preserveCreateOutcome(
    id: string,
    userId: string,
    upstream?: CreateObservation,
  ): PromiseLike<void>;
  failCreate(id: string, userId: string): PromiseLike<void>;
  listOwned(userId: string, archived: boolean): PromiseLike<SessionRecord[]>;
  findOwned(userId: string, id: string): PromiseLike<SessionRecord | undefined>;
  findCreateIntent(
    userId: string,
    id: string,
  ): PromiseLike<SessionRecord | undefined>;
  setArchived(
    userId: string,
    id: string,
    archivedAt: Date | null,
  ): PromiseLike<SessionRecord | undefined>;
  rename?(
    userId: string,
    id: string,
    title: string,
  ): PromiseLike<SessionRecord | undefined>;
  setPinned?(
    userId: string,
    id: string,
    pinnedAt: Date | null,
  ): PromiseLike<SessionRecord | undefined>;
  /** Local event cache: absent in repositories that predate it. */
  listEvents?(userId: string, id: string): PromiseLike<StoredSessionEvent[]>;
  appendEvents?(
    userId: string,
    id: string,
    events: StoredSessionEvent[],
  ): PromiseLike<void>;
  historyBackfilled?(userId: string, id: string): PromiseLike<boolean>;
  markHistoryBackfilled?(userId: string, id: string): PromiseLike<void>;
  beginDelete(
    userId: string,
    id: string,
  ): PromiseLike<SessionRecord | undefined>;
  listInputs?(userId: string, id: string): PromiseLike<SessionInputRecord[]>;
  beginMessage(
    userId: string,
    id: string,
  ): PromiseLike<
    | {
        kind: "accepted";
        session: SessionRecord;
        started: boolean;
      }
    | {
        kind: "deletion_conflict";
        deletionState: "pending" | "deletion_failed";
      }
    | undefined
  >;
  finishMessage(
    userId: string,
    id: string,
    outcome: "accepted_or_unknown" | "unknown" | "definite_failure",
  ): PromiseLike<void>;
  projectEvent(
    userId: string,
    id: string,
    projection: ArkEventProjection,
  ): PromiseLike<boolean>;
  listRunningForQuota?(userId: string): PromiseLike<SessionRecord[]>;
  syncQuotaStatus?(
    userId: string,
    id: string,
    status: SessionStatus,
    observedAt: Date,
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

export class SessionDeletionConflictError extends Error {
  readonly code: "DELETION_PENDING" | "DELETION_FAILED";

  constructor(public readonly deletionState: "pending" | "deletion_failed") {
    super(
      deletionState === "pending"
        ? "Session deletion is pending"
        : "Session deletion has failed",
    );
    this.name = "SessionDeletionConflictError";
    this.code =
      deletionState === "pending" ? "DELETION_PENDING" : "DELETION_FAILED";
  }
}

export type SessionCreateVerificationErrorCode =
  | "ARK_SESSION_AGENT_ID_MISMATCH"
  | "ARK_SESSION_AGENT_VERSION_MISMATCH"
  | "ARK_SESSION_ENVIRONMENT_ID_MISMATCH"
  | "ARK_SESSION_SNAPSHOT_ENVIRONMENT_ID_MISMATCH"
  | "ARK_SESSION_CONFIG_SNAPSHOT_INCOMPLETE"
  | "ARK_SESSION_CREATE_OUTCOME_UNKNOWN";

export class SessionCreateVerificationError extends Error {
  constructor(public readonly code: SessionCreateVerificationErrorCode) {
    super(
      code === "ARK_SESSION_CREATE_OUTCOME_UNKNOWN"
        ? "Ark Session create outcome is unknown; automatic POST retry is disabled"
        : "Ark Session response does not verify the requested configuration",
    );
    this.name = "SessionCreateVerificationError";
  }
}

function createOperationId(id: string): string {
  return `session-create:${id}`;
}

/** The session-level end_turn marker: a completed assistant turn. */
function turnEnded(event: ArkEvent): boolean {
  const stop = event.data?.stop_reason;
  return (
    (event.type === "session.status_idle" || event.type === "session.status") &&
    typeof stop === "object" &&
    stop !== null &&
    "type" in stop &&
    stop.type === "end_turn"
  );
}

const liveEventBufferCapacity = 100;
/** Events written per insert while copying the upstream history into the log. */
const storedEventBatchSize = 50;

class BoundedAsyncQueue<T> {
  private readonly values: T[] = [];
  private readonly readers = new Set<() => void>();
  private readonly writers = new Set<() => void>();
  private closed = false;
  private failure: unknown;

  constructor(private readonly capacity: number) {}

  get full(): boolean {
    return this.values.length >= this.capacity;
  }

  async waitForSpace(signal: AbortSignal): Promise<boolean> {
    while (
      !this.closed &&
      !signal.aborted &&
      this.values.length >= this.capacity
    ) {
      await new Promise<void>((resolve) => this.writers.add(resolve));
    }
    return !this.closed && !signal.aborted;
  }

  push(value: T): boolean {
    if (this.closed || this.values.length >= this.capacity) return false;
    this.values.push(value);
    this.wake(this.readers);
    return true;
  }

  async shift(signal: AbortSignal): Promise<IteratorResult<T>> {
    while (this.values.length === 0) {
      if (this.failure !== undefined) throw this.failure;
      if (this.closed || signal.aborted) {
        return { done: true, value: undefined };
      }
      await new Promise<void>((resolve) => this.readers.add(resolve));
    }
    if (signal.aborted) return { done: true, value: undefined };
    const value = this.values.shift()!;
    this.wake(this.writers);
    return { done: false, value };
  }

  close(failure?: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.failure = failure;
    this.wake(this.readers);
    this.wake(this.writers);
  }

  private wake(waiters: Set<() => void>): void {
    for (const resolve of waiters) resolve();
    waiters.clear();
  }
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
      ark: Pick<
        ArkGateway,
        | "createSession"
        | "getSession"
        | "submitEvent"
        | "listEvents"
        | "streamEvents"
      >;
      environmentId: string;
      memory?: {
        ensure(userId: string): Promise<string>;
        gate(userId: string): Promise<void>;
        expedite?(userId: string): Promise<void>;
      };
      createId: () => string;
      now?: () => Date;
    },
  ) {}

  async create(
    input: {
      agentId: string;
      title?: string;
      uploadIds?: string[];
      temporary?: boolean;
    },
    context: SessionContext,
  ): Promise<SessionRecord & { inputs?: SessionInputRecord[] }> {
    const agent = await this.dependencies.agentResolver.resolveForNewSession(
      context.userId,
      input.agentId,
    );
    const memoryStoreId =
      !input.temporary && this.dependencies.memory
        ? await this.dependencies.memory.ensure(context.userId)
        : null;
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
      createAttemptedAt: null,
      modelId: null,
      configSnapshot: null,
      configSnapshotState: "unverified",
      configSnapshotErrorCode: null,
      memoryStoreId,
      title: input.title?.trim() ?? "",
      status: "idle",
      lastErrorCode: null,
      errorRecoverable: null,
      archivedAt: null,
      pinnedAt: null,
      deletionState: "none",
      lastEventAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const uploadIds = [...new Set(input.uploadIds ?? [])];
    const inputs =
      (await this.dependencies.repository.prepareCreate(intent, uploadIds)) ??
      [];

    const claimed = await this.dependencies.repository.claimCreateAttempt(
      id,
      context.userId,
      timestamp,
    );
    if (!claimed) {
      const error = new SessionCreateVerificationError(
        "ARK_SESSION_CREATE_OUTCOME_UNKNOWN",
      );
      await this.audit(context, "session.create", id, "failed", error);
      throw error;
    }

    let upstream: ArkSession;
    try {
      upstream = await this.dependencies.ark.createSession(
        this.arkCreateInput(intent, inputs),
        this.createOptions(id),
      );
    } catch (error) {
      if (isArkCategory(error, "unknown_write_outcome")) {
        await this.dependencies.repository.preserveCreateOutcome(
          id,
          context.userId,
        );
      } else if (inputs.length > 0) {
        await this.dependencies.repository.releaseCreateAttempt(
          id,
          context.userId,
          timestamp,
        );
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

    const observation = this.observeCreate(intent, upstream);
    try {
      const created = await this.finalizeCreate(
        id,
        context.userId,
        observation,
      );
      await this.audit(context, "session.create", id, "succeeded");
      return inputs.length > 0 ? { ...created, inputs } : created;
    } catch (error) {
      await this.audit(
        context,
        "session.create",
        id,
        "failed",
        error instanceof SessionCreateVerificationError
          ? error
          : { code: "DB_PERSISTENCE_FAILED" },
      );
      throw error;
    }
  }

  list(userId: string, archived = false): PromiseLike<SessionRecord[]> {
    return this.dependencies.repository.listOwned(userId, archived);
  }

  async get(
    userId: string,
    id: string,
  ): Promise<SessionRecord & { inputs: SessionInputRecord[] }> {
    const session = await this.requireOwned(userId, id);
    const inputs = this.dependencies.repository.listInputs
      ? await this.dependencies.repository.listInputs(userId, id)
      : [];
    return { ...session, inputs };
  }

  async archive(id: string, userId: string): Promise<SessionRecord> {
    const session = await this.dependencies.repository.setArchived(
      userId,
      id,
      (this.dependencies.now ?? (() => new Date()))(),
    );
    if (!session) throw new ResourceNotFoundError();
    // Archiving is a natural consolidation point: expedite the memory
    // monitor fire-and-forget so the session's increments settle soon.
    if (session.memoryStoreId != null) {
      void this.dependencies.memory?.expedite?.(userId).catch(() => undefined);
    }
    return session;
  }

  async restore(id: string, userId: string): Promise<SessionRecord> {
    const session = await this.dependencies.repository.setArchived(
      userId,
      id,
      null,
    );
    if (!session) throw new ResourceNotFoundError();
    return session;
  }

  async requestDelete(id: string, userId: string): Promise<SessionRecord> {
    const session = await this.dependencies.repository.beginDelete(userId, id);
    if (!session) throw new ResourceNotFoundError();
    return session;
  }

  /**
   * Renaming only touches our own label for the Session — the title Ark sees is
   * derived from the first message and is deliberately left alone.
   */
  async rename(
    id: string,
    title: string,
    context: SessionContext,
  ): Promise<SessionRecord> {
    const rename = this.dependencies.repository.rename;
    if (!rename) throw new Error("Session renaming is not supported");
    const session = await rename.call(
      this.dependencies.repository,
      context.userId,
      id,
      title.trim(),
    );
    if (!session) throw new ResourceNotFoundError();
    await this.audit(context, "session.rename", id, "succeeded");
    return session;
  }

  async setPinned(
    id: string,
    pinned: boolean,
    context: SessionContext,
  ): Promise<SessionRecord> {
    const setPinned = this.dependencies.repository.setPinned;
    if (!setPinned) throw new Error("Session pinning is not supported");
    const session = await setPinned.call(
      this.dependencies.repository,
      context.userId,
      id,
      pinned ? (this.dependencies.now ?? (() => new Date()))() : null,
    );
    if (!session) throw new ResourceNotFoundError();
    await this.audit(
      context,
      pinned ? "session.pin" : "session.unpin",
      id,
      "succeeded",
    );
    return session;
  }

  async sendMessage(
    id: string,
    input: { content: string },
    context: SessionContext,
  ): Promise<{ eventId: string; delivery: "accepted" | "queued" }> {
    if (this.dependencies.memory) {
      const session = await this.requireOwned(context.userId, id);
      if (session.memoryStoreId != null) {
        await this.dependencies.memory.gate(context.userId);
      }
    }
    let prepared;
    try {
      prepared = await this.dependencies.repository.beginMessage(
        context.userId,
        id,
      );
    } catch (error) {
      if (!this.isConcurrentQuotaError(error)) throw error;
      await this.reconcileConcurrentQuota(context);
      prepared = await this.dependencies.repository.beginMessage(
        context.userId,
        id,
      );
    }
    if (!prepared) throw new ResourceNotFoundError();
    if (prepared.kind === "deletion_conflict") {
      throw new SessionDeletionConflictError(prepared.deletionState);
    }
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
          ? "unknown"
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

  async openEvents(
    id: string,
    context: SessionContext,
    downstreamSignal?: AbortSignal,
  ): Promise<{ session: SessionRecord; events: AsyncIterable<UiEvent> }> {
    const session = await this.requireOwned(context.userId, id);
    const repository = this.dependencies.repository;
    const stored = repository.listEvents
      ? await repository.listEvents(context.userId, id)
      : [];
    // The local log may only stand in for the upstream history once the whole
    // history has been copied in. Otherwise this open would silently show a
    // truncated Session.
    const backfilled = repository.historyBackfilled
      ? await repository.historyBackfilled(context.userId, id)
      : false;

    const upstreamController = new AbortController();
    const abortUpstream = () => upstreamController.abort();
    if (downstreamSignal?.aborted) {
      upstreamController.abort();
    } else {
      downstreamSignal?.addEventListener("abort", abortUpstream, {
        once: true,
      });
    }

    let live: AsyncIterable<ArkEvent>;
    try {
      live = await this.dependencies.ark.streamEvents(session.arkSessionId, {
        correlationId: context.requestId,
        signal: upstreamController.signal,
      });
    } catch (error) {
      downstreamSignal?.removeEventListener("abort", abortUpstream);
      throw error;
    }

    const liveIterator = live[Symbol.asyncIterator]();
    const buffered = new BoundedAsyncQueue<ArkEvent>(liveEventBufferCapacity);
    upstreamController.signal.addEventListener(
      "abort",
      () => buffered.close(),
      { once: true },
    );
    const pump = (async () => {
      let streamError: unknown;
      try {
        while (!upstreamController.signal.aborted) {
          if (
            buffered.full &&
            !(await buffered.waitForSpace(upstreamController.signal))
          ) {
            break;
          }
          const next = await liveIterator.next();
          if (next.done) break;
          if (!buffered.push(next.value)) break;
          if (projectArkEvent(next.value).status === "terminated") break;
        }
      } catch (error) {
        if (!upstreamController.signal.aborted) streamError = error;
      } finally {
        buffered.close(streamError);
      }
    })();
    // Started before the first byte reaches the browser so live events cannot
    // be lost while the stored history is being written out.
    const history = backfilled
      ? null
      : this.dependencies.ark.listEvents(session.arkSessionId, {
          correlationId: context.requestId,
          signal: upstreamController.signal,
        });
    const projectEvent = (source: ArkEvent) =>
      this.projectEvent(session, source, context.userId);
    // The iterator below is a standalone generator object: capture what it
    // needs here, `this` does not reach inside.
    const memoryHooks = this.dependencies.memory;
    const memoryUserId = context.userId;
    const memorySessionStoreId = session.memoryStoreId;
    const toStoredEvent = (item: StoredSessionEvent) =>
      this.storedToUiEvent(item);
    const writeBatch = async (events: UiEvent[]) => {
      await this.appendStoredEvents(context.userId, id, events);
    };
    const markBackfilled = async () => {
      await this.markHistoryComplete(context.userId, id);
    };

    return {
      session,
      events: {
        async *[Symbol.asyncIterator]() {
          const seen = new Set<string>();
          const pending: UiEvent[] = [];
          // Persisting before yielding keeps the promise that anything the
          // browser has seen is already in the log, so it survives a reload.
          const drain = async (): Promise<UiEvent[]> => {
            if (pending.length === 0) return [];
            const batch = pending.splice(0, pending.length);
            await writeBatch(batch);
            return batch;
          };
          try {
            for (const item of stored) {
              if (upstreamController.signal.aborted) return;
              seen.add(item.eventId);
              yield toStoredEvent(item);
            }

            if (history) {
              for (const source of await history) {
                if (upstreamController.signal.aborted) return;
                if (seen.has(source.id)) continue;
                seen.add(source.id);
                const projected = await projectEvent(source);
                if (isPublicSessionEvent(source.type)) {
                  pending.push(normalizeArkEvent(source));
                  if (pending.length >= storedEventBatchSize) {
                    for (const event of await drain()) yield event;
                  }
                }
                if (projected.status === "terminated") {
                  for (const event of await drain()) yield event;
                  return;
                }
              }
              for (const event of await drain()) yield event;
              await markBackfilled();
            }

            while (true) {
              const next = await buffered.shift(upstreamController.signal);
              if (next.done) return;
              const source = next.value;
              if (seen.has(source.id)) continue;
              seen.add(source.id);
              const projected = await projectEvent(source);
              // Turn boundary reached while the user is watching: expedite
              // memory consolidation fire-and-forget, never blocking the
              // stream. Absent viewers fall back to the monitor interval.
              if (memorySessionStoreId != null && turnEnded(source)) {
                void memoryHooks
                  ?.expedite?.(memoryUserId)
                  .catch(() => undefined);
              }
              if (isPublicSessionEvent(source.type)) {
                pending.push(normalizeArkEvent(source));
                for (const event of await drain()) yield event;
              }
              if (projected.status === "terminated") return;
            }
          } finally {
            upstreamController.abort();
            buffered.close();
            downstreamSignal?.removeEventListener("abort", abortUpstream);
            try {
              await liveIterator.return?.();
            } finally {
              await pump;
            }
          }
        },
      },
    };
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
    const inputs = this.dependencies.repository.listInputs
      ? await this.dependencies.repository.listInputs(context.userId, id)
      : [];

    const pending = intent.arkSessionId.startsWith("pending:");
    if (pending && intent.createAttemptedAt !== null) {
      throw new SessionCreateVerificationError(
        "ARK_SESSION_CREATE_OUTCOME_UNKNOWN",
      );
    }
    if (pending && intent.memoryStoreId != null) {
      await this.dependencies.memory?.gate(context.userId);
    }

    let upstream: ArkSession;
    if (pending) {
      const attemptedAt = (this.dependencies.now ?? (() => new Date()))();
      const claimed = await this.dependencies.repository.claimCreateAttempt(
        id,
        context.userId,
        attemptedAt,
      );
      if (!claimed) {
        throw new SessionCreateVerificationError(
          "ARK_SESSION_CREATE_OUTCOME_UNKNOWN",
        );
      }
      try {
        upstream = await this.dependencies.ark.createSession(
          this.arkCreateInput(intent, inputs),
          this.createOptions(id),
        );
      } catch (error) {
        if (isArkCategory(error, "unknown_write_outcome")) {
          await this.dependencies.repository.preserveCreateOutcome(
            id,
            context.userId,
          );
        } else {
          await this.dependencies.repository.releaseCreateAttempt(
            id,
            context.userId,
            attemptedAt,
          );
        }
        throw error;
      }
    } else {
      upstream = await this.dependencies.ark.getSession(intent.arkSessionId, {
        correlationId: context.requestId,
      });
    }

    return this.finalizeCreate(
      id,
      context.userId,
      this.observeCreate(intent, upstream),
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

  /**
   * The log is a cache: failing to extend it must not interrupt a live Session,
   * and a missed bookkeeping write only costs a redundant replay next time.
   */
  private async appendStoredEvents(
    userId: string,
    id: string,
    events: UiEvent[],
  ): Promise<void> {
    const append = this.dependencies.repository.appendEvents;
    if (events.length === 0 || !append) return;
    try {
      await append.call(
        this.dependencies.repository,
        userId,
        id,
        events.map((event) => ({
          eventId: event.id,
          sourceType: event.sourceType,
          type: event.type,
          occurredAt: new Date(event.createdAt),
          payload: event.payload,
        })),
      );
    } catch {
      // Ignored on purpose: see the doc comment.
    }
  }

  private async markHistoryComplete(userId: string, id: string): Promise<void> {
    const mark = this.dependencies.repository.markHistoryBackfilled;
    if (!mark) return;
    try {
      await mark.call(this.dependencies.repository, userId, id);
    } catch {
      // Ignored on purpose: see the doc comment on `appendStoredEvents`.
    }
  }

  private storedToUiEvent(item: StoredSessionEvent): UiEvent {
    return projectUiEvent({
      id: item.eventId,
      sourceType: item.sourceType,
      type: "unknown",
      createdAt: item.occurredAt.toISOString(),
      payload: item.payload,
    });
  }

  /**
   * Every projected event for a Session, newest last. Copies the upstream
   * history into the log first when that has never happened, so an export of an
   * old Session is complete rather than just what happened to be cached.
   */
  async transcriptEvents(
    id: string,
    context: SessionContext,
    signal?: AbortSignal,
  ): Promise<UiEvent[]> {
    const session = await this.requireOwned(context.userId, id);
    const repository = this.dependencies.repository;
    const list = repository.listEvents;
    if (!list) throw new Error("Session transcripts are not supported");

    const complete = repository.historyBackfilled
      ? await repository.historyBackfilled(context.userId, id)
      : true;
    if (!complete) {
      const sources = await this.dependencies.ark.listEvents(
        session.arkSessionId,
        {
          correlationId: context.requestId,
          ...(signal ? { signal } : {}),
        },
      );
      sources.sort(
        (left, right) =>
          Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
          left.id.localeCompare(right.id),
      );
      const projected: UiEvent[] = [];
      for (const source of sources) {
        await this.projectEvent(session, source, context.userId);
        if (isPublicSessionEvent(source.type)) {
          projected.push(normalizeArkEvent(source));
        }
      }
      await this.appendStoredEvents(context.userId, id, projected);
      await this.markHistoryComplete(context.userId, id);
    }

    const stored = await list.call(repository, context.userId, id);
    return stored.map((item) => this.storedToUiEvent(item));
  }

  private assertNotTerminated(session: SessionRecord): void {
    if (session.status === "terminated") throw new SessionTerminatedError();
  }

  private isConcurrentQuotaError(error: unknown): boolean {
    return (
      error instanceof Error &&
      error.name === "QuotaExceededError" &&
      "dimension" in error &&
      error.dimension === "concurrent_sessions"
    );
  }

  private async reconcileConcurrentQuota(
    context: SessionContext,
  ): Promise<void> {
    const { listRunningForQuota, syncQuotaStatus } =
      this.dependencies.repository;
    if (!listRunningForQuota || !syncQuotaStatus) {
      throw Object.assign(new Error("Concurrent Session quota exceeded"), {
        name: "QuotaExceededError",
        dimension: "concurrent_sessions",
      });
    }
    const active = await listRunningForQuota(context.userId);
    for (const session of active) {
      const upstream = await this.dependencies.ark.getSession(
        session.arkSessionId,
        {
          correlationId: `${context.requestId}:quota:${session.id}`,
        },
      );
      await syncQuotaStatus(
        context.userId,
        session.id,
        upstream.status,
        (this.dependencies.now ?? (() => new Date()))(),
      );
    }
  }

  private arkCreateInput(
    session: SessionRecord,
    inputs: SessionInputRecord[] = [],
  ) {
    return {
      agentId: session.arkAgentId,
      agentVersion: Number(session.agentVersion),
      environmentId: session.environmentId,
      resources: [
        ...inputs.map((input) => ({
          fileId: input.arkFileId!,
          mountPath: input.mountPath,
        })),
        ...(session.memoryStoreId != null
          ? [
              {
                type: "memory_store" as const,
                memoryStoreId: session.memoryStoreId,
                access: "read_write" as const,
              },
            ]
          : []),
      ],
    };
  }

  private createOptions(id: string): ArkRequestOptions {
    const operationId = createOperationId(id);
    return { correlationId: operationId, idempotencyKey: operationId };
  }

  private observeCreate(
    intent: SessionRecord,
    upstream: ArkSession,
  ): CreateObservation {
    const configSnapshot: SessionConfigSnapshot = {
      agentId: upstream.agentId,
      agentVersion: String(upstream.agentVersion),
      environmentId: upstream.environmentId,
      ...upstream.configSnapshot,
    };
    const mismatchCode =
      upstream.agentId !== intent.arkAgentId
        ? "ARK_SESSION_AGENT_ID_MISMATCH"
        : String(upstream.agentVersion) !== intent.agentVersion
          ? "ARK_SESSION_AGENT_VERSION_MISMATCH"
          : upstream.environmentId !== intent.environmentId
            ? "ARK_SESSION_ENVIRONMENT_ID_MISMATCH"
            : upstream.configSnapshot.environment.id !== null &&
                upstream.configSnapshot.environment.id !== intent.environmentId
              ? "ARK_SESSION_SNAPSHOT_ENVIRONMENT_ID_MISMATCH"
              : null;
    const shared = {
      arkSessionId: upstream.id,
      status: upstream.status,
      modelId: upstream.configSnapshot.modelId,
      configSnapshot,
    };
    if (mismatchCode) {
      return {
        ...shared,
        configSnapshotState: "mismatch",
        configSnapshotErrorCode: mismatchCode,
      };
    }
    if (
      upstream.configSnapshot.completeness !== "complete" ||
      upstream.configSnapshot.modelId === null
    ) {
      return {
        ...shared,
        configSnapshotState: "incomplete",
        configSnapshotErrorCode: "ARK_SESSION_CONFIG_SNAPSHOT_INCOMPLETE",
      };
    }
    return {
      ...shared,
      modelId: upstream.configSnapshot.modelId,
      configSnapshotState: "verified",
      configSnapshotErrorCode: null,
    };
  }

  private async finalizeCreate(
    id: string,
    userId: string,
    observation: CreateObservation,
  ): Promise<SessionRecord> {
    if (observation.configSnapshotState !== "verified") {
      await this.dependencies.repository.preserveCreateOutcome(
        id,
        userId,
        observation,
      );
      throw new SessionCreateVerificationError(
        observation.configSnapshotErrorCode,
      );
    }
    try {
      return await this.dependencies.repository.completeCreate(
        id,
        userId,
        observation,
      );
    } catch (error) {
      await this.dependencies.repository.preserveCreateOutcome(
        id,
        userId,
        observation,
      );
      throw error;
    }
  }

  private async projectEvent(
    session: SessionRecord,
    event: ArkEvent,
    userId: string,
  ) {
    const projection = projectArkEvent(event);
    await this.dependencies.repository.projectEvent(
      userId,
      session.id,
      projection,
    );
    return projection;
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

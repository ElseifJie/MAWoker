import type { ArkGateway, SessionStatus } from "@pwa/ark-client";
import type { DeletionLogStore } from "@pwa/domain";

type CompletedSteps = {
  interruptRequested?: true;
  nonRunningObserved?: true;
  settlementConfirmed?: true;
  arkDeleted?: true;
  artifactsOrphaned?: true;
};

/**
 * Settlement gate delays: a transient `pending` verdict re-checks quickly,
 * while `unknown` parks the job for maintenance-scale intervals. Neither
 * consumes the attempt budget — the Session stays verifiable until a pass
 * proves `confirmed`.
 */
const SETTLEMENT_PENDING_DEFER_MS = 30_000;
const SETTLEMENT_UNKNOWN_DEFER_MS = 3_600_000;

/**
 * How long a delete job may sit on the memory fence without progress before
 * it falls back to consuming its attempt budget (so a permanently stuck
 * consolidation still surfaces as a failed deletion instead of waiting
 * forever), and how long each fence wait defers the job.
 */
const FENCE_WAIT_BUDGET_MS = 3_600_000;
const FENCE_DEFER_MS = 30_000;

interface SessionDeletionPayload extends Record<string, unknown> {
  sessionId: string;
  completed: CompletedSteps;
  /** Epoch ms when the current fence-wait streak began; absent until the
   * fence first reports "capturing". */
  fenceWaitStartedAt?: number;
}

export interface SessionDeletionJob {
  id: string;
  ownerUserId: string | null;
  type:
    | "delete_session"
    | "delete_artifact"
    | "cleanup_artifact_object"
    | "cleanup_drive_object"
    | "cleanup_upload"
    | "reconcile_session"
    | "reconcile_personal_agent";
  status: "running";
  priority: number;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  runAfter: Date;
  lockedAt: Date;
  lockedBy: string;
  leaseGeneration: number;
  createdAt: Date;
}

interface SessionDeletionJobs {
  claim(input: {
    workerId: string;
    limit: number;
    types: ["delete_session"];
  }): PromiseLike<SessionDeletionJob[]>;
  updatePayload(
    id: string,
    workerId: string,
    payload: SessionDeletionPayload,
    leaseGeneration: number,
  ): PromiseLike<void>;
  succeed(
    id: string,
    workerId: string,
    leaseGeneration: number,
  ): PromiseLike<void>;
  retry(
    id: string,
    workerId: string,
    error: string,
    final: boolean,
    leaseGeneration: number,
  ): PromiseLike<void>;
  /** Returns a fence-blocked job to the queue without consuming an attempt:
   * consolidation progresses in this same worker, so waiting is progress.
   * Reports false when the lease was lost; the caller then retries. */
  deferSessionDeletion(
    id: string,
    workerId: string,
    runAfter: Date,
    leaseGeneration: number,
  ): PromiseLike<boolean>;
  /** Extends the lease of still-owned jobs; a miss means takeover. */
  heartbeat(input: {
    items: Array<{ id: string; leaseGeneration: number }>;
    workerId: string;
  }): PromiseLike<number>;
}

interface SessionDeletionRepository {
  findDeleting(
    userId: string,
    id: string,
  ): PromiseLike<
    | {
        id: string;
        ownerUserId: string;
        arkSessionId: string;
        status: SessionStatus;
        createAttemptedAt?: Date | null;
      }
    | undefined
  >;
  /**
   * Marks drive objects that only this Session referenced as orphaned. The
   * bytes are not deleted here: the drive GC reaps them after the configured
   * retention, which is what allows a drive mode to keep Agent output.
   */
  orphanDriveFiles(userId: string, id: string, at: Date): PromiseLike<number>;
  removeLocal(
    userId: string,
    id: string,
  ): PromiseLike<"removed" | "missing" | "cleanup_pending" | "cleanup_failed">;
}

class InvalidSessionDeletionJobError extends Error {}
class SessionStillRunningError extends Error {}
class SessionCleanupFailedError extends Error {}

function isArkNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "category" in error &&
    error.category === "not_found"
  );
}

function parsePayload(job: SessionDeletionJob): SessionDeletionPayload {
  const sessionId = job.payload.sessionId;
  const completed = job.payload.completed;
  if (
    job.type !== "delete_session" ||
    !job.ownerUserId ||
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    sessionId !== job.id ||
    typeof completed !== "object" ||
    completed === null ||
    Array.isArray(completed)
  ) {
    throw new InvalidSessionDeletionJobError();
  }
  const allowed = new Set([
    "interruptRequested",
    "nonRunningObserved",
    "settlementConfirmed",
    "arkDeleted",
    "artifactsOrphaned",
  ]);
  const completedSteps = completed as Record<string, unknown>;
  if (
    Object.entries(completedSteps).some(
      ([key, value]) => !allowed.has(key) || value !== true,
    ) ||
    (completedSteps.arkDeleted === true &&
      (completedSteps.settlementConfirmed !== true ||
        completedSteps.nonRunningObserved !== true)) ||
    (completedSteps.settlementConfirmed === true &&
      completedSteps.nonRunningObserved !== true) ||
    (completedSteps.artifactsOrphaned === true &&
      completedSteps.arkDeleted !== true)
  ) {
    throw new InvalidSessionDeletionJobError();
  }
  return {
    sessionId,
    completed: { ...(completedSteps as CompletedSteps) },
    ...(typeof job.payload.fenceWaitStartedAt === "number" &&
    Number.isFinite(job.payload.fenceWaitStartedAt)
      ? { fenceWaitStartedAt: job.payload.fenceWaitStartedAt }
      : {}),
  };
}

function retryError(error: unknown): string {
  if (error instanceof InvalidSessionDeletionJobError) {
    return "SESSION_DELETE_INVALID_JOB";
  }
  if (error instanceof SessionStillRunningError) {
    return "SESSION_DELETE_WAITING";
  }
  if (error instanceof SessionCleanupFailedError) {
    return "SESSION_DELETE_FAILED";
  }
  return "SESSION_DELETE_FAILED";
}

export interface SessionDeletionAlert {
  jobType: "delete_session";
  jobId: string;
  userId: string | null;
  sessionId: string;
  attempts: number;
  maxAttempts: number;
  errorCode: string;
}

export class SessionDeletionProcessor {
  constructor(
    private readonly dependencies: {
      jobs: SessionDeletionJobs;
      repository: SessionDeletionRepository;
      ark: Pick<ArkGateway, "getSession" | "submitEvent" | "deleteSession">;
      /**
       * Pre-deletion settlement gate: the irreversible upstream delete may
       * only run after a verification pass proves usage completeness.
       */
      settlement: {
        verify(
          userId: string,
          sessionId: string,
          context: { requestId: string },
        ): PromiseLike<"pending" | "confirmed" | "unknown">;
      };
      /**
       * Append-only deletion intent log, stored outside the business
       * database. The irreversible upstream delete only runs after the
       * intent is persisted AND read back intact.
       */
      deletionLog?: Pick<DeletionLogStore, "appendAndConfirm">;
      /**
       * The memory fence: ended sessions must have their increments captured
       * into the episodic digest before the upstream record is deleted.
       */
      memory?: {
        fenceDeletion(
          userId: string,
          arkSessionId: string,
          deletionRequestId?: string,
        ): Promise<"clear" | "capturing">;
      };
      workerId: string;
      now?: () => Date;
      batchSize?: number;
      alert?: (event: SessionDeletionAlert) => void;
    },
  ) {}

  async runOnce(): Promise<number> {
    const jobs = await this.dependencies.jobs.claim({
      workerId: this.dependencies.workerId,
      limit: this.dependencies.batchSize ?? 10,
      types: ["delete_session"],
    });
    for (const job of jobs) await this.process(job);
    return jobs.length;
  }

  private async process(job: SessionDeletionJob): Promise<void> {
    try {
      const payload = parsePayload(job);
      const ownerUserId = job.ownerUserId!;
      const session = await this.dependencies.repository.findDeleting(
        ownerUserId,
        payload.sessionId,
      );
      if (!session) {
        await this.dependencies.jobs.succeed(
          job.id,
          this.dependencies.workerId,
          job.leaseGeneration,
        );
        return;
      }

      if (session.arkSessionId.startsWith("pending:")) {
        if (session.createAttemptedAt !== null) {
          // Attempted/unknown creation must keep its local correlation until
          // the remote identity can be observed. A placeholder is no evidence.
          const now = (this.dependencies.now ?? (() => new Date()))();
          const deferred = await this.dependencies.jobs.deferSessionDeletion(
            job.id,
            this.dependencies.workerId,
            new Date(now.getTime() + SETTLEMENT_UNKNOWN_DEFER_MS),
            job.leaseGeneration,
          );
          if (!deferred) throw new SessionStillRunningError();
          return;
        }
        // Deletion admission fences new create attempts. No remote session
        // ever existed, so all upstream-only gates are vacuously complete.
        payload.completed.nonRunningObserved = true;
        payload.completed.settlementConfirmed = true;
        payload.completed.arkDeleted = true;
        await this.checkpoint(job, payload);
      }

      if (!payload.completed.nonRunningObserved) {
        if (!(await this.stillOwns(job))) return;
        let upstream;
        try {
          upstream = await this.dependencies.ark.getSession(
            session.arkSessionId,
            { correlationId: `worker:${job.id}:${job.attempts}:observe` },
          );
        } catch (error) {
          if (!isArkNotFound(error)) throw error;
          payload.completed.nonRunningObserved = true;
          payload.completed.arkDeleted = true;
          await this.checkpoint(job, payload);
        }
        if (upstream?.status === "running") {
          await this.dependencies.ark.submitEvent(
            session.arkSessionId,
            { type: "user.interrupt", data: {} },
            {
              correlationId: `worker:${job.id}:${job.attempts}:interrupt`,
              idempotencyKey: `session-delete-interrupt:${job.id}`,
            },
          );
          if (!payload.completed.interruptRequested) {
            payload.completed.interruptRequested = true;
            await this.checkpoint(job, payload);
          }
          try {
            upstream = await this.dependencies.ark.getSession(
              session.arkSessionId,
              { correlationId: `worker:${job.id}:${job.attempts}:observe` },
            );
          } catch (error) {
            if (!isArkNotFound(error)) throw error;
            upstream = undefined;
            payload.completed.arkDeleted = true;
          }
        }
        if (upstream && upstream.status === "running") {
          throw new SessionStillRunningError();
        }
        if (!payload.completed.nonRunningObserved) {
          payload.completed.nonRunningObserved = true;
          await this.checkpoint(job, payload);
        }
      }

      if (
        !payload.completed.settlementConfirmed &&
        !payload.completed.arkDeleted
      ) {
        // T03-C: only a confirmed settlement unlocks the irreversible steps.
        // "A check ran" is not evidence — the verdict decides, and neither a
        // transient `pending` nor an unprovable `unknown` consumes attempts.
        const verdict = await this.dependencies.settlement.verify(
          ownerUserId,
          payload.sessionId,
          { requestId: `worker:${job.id}:${job.attempts}:settle` },
        );
        if (verdict !== "confirmed") {
          const now = (this.dependencies.now ?? (() => new Date()))();
          const deferMs =
            verdict === "pending"
              ? SETTLEMENT_PENDING_DEFER_MS
              : SETTLEMENT_UNKNOWN_DEFER_MS;
          const deferred = await this.dependencies.jobs.deferSessionDeletion(
            job.id,
            this.dependencies.workerId,
            new Date(now.getTime() + deferMs),
            job.leaseGeneration,
          );
          if (!deferred) throw new SessionStillRunningError();
          return;
        }
        payload.completed.settlementConfirmed = true;
        await this.checkpoint(job, payload);
      }

      if (!payload.completed.arkDeleted) {
        // The irreversible upstream delete needs a current lease on top of
        // the settlement gate: a slow executor must not delete after a
        // takeover re-armed the job.
        if (!(await this.stillOwns(job))) return;
        // The irreversible delete needs its intent durably logged outside the
        // business database first: a backup restore must never resurrect
        // content the user asked to delete. An unconfirmed log defers the
        // job without consuming attempts.
        if (this.dependencies.deletionLog) {
          const logged = await this.dependencies.deletionLog.appendAndConfirm({
            kind: "session",
            deletionRequestId: job.id,
            userId: ownerUserId,
            sessionId: payload.sessionId,
            arkSessionId: session.arkSessionId,
            scope: "session_history_and_artifacts",
            requestedAt: (
              this.dependencies.now ?? (() => new Date())
            )().toISOString(),
          });
          if (!logged.confirmed) {
            const now = (this.dependencies.now ?? (() => new Date()))();
            const deferred = await this.dependencies.jobs.deferSessionDeletion(
              job.id,
              this.dependencies.workerId,
              new Date(now.getTime() + SETTLEMENT_PENDING_DEFER_MS),
              job.leaseGeneration,
            );
            if (!deferred) throw new SessionStillRunningError();
            return;
          }
        }
        // The memory fence re-runs until "clear": the capture edit run it
        // plans is applied by the memory loop in this same worker, so waiting
        // here is bounded by consolidation progress. Waiting defers the job
        // without consuming attempts; only a full budget of no progress (or a
        // lost lease) falls back to the attempt-consuming retry path.
        const fence = await this.dependencies.memory?.fenceDeletion(
          ownerUserId,
          session.arkSessionId,
          job.id,
        );
        if (fence === "capturing") {
          const now = (this.dependencies.now ?? (() => new Date()))();
          const started = payload.fenceWaitStartedAt ?? now.getTime();
          if (now.getTime() - started > FENCE_WAIT_BUDGET_MS)
            throw new SessionStillRunningError();
          payload.fenceWaitStartedAt = started;
          await this.checkpoint(job, payload);
          const deferred = await this.dependencies.jobs.deferSessionDeletion(
            job.id,
            this.dependencies.workerId,
            new Date(now.getTime() + FENCE_DEFER_MS),
            job.leaseGeneration,
          );
          if (!deferred) throw new SessionStillRunningError();
          return;
        }
        try {
          await this.dependencies.ark.deleteSession(session.arkSessionId, {
            correlationId: `worker:${job.id}:${job.attempts}:delete`,
            idempotencyKey: `session-delete:${job.id}`,
          });
        } catch (error) {
          if (!isArkNotFound(error)) throw error;
        }
        payload.completed.arkDeleted = true;
        await this.checkpoint(job, payload);
      }

      if (!payload.completed.artifactsOrphaned) {
        // Mark the bytes unreferenced; the drive GC owns the actual delete and
        // honours the retention window. Must run while the associations still
        // exist to identify which files this Session was the last to cover.
        await this.dependencies.repository.orphanDriveFiles(
          ownerUserId,
          payload.sessionId,
          (this.dependencies.now ?? (() => new Date()))(),
        );
        payload.completed.artifactsOrphaned = true;
        await this.checkpoint(job, payload);
      }

      const removal = await this.dependencies.repository.removeLocal(
        ownerUserId,
        payload.sessionId,
      );
      if (removal === "cleanup_pending") {
        throw new SessionStillRunningError();
      }
      if (removal === "cleanup_failed") {
        throw new SessionCleanupFailedError();
      }
      await this.dependencies.jobs.succeed(
        job.id,
        this.dependencies.workerId,
        job.leaseGeneration,
      );
    } catch (error) {
      const final = job.attempts >= job.maxAttempts;
      const errorCode = retryError(error);
      if (final && this.dependencies.alert) {
        const rawSessionId = job.payload.sessionId;
        const sessionId =
          typeof rawSessionId === "string" && rawSessionId.length > 0
            ? rawSessionId
            : job.id;
        this.dependencies.alert({
          jobType: "delete_session",
          jobId: job.id,
          userId: job.ownerUserId ?? null,
          sessionId,
          attempts: job.attempts + 1,
          maxAttempts: job.maxAttempts,
          errorCode,
        });
      }
      await this.dependencies.jobs.retry(
        job.id,
        this.dependencies.workerId,
        errorCode,
        final,
        job.leaseGeneration,
      );
    }
  }

  private checkpoint(
    job: SessionDeletionJob,
    payload: SessionDeletionPayload,
  ): PromiseLike<void> {
    return this.dependencies.jobs.updatePayload(
      job.id,
      this.dependencies.workerId,
      payload,
      job.leaseGeneration,
    );
  }

  /**
   * Ownership heartbeat before a remote side effect. Deletion steps can be
   * slow (memory fence, Ark calls); when the lease was taken over, this
   * execution must stop immediately and leave every state write to the new
   * owner — including its retry accounting.
   */
  private async stillOwns(job: SessionDeletionJob): Promise<boolean> {
    const extended = await this.dependencies.jobs.heartbeat({
      items: [{ id: job.id, leaseGeneration: job.leaseGeneration }],
      workerId: this.dependencies.workerId,
    });
    return extended === 1;
  }
}

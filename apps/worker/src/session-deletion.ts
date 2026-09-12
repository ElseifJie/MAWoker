import type { ArkGateway } from "@pwa/ark-client";

type CompletedSteps = {
  interruptRequested?: true;
  nonRunningObserved?: true;
  arkDeleted?: true;
  artifactsOrphaned?: true;
};

interface SessionDeletionPayload extends Record<string, unknown> {
  sessionId: string;
  completed: CompletedSteps;
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
  ): PromiseLike<void>;
  succeed(id: string, workerId: string): PromiseLike<void>;
  retry(
    id: string,
    workerId: string,
    error: string,
    final: boolean,
  ): PromiseLike<void>;
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
        status: "idle" | "running" | "rescheduled" | "terminated";
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
    "arkDeleted",
    "artifactsOrphaned",
  ]);
  const completedSteps = completed as Record<string, unknown>;
  if (
    Object.entries(completedSteps).some(
      ([key, value]) => !allowed.has(key) || value !== true,
    ) ||
    (completedSteps.arkDeleted === true &&
      completedSteps.nonRunningObserved !== true) ||
    (completedSteps.artifactsOrphaned === true &&
      completedSteps.arkDeleted !== true)
  ) {
    throw new InvalidSessionDeletionJobError();
  }
  return {
    sessionId,
    completed: { ...(completedSteps as CompletedSteps) },
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
        );
        return;
      }

      if (!payload.completed.nonRunningObserved) {
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

      if (!payload.completed.arkDeleted) {
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
      await this.dependencies.jobs.succeed(job.id, this.dependencies.workerId);
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
    );
  }
}

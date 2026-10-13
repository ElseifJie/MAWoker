export interface SessionReconciliationJob {
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

interface ReconciliationJobs {
  claim(input: {
    workerId: string;
    limit: number;
    types: ["reconcile_session"];
  }): PromiseLike<SessionReconciliationJob[]>;
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
}

interface ReconciliationService {
  deliverSubmission?(
    id: string,
    context: {
      userId: string;
      requestId: string;
      workerId: string;
      leaseGeneration: number;
      finalAttempt: boolean;
    },
  ): PromiseLike<void>;
  expireSubmissionBodies?(): PromiseLike<void>;
  reconcileCreate(
    id: string,
    context: { userId: string; requestId: string },
  ): PromiseLike<unknown>;
}

function parseCreatePayload(payload: Record<string, unknown>): string {
  if (
    payload.operation !== "create" ||
    typeof payload.sessionId !== "string" ||
    payload.sessionId.length === 0
  ) {
    throw new Error("Invalid Session reconciliation payload");
  }
  return payload.sessionId;
}

export class SessionReconciliationProcessor {
  constructor(
    private readonly dependencies: {
      jobs: ReconciliationJobs;
      service: ReconciliationService;
      workerId: string;
      batchSize?: number;
      artifactSyncEnabled?: boolean;
      delivery?: {
        syncArtifacts(
          id: string,
          context: {
            userId: string;
            workerId: string;
            leaseGeneration: number;
            requestId: string;
          },
        ): PromiseLike<void>;
      };
    },
  ) {}

  async runOnce(): Promise<number> {
    await this.dependencies.service.expireSubmissionBodies?.();
    const jobs = await this.dependencies.jobs.claim({
      workerId: this.dependencies.workerId,
      limit: this.dependencies.batchSize ?? 10,
      types: ["reconcile_session"],
    });
    for (const job of jobs) {
      await this.process(job);
    }
    return jobs.length;
  }

  private async process(job: SessionReconciliationJob): Promise<void> {
    try {
      if (job.type !== "reconcile_session") {
        throw new Error(`Unsupported reconciliation job type: ${job.type}`);
      }
      if (!job.ownerUserId) {
        throw new Error("Session reconciliation requires an owner");
      }
      if (job.payload.operation === "sync_artifacts") {
        if (this.dependencies.artifactSyncEnabled === false) {
          throw Object.assign(new Error("Artifact synchronization paused"), {
            code: "ARTIFACT_SYNC_PAUSED",
          });
        }
        if (!this.dependencies.delivery || job.payload.turnId !== job.id) {
          throw new Error("Invalid artifact synchronization job");
        }
        await this.dependencies.delivery.syncArtifacts(job.id, {
          userId: job.ownerUserId,
          workerId: this.dependencies.workerId,
          leaseGeneration: job.leaseGeneration,
          requestId: `worker:${job.id}:${job.attempts}`,
        });
      } else if (job.payload.operation === "deliver") {
        if (!this.dependencies.service.deliverSubmission)
          throw new Error("Delivery unavailable");
        await this.dependencies.service.deliverSubmission(job.id, {
          userId: job.ownerUserId,
          requestId: `worker:${job.id}:${job.attempts}`,
          workerId: this.dependencies.workerId,
          leaseGeneration: job.leaseGeneration,
          finalAttempt: job.attempts >= job.maxAttempts,
        });
      } else {
        const sessionId = parseCreatePayload(job.payload);
        await this.dependencies.service.reconcileCreate(sessionId, {
          userId: job.ownerUserId,
          requestId: `worker:${job.id}:${job.attempts}`,
        });
      }
      await this.dependencies.jobs.succeed(
        job.id,
        this.dependencies.workerId,
        job.leaseGeneration,
      );
    } catch (error) {
      await this.dependencies.jobs.retry(
        job.id,
        this.dependencies.workerId,
        typeof error === "object" && error !== null && "code" in error
          ? String(error.code)
          : "SESSION_JOB_FAILED",
        job.attempts >= job.maxAttempts,
        job.leaseGeneration,
      );
    }
  }
}

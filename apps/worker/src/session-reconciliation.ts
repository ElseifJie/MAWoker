export interface SessionReconciliationJob {
  id: string;
  ownerUserId: string | null;
  type:
    | "delete_session"
    | "delete_artifact"
    | "cleanup_artifact_object"
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

interface ReconciliationJobs {
  claim(input: {
    workerId: string;
    limit: number;
    types: ["reconcile_session"];
  }): PromiseLike<SessionReconciliationJob[]>;
  succeed(id: string, workerId: string): PromiseLike<void>;
  retry(
    id: string,
    workerId: string,
    error: string,
    final: boolean,
  ): PromiseLike<void>;
}

interface ReconciliationService {
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
    },
  ) {}

  async runOnce(): Promise<number> {
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
      const sessionId = parseCreatePayload(job.payload);
      await this.dependencies.service.reconcileCreate(sessionId, {
        userId: job.ownerUserId,
        requestId: `worker:${job.id}:${job.attempts}`,
      });
      await this.dependencies.jobs.succeed(job.id, this.dependencies.workerId);
    } catch (error) {
      await this.dependencies.jobs.retry(
        job.id,
        this.dependencies.workerId,
        error instanceof Error ? error.message : String(error),
        job.attempts >= job.maxAttempts,
      );
    }
  }
}

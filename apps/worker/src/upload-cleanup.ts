export interface UploadCleanupJob {
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

interface CleanupJobs {
  claim(input: {
    workerId: string;
    limit: number;
    types: ["cleanup_upload"];
  }): PromiseLike<UploadCleanupJob[]>;
  succeed(id: string, workerId: string): PromiseLike<void>;
  retry(
    id: string,
    workerId: string,
    error: string,
    final: boolean,
  ): PromiseLike<void>;
}

interface CleanupService {
  cleanupExpired(
    id: string,
    context: { userId: string; requestId: string },
  ): PromiseLike<void>;
}

function parsePayload(payload: Record<string, unknown>): string {
  if (typeof payload.uploadId !== "string" || payload.uploadId.length === 0) {
    throw new Error("Invalid upload cleanup payload");
  }
  return payload.uploadId;
}

export class UploadCleanupProcessor {
  constructor(
    private readonly dependencies: {
      jobs: CleanupJobs;
      service: CleanupService;
      workerId: string;
      batchSize?: number;
    },
  ) {}

  async runOnce(): Promise<number> {
    const jobs = await this.dependencies.jobs.claim({
      workerId: this.dependencies.workerId,
      limit: this.dependencies.batchSize ?? 10,
      types: ["cleanup_upload"],
    });
    for (const job of jobs) await this.process(job);
    return jobs.length;
  }

  private async process(job: UploadCleanupJob): Promise<void> {
    try {
      if (job.type !== "cleanup_upload") {
        throw new Error(`Unsupported cleanup job type: ${job.type}`);
      }
      if (!job.ownerUserId) {
        throw new Error("Upload cleanup requires an owner");
      }
      const uploadId = parsePayload(job.payload);
      await this.dependencies.service.cleanupExpired(uploadId, {
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

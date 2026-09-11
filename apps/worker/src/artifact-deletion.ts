export interface ArtifactDeletionJob {
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

interface ArtifactDeletionJobs {
  claim(input: {
    workerId: string;
    limit: number;
    types: ["delete_artifact"];
  }): PromiseLike<ArtifactDeletionJob[]>;
  succeed(id: string, workerId: string): PromiseLike<void>;
  retry(
    id: string,
    workerId: string,
    error: string,
    final: boolean,
  ): PromiseLike<void>;
}

interface ArtifactDeletionService {
  deleteStored(id: string, userId: string): PromiseLike<void>;
}

class InvalidArtifactDeletionJobError extends Error {}

function parsePayload(payload: Record<string, unknown>): string {
  if (
    typeof payload.artifactId !== "string" ||
    payload.artifactId.length === 0
  ) {
    throw new InvalidArtifactDeletionJobError();
  }
  return payload.artifactId;
}

function retryError(error: unknown): string {
  if (error instanceof InvalidArtifactDeletionJobError) {
    return "ARTIFACT_DELETE_INVALID_JOB";
  }
  if (
    error instanceof Error &&
    error.name === "StorageProviderError" &&
    "code" in error &&
    error.code === "STORAGE_UNAVAILABLE"
  ) {
    return "STORAGE_UNAVAILABLE";
  }
  return "ARTIFACT_DELETE_FAILED";
}

export interface ArtifactDeletionAlert {
  jobType: "delete_artifact";
  jobId: string;
  userId: string | null;
  artifactId: string;
  attempts: number;
  maxAttempts: number;
  errorCode: string;
}

export class ArtifactDeletionProcessor {
  constructor(
    private readonly dependencies: {
      jobs: ArtifactDeletionJobs;
      service: ArtifactDeletionService;
      workerId: string;
      batchSize?: number;
      alert?: (event: ArtifactDeletionAlert) => void;
    },
  ) {}

  async runOnce(): Promise<number> {
    const jobs = await this.dependencies.jobs.claim({
      workerId: this.dependencies.workerId,
      limit: this.dependencies.batchSize ?? 10,
      types: ["delete_artifact"],
    });
    for (const job of jobs) await this.process(job);
    return jobs.length;
  }

  private async process(job: ArtifactDeletionJob): Promise<void> {
    try {
      if (job.type !== "delete_artifact") {
        throw new InvalidArtifactDeletionJobError();
      }
      if (!job.ownerUserId) {
        throw new InvalidArtifactDeletionJobError();
      }
      await this.dependencies.service.deleteStored(
        parsePayload(job.payload),
        job.ownerUserId,
      );
      await this.dependencies.jobs.succeed(job.id, this.dependencies.workerId);
    } catch (error) {
      const final = job.attempts >= job.maxAttempts;
      const errorCode = retryError(error);
      if (final && this.dependencies.alert) {
        this.dependencies.alert({
          jobType: "delete_artifact",
          jobId: job.id,
          userId: job.ownerUserId ?? null,
          artifactId: job.id,
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
}

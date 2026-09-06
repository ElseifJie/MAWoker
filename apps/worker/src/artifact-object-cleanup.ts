import { posix } from "node:path";

export interface ArtifactObjectCleanupJob {
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

interface ArtifactObjectCleanupJobs {
  claim(input: {
    workerId: string;
    limit: number;
    types: ["cleanup_artifact_object"];
  }): PromiseLike<ArtifactObjectCleanupJob[]>;
  succeed(id: string, workerId: string): PromiseLike<void>;
  retry(
    id: string,
    workerId: string,
    error: string,
    final: boolean,
  ): PromiseLike<void>;
}

interface ArtifactObjectCleanupService {
  cleanupStoredObject(objectKey: string, userId: string): PromiseLike<void>;
}

class InvalidArtifactObjectCleanupJobError extends Error {}

function parseObjectKey(
  payload: Record<string, unknown>,
  ownerUserId: string,
): string {
  const objectKey = payload.objectKey;
  if (
    typeof objectKey !== "string" ||
    posix.normalize(objectKey) !== objectKey
  ) {
    throw new InvalidArtifactObjectCleanupJobError();
  }
  const segments = objectKey.split("/");
  if (
    segments.length < 6 ||
    segments[0] !== "tenants" ||
    segments[1] !== ownerUserId ||
    segments[2] !== "sessions" ||
    segments[3]!.length === 0 ||
    segments[4] !== "artifacts" ||
    segments.slice(5).some((segment) => segment.length === 0)
  ) {
    throw new InvalidArtifactObjectCleanupJobError();
  }
  return objectKey;
}

function retryError(error: unknown): string {
  if (error instanceof InvalidArtifactObjectCleanupJobError) {
    return "ARTIFACT_CLEANUP_INVALID_JOB";
  }
  if (
    error instanceof Error &&
    error.name === "StorageProviderError" &&
    "code" in error &&
    error.code === "STORAGE_UNAVAILABLE"
  ) {
    return "STORAGE_UNAVAILABLE";
  }
  return "ARTIFACT_CLEANUP_FAILED";
}

export class ArtifactObjectCleanupProcessor {
  constructor(
    private readonly dependencies: {
      jobs: ArtifactObjectCleanupJobs;
      service: ArtifactObjectCleanupService;
      workerId: string;
      batchSize?: number;
    },
  ) {}

  async runOnce(): Promise<number> {
    const jobs = await this.dependencies.jobs.claim({
      workerId: this.dependencies.workerId,
      limit: this.dependencies.batchSize ?? 10,
      types: ["cleanup_artifact_object"],
    });
    for (const job of jobs) await this.process(job);
    return jobs.length;
  }

  private async process(job: ArtifactObjectCleanupJob): Promise<void> {
    try {
      if (job.type !== "cleanup_artifact_object" || !job.ownerUserId) {
        throw new InvalidArtifactObjectCleanupJobError();
      }
      await this.dependencies.service.cleanupStoredObject(
        parseObjectKey(job.payload, job.ownerUserId),
        job.ownerUserId,
      );
      await this.dependencies.jobs.succeed(job.id, this.dependencies.workerId);
    } catch (error) {
      await this.dependencies.jobs.retry(
        job.id,
        this.dependencies.workerId,
        retryError(error),
        job.attempts >= job.maxAttempts,
      );
    }
  }
}

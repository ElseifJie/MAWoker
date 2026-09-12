import { posix } from "node:path";

export interface ArtifactObjectCleanupJob {
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

interface ArtifactObjectCleanupJobs {
  claim(input: {
    workerId: string;
    limit: number;
    types: ["cleanup_artifact_object"];
    now?: Date;
  }): PromiseLike<ArtifactObjectCleanupJob[]>;
  deferArtifactCleanup(
    id: string,
    workerId: string,
    cleanupGeneration: number,
  ): PromiseLike<boolean>;
  succeedArtifactCleanup(
    id: string,
    workerId: string,
    cleanupGeneration: number,
  ): PromiseLike<boolean>;
  retry(
    id: string,
    workerId: string,
    error: string,
    final: boolean,
  ): PromiseLike<void>;
  retryArtifactCleanup(
    id: string,
    workerId: string,
    cleanupGeneration: number,
    error: string,
    final: boolean,
  ): PromiseLike<boolean>;
}

interface ArtifactObjectCleanupService {
  cleanupStoredObject(objectKey: string, userId: string): PromiseLike<void>;
}

class InvalidArtifactObjectCleanupJobError extends Error {}

function parsePayload(
  payload: Record<string, unknown>,
  ownerUserId: string,
): {
  objectKey: string;
  cleanupGeneration: number;
  uploadInProgressUntil?: Date;
} {
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
  const uploadInProgressUntil = payload.uploadInProgressUntil;
  if (
    uploadInProgressUntil !== undefined &&
    (typeof uploadInProgressUntil !== "string" ||
      !Number.isFinite(Date.parse(uploadInProgressUntil)))
  ) {
    throw new InvalidArtifactObjectCleanupJobError();
  }
  const cleanupGeneration = payload.cleanupGeneration ?? 0;
  if (
    typeof cleanupGeneration !== "number" ||
    !Number.isSafeInteger(cleanupGeneration) ||
    cleanupGeneration < 0
  ) {
    throw new InvalidArtifactObjectCleanupJobError();
  }
  return {
    objectKey,
    cleanupGeneration,
    ...(uploadInProgressUntil === undefined
      ? {}
      : { uploadInProgressUntil: new Date(uploadInProgressUntil) }),
  };
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
      now?: () => Date;
    },
  ) {}

  async runOnce(): Promise<number> {
    const now = this.dependencies.now?.();
    const jobs = await this.dependencies.jobs.claim({
      workerId: this.dependencies.workerId,
      limit: this.dependencies.batchSize ?? 10,
      types: ["cleanup_artifact_object"],
      ...(now ? { now } : {}),
    });
    for (const job of jobs) await this.process(job);
    return jobs.length;
  }

  private async process(job: ArtifactObjectCleanupJob): Promise<void> {
    let cleanupGeneration: number | undefined;
    try {
      if (job.type !== "cleanup_artifact_object" || !job.ownerUserId) {
        throw new InvalidArtifactObjectCleanupJobError();
      }
      const payload = parsePayload(job.payload, job.ownerUserId);
      cleanupGeneration = payload.cleanupGeneration;
      await this.dependencies.service.cleanupStoredObject(
        payload.objectKey,
        job.ownerUserId,
      );
      if (
        payload.uploadInProgressUntil &&
        new Date(job.lockedAt).getTime() <
          payload.uploadInProgressUntil.getTime()
      ) {
        await this.dependencies.jobs.deferArtifactCleanup(
          job.id,
          this.dependencies.workerId,
          payload.cleanupGeneration,
        );
        return;
      }
      await this.dependencies.jobs.succeedArtifactCleanup(
        job.id,
        this.dependencies.workerId,
        payload.cleanupGeneration,
      );
    } catch (error) {
      const code = retryError(error);
      if (cleanupGeneration === undefined) {
        await this.dependencies.jobs.retry(
          job.id,
          this.dependencies.workerId,
          code,
          job.attempts >= job.maxAttempts,
        );
      } else {
        await this.dependencies.jobs.retryArtifactCleanup(
          job.id,
          this.dependencies.workerId,
          cleanupGeneration,
          code,
          job.attempts >= job.maxAttempts,
        );
      }
    }
  }
}

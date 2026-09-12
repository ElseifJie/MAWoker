export interface DriveObjectCleanupJob {
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

interface DriveObjectCleanupJobs {
  claim(input: {
    workerId: string;
    limit: number;
    types: ["cleanup_drive_object"];
    now?: Date;
  }): PromiseLike<DriveObjectCleanupJob[]>;
  deferDriveCleanup(
    id: string,
    workerId: string,
    cleanupGeneration: number,
  ): PromiseLike<boolean>;
  succeedDriveCleanup(
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
  retryDriveCleanup(
    id: string,
    workerId: string,
    cleanupGeneration: number,
    error: string,
    final: boolean,
  ): PromiseLike<boolean>;
}

interface DriveObjectCleanupService {
  deleteStored(id: string, ownerUserId: string): PromiseLike<void>;
}

class InvalidDriveObjectCleanupJobError extends Error {}

/**
 * The payload names the drive row, never an object key. The service resolves the
 * key from the database, so a tampered job cannot point deletion at an arbitrary
 * object — the only thing it can address is a row the owner already owns.
 */
function parsePayload(payload: Record<string, unknown>): {
  driveFileId: string;
  cleanupGeneration: number;
  uploadInProgressUntil?: Date;
} {
  const driveFileId = payload.driveFileId;
  if (typeof driveFileId !== "string" || driveFileId.length === 0) {
    throw new InvalidDriveObjectCleanupJobError();
  }
  const uploadInProgressUntil = payload.uploadInProgressUntil;
  if (
    uploadInProgressUntil !== undefined &&
    (typeof uploadInProgressUntil !== "string" ||
      !Number.isFinite(Date.parse(uploadInProgressUntil)))
  ) {
    throw new InvalidDriveObjectCleanupJobError();
  }
  const cleanupGeneration = payload.cleanupGeneration ?? 0;
  if (
    typeof cleanupGeneration !== "number" ||
    !Number.isSafeInteger(cleanupGeneration) ||
    cleanupGeneration < 0
  ) {
    throw new InvalidDriveObjectCleanupJobError();
  }
  return {
    driveFileId,
    cleanupGeneration,
    ...(uploadInProgressUntil === undefined
      ? {}
      : { uploadInProgressUntil: new Date(uploadInProgressUntil) }),
  };
}

function retryError(error: unknown): string {
  if (error instanceof InvalidDriveObjectCleanupJobError) {
    return "DRIVE_CLEANUP_INVALID_JOB";
  }
  if (
    error instanceof Error &&
    error.name === "StorageProviderError" &&
    "code" in error &&
    error.code === "STORAGE_UNAVAILABLE"
  ) {
    return "STORAGE_UNAVAILABLE";
  }
  return "DRIVE_CLEANUP_FAILED";
}

export class DriveObjectCleanupProcessor {
  constructor(
    private readonly dependencies: {
      jobs: DriveObjectCleanupJobs;
      service: DriveObjectCleanupService;
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
      types: ["cleanup_drive_object"],
      ...(now ? { now } : {}),
    });
    for (const job of jobs) await this.process(job);
    return jobs.length;
  }

  private async process(job: DriveObjectCleanupJob): Promise<void> {
    let cleanupGeneration: number | undefined;
    try {
      if (job.type !== "cleanup_drive_object" || !job.ownerUserId) {
        throw new InvalidDriveObjectCleanupJobError();
      }
      const payload = parsePayload(job.payload);
      cleanupGeneration = payload.cleanupGeneration;
      await this.dependencies.service.deleteStored(
        payload.driveFileId,
        job.ownerUserId,
      );
      // A staged write is still in flight: reschedule past its lease instead of
      // deleting a partial object the writer is about to finish.
      if (
        payload.uploadInProgressUntil &&
        new Date(job.lockedAt).getTime() <
          payload.uploadInProgressUntil.getTime()
      ) {
        await this.dependencies.jobs.deferDriveCleanup(
          job.id,
          this.dependencies.workerId,
          payload.cleanupGeneration,
        );
        return;
      }
      await this.dependencies.jobs.succeedDriveCleanup(
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
        await this.dependencies.jobs.retryDriveCleanup(
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

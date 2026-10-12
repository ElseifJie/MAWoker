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

/**
 * Live state of the drive row, re-read immediately before destructive work. The
 * payload snapshot can be stale: a commit may have promoted the row after this
 * job was claimed, and only the row's own lease says whether a staged write is
 * still in flight. `orphanedAt` separates the two committed-row cases: an
 * orphaned row is the GC's reclamation target, a non-orphaned row is live.
 */
export interface DriveCleanupGuard {
  ownerUserId: string;
  deletionState: "pending" | "none" | "deletion_failed" | "deleted";
  writeLeaseUntil: Date | null;
  orphanedAt: Date | null;
}

interface DriveObjectCleanupGuards {
  findDriveCleanupGuard(
    driveFileId: string,
  ): PromiseLike<DriveCleanupGuard | undefined>;
  /** Re-reads the live job claim; a mismatch means this execution lost it. */
  findCleanupJobClaim(
    jobId: string,
    ownerUserId: string,
  ): PromiseLike<
    { generation: number; lockedBy: string | null; type: string } | undefined
  >;
}

class InvalidDriveObjectCleanupJobError extends Error {}
class DriveObjectCleanupClaimLostError extends Error {
  constructor() {
    super("Drive cleanup job claim lost");
  }
}

function assertDriveCleanupClaim(result: boolean): void {
  if (!result) throw new DriveObjectCleanupClaimLostError();
}

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
      guards: DriveObjectCleanupGuards;
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
      const now = this.dependencies.now?.() ?? new Date();
      // Re-read the live row BEFORE destroying bytes. The pre-claim snapshot in
      // the payload cannot prove the object is still safe to delete: a commit
      // may have promoted the row after this job was claimed.
      const guard = await this.dependencies.guards.findDriveCleanupGuard(
        payload.driveFileId,
      );
      if (!guard || guard.ownerUserId !== job.ownerUserId) {
        throw new InvalidDriveObjectCleanupJobError();
      }
      // A staged write is still in flight: reschedule past its lease instead of
      // deleting a partial object the writer is about to finish. The driver may
      // hand the timestamp back as a string, so normalize before comparing.
      const leaseUntil = guard.writeLeaseUntil
        ? new Date(guard.writeLeaseUntil)
        : null;
      if (leaseUntil && leaseUntil.getTime() > now.getTime()) {
        assertDriveCleanupClaim(
          await this.dependencies.jobs.deferDriveCleanup(
            job.id,
            this.dependencies.workerId,
            payload.cleanupGeneration,
          ),
        );
        return;
      }
      // Lease expiry only proves the writer stopped reporting progress; it
      // cannot prove whether the remote write committed. Keep the bytes and
      // finish this exact cleanup generation as an unverified outcome.
      if (guard.deletionState === "pending") {
        assertDriveCleanupClaim(
          await this.dependencies.jobs.retryDriveCleanup(
            job.id,
            this.dependencies.workerId,
            payload.cleanupGeneration,
            "DRIVE_CLEANUP_OBJECT_UNVERIFIED",
            true,
          ),
        );
        return;
      }
      // The row was committed without being orphaned after this intent was
      // created: the object is live, so retire the stale intent as a no-op.
      // An orphaned committed row, by contrast, is exactly what the GC
      // enqueued this intent to reclaim.
      if (guard.deletionState === "none" && guard.orphanedAt === null) {
        assertDriveCleanupClaim(
          await this.dependencies.jobs.succeedDriveCleanup(
            job.id,
            this.dependencies.workerId,
            payload.cleanupGeneration,
          ),
        );
        return;
      }
      // Ownership re-check immediately before the destructive call: if the
      // job was re-armed (generation moved) or re-locked to another worker
      // after this claim, this execution must not touch bytes. Stop without
      // writing status — the current claim owner owns the outcome.
      const claim = await this.dependencies.guards.findCleanupJobClaim(
        job.id,
        job.ownerUserId,
      );
      if (
        !claim ||
        claim.type !== "cleanup_drive_object" ||
        claim.generation !== payload.cleanupGeneration ||
        claim.lockedBy !== this.dependencies.workerId
      ) {
        return;
      }
      await this.dependencies.service.deleteStored(
        payload.driveFileId,
        job.ownerUserId,
      );
      assertDriveCleanupClaim(
        await this.dependencies.jobs.succeedDriveCleanup(
          job.id,
          this.dependencies.workerId,
          payload.cleanupGeneration,
        ),
      );
    } catch (error) {
      if (error instanceof DriveObjectCleanupClaimLostError) throw error;
      const code = retryError(error);
      if (cleanupGeneration === undefined) {
        await this.dependencies.jobs.retry(
          job.id,
          this.dependencies.workerId,
          code,
          job.attempts >= job.maxAttempts,
        );
      } else {
        assertDriveCleanupClaim(
          await this.dependencies.jobs.retryDriveCleanup(
            job.id,
            this.dependencies.workerId,
            cleanupGeneration,
            code,
            job.attempts >= job.maxAttempts,
          ),
        );
      }
    }
  }
}

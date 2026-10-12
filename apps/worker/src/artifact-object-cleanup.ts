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
  leaseGeneration: number;
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
    leaseGeneration: number,
  ): PromiseLike<boolean>;
  succeedArtifactCleanup(
    id: string,
    workerId: string,
    cleanupGeneration: number,
    leaseGeneration: number,
  ): PromiseLike<boolean>;
  retry(
    id: string,
    workerId: string,
    error: string,
    final: boolean,
    leaseGeneration: number,
  ): PromiseLike<void>;
  retryArtifactCleanup(
    id: string,
    workerId: string,
    cleanupGeneration: number,
    leaseGeneration: number,
    error: string,
    final: boolean,
  ): PromiseLike<boolean>;
}

interface ArtifactObjectCleanupService {
  cleanupStoredObject(objectKey: string, userId: string): PromiseLike<void>;
}

/**
 * Live state of the drive row that owns the object key, re-read before the
 * DELETE. A tombstoned row proves the bytes are unreferenced; a missing row or
 * any live state leaves the remote write outcome unverified.
 */
export interface ArtifactCleanupGuard {
  ownerUserId: string;
  deletionState: "pending" | "none" | "deletion_failed" | "deleted";
  writeLeaseUntil: Date | null;
  orphanedAt: Date | null;
}

interface ArtifactObjectCleanupGuards {
  findObjectCleanupGuard(
    objectKey: string,
  ): PromiseLike<ArtifactCleanupGuard | undefined>;
  /** Re-reads the live job claim; a mismatch means this execution lost it. */
  findCleanupJobClaim(
    jobId: string,
    ownerUserId: string,
  ): PromiseLike<
    | {
        generation: number;
        lockedBy: string | null;
        type: string;
        leaseGeneration: number;
      }
    | undefined
  >;
}

class InvalidArtifactObjectCleanupJobError extends Error {}
class ArtifactObjectCleanupClaimLostError extends Error {
  constructor() {
    super("Artifact cleanup job claim lost");
  }
}

function assertArtifactCleanupClaim(result: boolean): void {
  if (!result) throw new ArtifactObjectCleanupClaimLostError();
}

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
      guards: ArtifactObjectCleanupGuards;
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
      const now = this.dependencies.now?.() ?? new Date();
      // Re-read the live row BEFORE destroying bytes. Only a tombstoned row
      // proves the bytes are unreferenced.
      const guard = await this.dependencies.guards.findObjectCleanupGuard(
        payload.objectKey,
      );
      if (guard && guard.ownerUserId !== job.ownerUserId) {
        throw new InvalidArtifactObjectCleanupJobError();
      }
      // A staged write is still in flight: reschedule past its lease instead of
      // deleting a partial object the writer is about to finish. Legacy jobs
      // have no guard row, so only they fall back to the payload lease.
      const leaseUntil = guard
        ? guard.writeLeaseUntil
          ? new Date(guard.writeLeaseUntil)
          : null
        : (payload.uploadInProgressUntil ?? null);
      if (leaseUntil && leaseUntil.getTime() > now.getTime()) {
        assertArtifactCleanupClaim(
          await this.dependencies.jobs.deferArtifactCleanup(
            job.id,
            this.dependencies.workerId,
            payload.cleanupGeneration,
            job.leaseGeneration,
          ),
        );
        return;
      }
      // A legacy job without a guard row has no durable proof that its write
      // Lease expiry (or a missing lease) leaves the remote outcome
      // unknown, so preserve the bytes and finish only this job generation.
      if (!guard) {
        assertArtifactCleanupClaim(
          await this.dependencies.jobs.retryArtifactCleanup(
            job.id,
            this.dependencies.workerId,
            payload.cleanupGeneration,
            job.leaseGeneration,
            "ARTIFACT_CLEANUP_OBJECT_UNVERIFIED",
            true,
          ),
        );
        return;
      }
      // A tombstoned row's bytes are safely reaped. `pending` means a staged
      // write with an unknown remote outcome and `none`/`deletion_failed` mean
      // the object may be live: finish the fenced job instead of guessing.
      if (guard.deletionState !== "deleted") {
        assertArtifactCleanupClaim(
          await this.dependencies.jobs.retryArtifactCleanup(
            job.id,
            this.dependencies.workerId,
            payload.cleanupGeneration,
            job.leaseGeneration,
            "ARTIFACT_CLEANUP_OBJECT_UNVERIFIED",
            true,
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
        claim.type !== "cleanup_artifact_object" ||
        claim.generation !== payload.cleanupGeneration ||
        claim.lockedBy !== this.dependencies.workerId ||
        claim.leaseGeneration !== job.leaseGeneration
      ) {
        return;
      }
      await this.dependencies.service.cleanupStoredObject(
        payload.objectKey,
        job.ownerUserId,
      );
      assertArtifactCleanupClaim(
        await this.dependencies.jobs.succeedArtifactCleanup(
          job.id,
          this.dependencies.workerId,
          payload.cleanupGeneration,
          job.leaseGeneration,
        ),
      );
    } catch (error) {
      if (error instanceof ArtifactObjectCleanupClaimLostError) throw error;
      const code = retryError(error);
      if (cleanupGeneration === undefined) {
        await this.dependencies.jobs.retry(
          job.id,
          this.dependencies.workerId,
          code,
          job.attempts >= job.maxAttempts,
          job.leaseGeneration,
        );
      } else {
        assertArtifactCleanupClaim(
          await this.dependencies.jobs.retryArtifactCleanup(
            job.id,
            this.dependencies.workerId,
            cleanupGeneration,
            job.leaseGeneration,
            code,
            job.attempts >= job.maxAttempts,
          ),
        );
      }
    }
  }
}

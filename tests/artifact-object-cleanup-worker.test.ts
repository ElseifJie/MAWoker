import { describe, expect, it, vi } from "vitest";
import {
  ArtifactObjectCleanupProcessor,
  type ArtifactObjectCleanupJob,
} from "../apps/worker/src/artifact-object-cleanup.js";

const jobId = "00000000-0000-4000-8000-000000000001";
const ownerUserId = "00000000-0000-4000-8000-000000000002";
const objectKey =
  "tenants/00000000-0000-4000-8000-000000000002/sessions/session/artifacts/file/version";
const timestamp = new Date("2026-09-06T00:00:00.000Z");

function job(
  overrides: Partial<ArtifactObjectCleanupJob> = {},
): ArtifactObjectCleanupJob {
  return {
    id: jobId,
    ownerUserId,
    type: "cleanup_artifact_object",
    status: "running",
    priority: 90,
    payload: { objectKey },
    attempts: 1,
    maxAttempts: 10,
    runAfter: timestamp,
    lockedAt: timestamp,
    lockedBy: "worker-1",
    leaseGeneration: 1,
    createdAt: timestamp,
    ...overrides,
  };
}

function guards(
  guard: Record<string, unknown> | undefined,
  claim: Record<string, unknown> | undefined = {
    generation: 0,
    lockedBy: "worker-1",
    leaseGeneration: 1,
    type: "cleanup_artifact_object",
  },
) {
  return {
    findObjectCleanupGuard: vi.fn(async () => guard),
    findCleanupJobClaim: vi.fn(async () => claim),
  };
}

describe("ArtifactObjectCleanupProcessor", () => {
  it("fails closed for a legacy object with no fallback lease", async () => {
    const jobs = {
      claim: vi.fn(async () => [job()]),
      deferArtifactCleanup: vi.fn(async () => true),
      succeedArtifactCleanup: vi.fn(async () => true),
      retry: vi.fn(async () => undefined),
      retryArtifactCleanup: vi.fn(async () => true),
    };
    const service = {
      cleanupStoredObject: vi.fn(async () => undefined),
    };
    const processor = new ArtifactObjectCleanupProcessor({
      jobs,
      guards: guards(undefined),
      service,
      workerId: "worker-1",
    });

    await expect(processor.runOnce()).resolves.toBe(1);
    expect(jobs.claim).toHaveBeenCalledWith({
      workerId: "worker-1",
      limit: 10,
      types: ["cleanup_artifact_object"],
    });
    expect(service.cleanupStoredObject).not.toHaveBeenCalled();
    expect(jobs.succeedArtifactCleanup).not.toHaveBeenCalled();
    expect(jobs.retryArtifactCleanup).toHaveBeenCalledWith(
      jobId,
      "worker-1",
      0,
      1,
      "ARTIFACT_CLEANUP_OBJECT_UNVERIFIED",
      true,
    );
  });

  it("retries cleanup failures with stable errors and later recovers", async () => {
    const jobs = {
      claim: vi
        .fn()
        .mockResolvedValueOnce([job()])
        .mockResolvedValueOnce([job({ attempts: 2 })]),
      deferArtifactCleanup: vi.fn(async () => true),
      succeedArtifactCleanup: vi.fn(async () => true),
      retry: vi.fn(async () => undefined),
      retryArtifactCleanup: vi.fn(async () => true),
    };
    const service = {
      cleanupStoredObject: vi
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error("private key leaked"), {
            name: "StorageProviderError",
            code: "STORAGE_UNAVAILABLE",
          }),
        )
        .mockResolvedValueOnce(undefined),
    };
    const processor = new ArtifactObjectCleanupProcessor({
      jobs,
      guards: guards({
        ownerUserId,
        deletionState: "deleted",
        writeLeaseUntil: null,
        orphanedAt: null,
      }),
      service,
      workerId: "worker-1",
    });

    await processor.runOnce();
    await processor.runOnce();

    expect(jobs.retryArtifactCleanup).toHaveBeenCalledWith(
      jobId,
      "worker-1",
      0,
      1,
      "STORAGE_UNAVAILABLE",
      false,
    );
    expect(jobs.succeedArtifactCleanup).toHaveBeenCalledWith(
      jobId,
      "worker-1",
      0,
      1,
    );
    expect(JSON.stringify(jobs.retryArtifactCleanup.mock.calls)).not.toContain(
      objectKey,
    );
  });

  it("rejects malformed jobs without exposing or deleting arbitrary keys", async () => {
    const jobs = {
      claim: vi.fn(async () => [job({ payload: { objectKey: "../private" } })]),
      deferArtifactCleanup: vi.fn(async () => true),
      succeedArtifactCleanup: vi.fn(async () => true),
      retry: vi.fn(async () => undefined),
      retryArtifactCleanup: vi.fn(async () => true),
    };
    const service = {
      cleanupStoredObject: vi.fn(async () => undefined),
    };
    const processor = new ArtifactObjectCleanupProcessor({
      jobs,
      guards: guards(undefined),
      service,
      workerId: "worker-1",
    });

    await processor.runOnce();

    expect(service.cleanupStoredObject).not.toHaveBeenCalled();
    expect(jobs.retry).toHaveBeenCalledWith(
      jobId,
      "worker-1",
      "ARTIFACT_CLEANUP_INVALID_JOB",
      false,
      1,
    );
  });

  it("rearms cleanup while the live write lease is still active", async () => {
    const jobs = {
      claim: vi.fn(async () => [job()]),
      deferArtifactCleanup: vi.fn(async () => true),
      succeedArtifactCleanup: vi.fn(async () => true),
      retry: vi.fn(async () => undefined),
      retryArtifactCleanup: vi.fn(async () => true),
    };
    const service = {
      cleanupStoredObject: vi.fn(async () => undefined),
    };
    const processor = new ArtifactObjectCleanupProcessor({
      jobs,
      guards: guards({
        ownerUserId,
        deletionState: "pending",
        writeLeaseUntil: new Date("2026-09-06T00:05:00.000Z"),
        orphanedAt: null,
      }),
      service,
      workerId: "worker-1",
      now: () => new Date("2026-09-06T00:00:00.000Z"),
    });

    await processor.runOnce();

    // The lease check reads the live row BEFORE the DELETE, so a claimed job
    // cannot destroy an object whose writer is still in flight.
    expect(service.cleanupStoredObject).not.toHaveBeenCalled();
    expect(jobs.deferArtifactCleanup).toHaveBeenCalledWith(
      jobId,
      "worker-1",
      0,
      1,
    );
    expect(jobs.succeedArtifactCleanup).not.toHaveBeenCalled();
  });

  it("defers a legacy cleanup while its fallback lease is still active", async () => {
    const jobs = {
      claim: vi.fn(async () => [
        job({
          payload: {
            objectKey,
            uploadInProgressUntil: "2026-09-06T00:05:00.000Z",
          },
        }),
      ]),
      deferArtifactCleanup: vi.fn(async () => true),
      succeedArtifactCleanup: vi.fn(async () => true),
      retry: vi.fn(async () => undefined),
      retryArtifactCleanup: vi.fn(async () => true),
    };
    const service = {
      cleanupStoredObject: vi.fn(async () => undefined),
    };
    const processor = new ArtifactObjectCleanupProcessor({
      jobs,
      guards: guards(undefined),
      service,
      workerId: "worker-1",
      now: () => new Date("2026-09-06T00:00:00.000Z"),
    });

    await processor.runOnce();

    expect(service.cleanupStoredObject).not.toHaveBeenCalled();
    expect(jobs.deferArtifactCleanup).toHaveBeenCalledWith(
      jobId,
      "worker-1",
      0,
      1,
    );
    expect(jobs.retryArtifactCleanup).not.toHaveBeenCalled();
    expect(jobs.succeedArtifactCleanup).not.toHaveBeenCalled();
  });

  it("fails closed for a legacy cleanup with an expired fallback lease", async () => {
    const jobs = {
      claim: vi.fn(async () => [
        job({
          payload: {
            objectKey,
            uploadInProgressUntil: "2026-09-05T23:59:00.000Z",
          },
        }),
      ]),
      deferArtifactCleanup: vi.fn(async () => true),
      succeedArtifactCleanup: vi.fn(async () => true),
      retry: vi.fn(async () => undefined),
      retryArtifactCleanup: vi.fn(async () => true),
    };
    const service = {
      cleanupStoredObject: vi.fn(async () => undefined),
    };
    const processor = new ArtifactObjectCleanupProcessor({
      jobs,
      guards: guards(undefined),
      service,
      workerId: "worker-1",
      now: () => new Date("2026-09-06T00:00:00.000Z"),
    });

    await processor.runOnce();

    expect(service.cleanupStoredObject).not.toHaveBeenCalled();
    expect(jobs.deferArtifactCleanup).not.toHaveBeenCalled();
    expect(jobs.retryArtifactCleanup).toHaveBeenCalledWith(
      jobId,
      "worker-1",
      0,
      1,
      "ARTIFACT_CLEANUP_OBJECT_UNVERIFIED",
      true,
    );
    expect(jobs.succeedArtifactCleanup).not.toHaveBeenCalled();
  });

  it("reaps the bytes once the drive row is tombstoned", async () => {
    const jobs = {
      claim: vi.fn(async () => [job()]),
      deferArtifactCleanup: vi.fn(async () => true),
      succeedArtifactCleanup: vi.fn(async () => true),
      retry: vi.fn(async () => undefined),
      retryArtifactCleanup: vi.fn(async () => true),
    };
    const service = {
      cleanupStoredObject: vi.fn(async () => undefined),
    };
    const processor = new ArtifactObjectCleanupProcessor({
      jobs,
      guards: guards({
        ownerUserId,
        deletionState: "deleted",
        writeLeaseUntil: null,
        orphanedAt: null,
      }),
      service,
      workerId: "worker-1",
    });

    await processor.runOnce();

    expect(service.cleanupStoredObject).toHaveBeenCalledWith(
      objectKey,
      ownerUserId,
    );
    expect(jobs.succeedArtifactCleanup).toHaveBeenCalledWith(
      jobId,
      "worker-1",
      0,
      1,
    );
  });

  it("parks cleanup for a row it cannot prove is unreferenced", async () => {
    const jobs = {
      claim: vi.fn(async () => [job()]),
      deferArtifactCleanup: vi.fn(async () => true),
      succeedArtifactCleanup: vi.fn(async () => true),
      retry: vi.fn(async () => undefined),
      retryArtifactCleanup: vi.fn(async () => true),
    };
    const service = {
      cleanupStoredObject: vi.fn(async () => undefined),
    };
    const processor = new ArtifactObjectCleanupProcessor({
      jobs,
      guards: guards({
        ownerUserId,
        deletionState: "none",
        writeLeaseUntil: null,
        orphanedAt: null,
      }),
      service,
      workerId: "worker-1",
    });

    await processor.runOnce();

    expect(service.cleanupStoredObject).not.toHaveBeenCalled();
    expect(jobs.succeedArtifactCleanup).not.toHaveBeenCalled();
    expect(jobs.retryArtifactCleanup).toHaveBeenCalledWith(
      jobId,
      "worker-1",
      0,
      1,
      "ARTIFACT_CLEANUP_OBJECT_UNVERIFIED",
      true,
    );
    expect(jobs.retry).not.toHaveBeenCalled();
  });

  it("reaps a retired drive key whose row was switched away", async () => {
    const jobs = {
      claim: vi.fn(async () => [
        job({
          payload: {
            objectKey:
              "tenants/00000000-0000-4000-8000-000000000002/drive/artifact/00000000-0000-4000-8000-00000000000a/r00000000-0000-4000-8000-00000000000b/report.txt",
            retiredBySwitch: true,
          },
        }),
      ]),
      deferArtifactCleanup: vi.fn(async () => true),
      succeedArtifactCleanup: vi.fn(async () => true),
      retry: vi.fn(async () => undefined),
      retryArtifactCleanup: vi.fn(async () => true),
    };
    const service = {
      cleanupStoredObject: vi.fn(async () => undefined),
    };
    const processor = new ArtifactObjectCleanupProcessor({
      jobs,
      guards: guards(undefined),
      service,
      workerId: "worker-1",
    });

    await processor.runOnce();

    // A retired drive key has no row behind it: ownerless bytes, safe to
    // delete through the legacy key-addressed drain.
    expect(service.cleanupStoredObject).toHaveBeenCalledTimes(1);
    expect(jobs.succeedArtifactCleanup).toHaveBeenCalled();
  });

  it("keeps a legacy no-row drive key fenced unless the switch retired it", async () => {
    const jobs = {
      claim: vi.fn(async () => [
        job({
          payload: {
            objectKey:
              "tenants/00000000-0000-4000-8000-000000000002/drive/artifact/00000000-0000-4000-8000-00000000000a/r00000000-0000-4000-8000-00000000000b/report.txt",
          },
        }),
      ]),
      deferArtifactCleanup: vi.fn(async () => true),
      succeedArtifactCleanup: vi.fn(async () => true),
      retry: vi.fn(async () => undefined),
      retryArtifactCleanup: vi.fn(async () => true),
    };
    const service = {
      cleanupStoredObject: vi.fn(async () => undefined),
    };
    const processor = new ArtifactObjectCleanupProcessor({
      jobs,
      guards: guards(undefined),
      service,
      workerId: "worker-1",
    });

    await processor.runOnce();

    // Without the switch's explicit retirement marker, a missing row is an
    // unverifiable outcome: preserve the bytes (Task 02 fail-closed).
    expect(service.cleanupStoredObject).not.toHaveBeenCalled();
    expect(jobs.retryArtifactCleanup).toHaveBeenCalledWith(
      jobId,
      "worker-1",
      0,
      1,
      "ARTIFACT_CLEANUP_OBJECT_UNVERIFIED",
      true,
    );
  });

  it("still rejects foreign-tenant and malformed drive keys", async () => {
    const jobs = {
      claim: vi.fn(async () => [
        job({
          payload: {
            objectKey:
              "tenants/00000000-0000-4000-8000-000000000099/drive/artifact/x/report.txt",
          },
        }),
      ]),
      deferArtifactCleanup: vi.fn(async () => true),
      succeedArtifactCleanup: vi.fn(async () => true),
      retry: vi.fn(async () => undefined),
      retryArtifactCleanup: vi.fn(async () => true),
    };
    const service = {
      cleanupStoredObject: vi.fn(async () => undefined),
    };
    const processor = new ArtifactObjectCleanupProcessor({
      jobs,
      guards: guards(undefined),
      service,
      workerId: "worker-1",
    });

    await processor.runOnce();

    expect(service.cleanupStoredObject).not.toHaveBeenCalled();
    expect(jobs.retry).toHaveBeenCalledWith(
      jobId,
      "worker-1",
      "ARTIFACT_CLEANUP_INVALID_JOB",
      false,
      1,
    );
  });

  it("touches no bytes when the claim was re-armed before the delete", async () => {
    const jobs = {
      claim: vi.fn(async () => [job()]),
      deferArtifactCleanup: vi.fn(async () => true),
      succeedArtifactCleanup: vi.fn(async () => true),
      retry: vi.fn(async () => undefined),
      retryArtifactCleanup: vi.fn(async () => true),
    };
    const service = {
      cleanupStoredObject: vi.fn(async () => undefined),
    };
    const processor = new ArtifactObjectCleanupProcessor({
      jobs,
      guards: guards(
        {
          ownerUserId,
          deletionState: "deleted",
          writeLeaseUntil: null,
          orphanedAt: null,
        },
        {
          generation: 2,
          lockedBy: "worker-1",
          leaseGeneration: 1,
          type: "cleanup_artifact_object",
        },
      ),
      service,
      workerId: "worker-1",
    });

    await processor.runOnce();

    expect(service.cleanupStoredObject).not.toHaveBeenCalled();
    expect(jobs.succeedArtifactCleanup).not.toHaveBeenCalled();
    expect(jobs.retryArtifactCleanup).not.toHaveBeenCalled();
    expect(jobs.retry).not.toHaveBeenCalled();
  });

  it("surfaces a lost claim when deferring a live write lease", async () => {
    const jobs = {
      claim: vi.fn(async () => [job()]),
      deferArtifactCleanup: vi.fn(async () => false),
      succeedArtifactCleanup: vi.fn(async () => true),
      retry: vi.fn(async () => undefined),
      retryArtifactCleanup: vi.fn(async () => true),
    };
    const service = {
      cleanupStoredObject: vi.fn(async () => undefined),
    };
    const processor = new ArtifactObjectCleanupProcessor({
      jobs,
      guards: guards({
        ownerUserId,
        deletionState: "pending",
        writeLeaseUntil: new Date("2026-09-06T00:05:00.000Z"),
        orphanedAt: null,
      }),
      service,
      workerId: "worker-1",
      now: () => new Date("2026-09-06T00:00:00.000Z"),
    });

    await expect(processor.runOnce()).rejects.toThrow(
      "Artifact cleanup job claim lost",
    );

    expect(service.cleanupStoredObject).not.toHaveBeenCalled();
    expect(jobs.retryArtifactCleanup).not.toHaveBeenCalled();
    expect(jobs.retry).not.toHaveBeenCalled();
  });

  it("surfaces a lost claim when parking an unverified object", async () => {
    const jobs = {
      claim: vi.fn(async () => [job()]),
      deferArtifactCleanup: vi.fn(async () => true),
      succeedArtifactCleanup: vi.fn(async () => true),
      retry: vi.fn(async () => undefined),
      retryArtifactCleanup: vi.fn(async () => false),
    };
    const service = {
      cleanupStoredObject: vi.fn(async () => undefined),
    };
    const processor = new ArtifactObjectCleanupProcessor({
      jobs,
      guards: guards(undefined),
      service,
      workerId: "worker-1",
    });

    await expect(processor.runOnce()).rejects.toThrow(
      "Artifact cleanup job claim lost",
    );

    expect(service.cleanupStoredObject).not.toHaveBeenCalled();
    expect(jobs.retry).not.toHaveBeenCalled();
  });

  it("surfaces a lost claim after deleting storage", async () => {
    const jobs = {
      claim: vi.fn(async () => [job()]),
      deferArtifactCleanup: vi.fn(async () => true),
      succeedArtifactCleanup: vi.fn(async () => false),
      retry: vi.fn(async () => undefined),
      retryArtifactCleanup: vi.fn(async () => true),
    };
    const service = {
      cleanupStoredObject: vi.fn(async () => undefined),
    };
    const processor = new ArtifactObjectCleanupProcessor({
      jobs,
      guards: guards({
        ownerUserId,
        deletionState: "deleted",
        writeLeaseUntil: null,
        orphanedAt: null,
      }),
      service,
      workerId: "worker-1",
    });

    await expect(processor.runOnce()).rejects.toThrow(
      "Artifact cleanup job claim lost",
    );

    expect(service.cleanupStoredObject).toHaveBeenCalledWith(
      objectKey,
      ownerUserId,
    );
    expect(jobs.retryArtifactCleanup).not.toHaveBeenCalled();
    expect(jobs.retry).not.toHaveBeenCalled();
  });

  it("surfaces a lost claim when the retry in catch is rejected", async () => {
    const jobs = {
      claim: vi.fn(async () => [job()]),
      deferArtifactCleanup: vi.fn(async () => true),
      succeedArtifactCleanup: vi.fn(async () => true),
      retry: vi.fn(async () => undefined),
      retryArtifactCleanup: vi.fn(async () => false),
    };
    const service = {
      cleanupStoredObject: vi.fn(async () => {
        throw new Error("storage failed");
      }),
    };
    const processor = new ArtifactObjectCleanupProcessor({
      jobs,
      guards: guards({
        ownerUserId,
        deletionState: "deleted",
        writeLeaseUntil: null,
        orphanedAt: null,
      }),
      service,
      workerId: "worker-1",
    });

    await expect(processor.runOnce()).rejects.toThrow(
      "Artifact cleanup job claim lost",
    );

    expect(jobs.retryArtifactCleanup).toHaveBeenCalledWith(
      jobId,
      "worker-1",
      0,
      1,
      "ARTIFACT_CLEANUP_FAILED",
      false,
    );
    expect(jobs.retry).not.toHaveBeenCalled();
  });
});

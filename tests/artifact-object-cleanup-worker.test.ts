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
    createdAt: timestamp,
    ...overrides,
  };
}

describe("ArtifactObjectCleanupProcessor", () => {
  it("deletes a private staged object and completes the leased job", async () => {
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
      service,
      workerId: "worker-1",
    });

    await expect(processor.runOnce()).resolves.toBe(1);
    expect(jobs.claim).toHaveBeenCalledWith({
      workerId: "worker-1",
      limit: 10,
      types: ["cleanup_artifact_object"],
    });
    expect(service.cleanupStoredObject).toHaveBeenCalledWith(
      objectKey,
      ownerUserId,
    );
    expect(jobs.succeedArtifactCleanup).toHaveBeenCalledWith(
      jobId,
      "worker-1",
      0,
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
      service,
      workerId: "worker-1",
    });

    await processor.runOnce();
    await processor.runOnce();

    expect(jobs.retryArtifactCleanup).toHaveBeenCalledWith(
      jobId,
      "worker-1",
      0,
      "STORAGE_UNAVAILABLE",
      false,
    );
    expect(jobs.succeedArtifactCleanup).toHaveBeenCalledWith(
      jobId,
      "worker-1",
      0,
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
    );
  });

  it("rearms cleanup claimed while its uploader fence is active", async () => {
    const jobs = {
      claim: vi.fn(async () => [
        job({
          lockedAt: new Date("2026-09-06T00:00:00.000Z"),
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
      service,
      workerId: "worker-1",
    });

    await processor.runOnce();

    expect(service.cleanupStoredObject).toHaveBeenCalledWith(
      objectKey,
      ownerUserId,
    );
    expect(jobs.deferArtifactCleanup).toHaveBeenCalledWith(
      jobId,
      "worker-1",
      0,
    );
    expect(jobs.succeedArtifactCleanup).not.toHaveBeenCalled();
  });
});

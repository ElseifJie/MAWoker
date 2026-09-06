import { describe, expect, it, vi } from "vitest";
import {
  UploadCleanupProcessor,
  type UploadCleanupJob,
} from "../apps/worker/src/upload-cleanup.js";

const uploadId = "00000000-0000-4000-8000-000000000001";
const ownerUserId = "00000000-0000-4000-8000-000000000002";
const timestamp = new Date("2026-09-06T00:00:00.000Z");

function job(overrides: Partial<UploadCleanupJob> = {}): UploadCleanupJob {
  return {
    id: uploadId,
    ownerUserId,
    type: "cleanup_upload",
    status: "running",
    priority: 200,
    payload: { uploadId },
    attempts: 1,
    maxAttempts: 10,
    runAfter: timestamp,
    lockedAt: timestamp,
    lockedBy: "worker-1",
    createdAt: timestamp,
    ...overrides,
  };
}

describe("UploadCleanupProcessor", () => {
  it("claims expired uploads and completes upstream cleanup", async () => {
    const jobs = {
      claim: vi.fn(async () => [job()]),
      succeed: vi.fn(async () => undefined),
      retry: vi.fn(async () => undefined),
    };
    const service = {
      cleanupExpired: vi.fn(async () => undefined),
    };
    const processor = new UploadCleanupProcessor({
      jobs,
      service,
      workerId: "worker-1",
    });

    await expect(processor.runOnce()).resolves.toBe(1);
    expect(jobs.claim).toHaveBeenCalledWith({
      workerId: "worker-1",
      limit: 10,
      types: ["cleanup_upload"],
    });
    expect(service.cleanupExpired).toHaveBeenCalledWith(uploadId, {
      userId: ownerUserId,
      requestId: `worker:${uploadId}:1`,
    });
    expect(jobs.succeed).toHaveBeenCalledWith(uploadId, "worker-1");
  });

  it("retries partial failures and marks the final attempt", async () => {
    const jobs = {
      claim: vi.fn(async () => [job({ attempts: 10 })]),
      succeed: vi.fn(async () => undefined),
      retry: vi.fn(async () => undefined),
    };
    const service = {
      cleanupExpired: vi.fn(async () => {
        throw new Error("Ark delete failed");
      }),
    };
    const processor = new UploadCleanupProcessor({
      jobs,
      service,
      workerId: "worker-1",
    });

    await expect(processor.runOnce()).resolves.toBe(1);
    expect(jobs.retry).toHaveBeenCalledWith(
      uploadId,
      "worker-1",
      "Ark delete failed",
      true,
    );
    expect(jobs.succeed).not.toHaveBeenCalled();
  });

  it("rejects malformed and unowned cleanup jobs", async () => {
    const jobs = {
      claim: vi.fn(async () => [
        job({ ownerUserId: null }),
        job({ payload: { uploadId: "" } }),
      ]),
      succeed: vi.fn(async () => undefined),
      retry: vi.fn(async () => undefined),
    };
    const service = {
      cleanupExpired: vi.fn(async () => undefined),
    };
    const processor = new UploadCleanupProcessor({
      jobs,
      service,
      workerId: "worker-1",
    });

    await expect(processor.runOnce()).resolves.toBe(2);
    expect(service.cleanupExpired).not.toHaveBeenCalled();
    expect(jobs.retry).toHaveBeenCalledTimes(2);
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  DriveObjectCleanupProcessor,
  type DriveObjectCleanupJob,
} from "../apps/worker/src/drive-object-cleanup.js";

const driveFileId = "00000000-0000-4000-8000-000000000001";
const ownerUserId = "00000000-0000-4000-8000-000000000002";
const timestamp = new Date("2026-09-06T00:00:00.000Z");

function job(
  overrides: Partial<DriveObjectCleanupJob> = {},
): DriveObjectCleanupJob {
  return {
    id: driveFileId,
    ownerUserId,
    type: "cleanup_drive_object",
    status: "running",
    priority: 90,
    payload: { driveFileId },
    attempts: 1,
    maxAttempts: 10,
    runAfter: timestamp,
    lockedAt: timestamp,
    lockedBy: "worker-1",
    createdAt: timestamp,
    ...overrides,
  };
}

function jobs(claimed: DriveObjectCleanupJob[]) {
  return {
    claim: vi.fn(async () => claimed),
    deferDriveCleanup: vi.fn(async () => true),
    succeedDriveCleanup: vi.fn(async () => true),
    retry: vi.fn(async () => undefined),
    retryDriveCleanup: vi.fn(async () => true),
  };
}

describe("DriveObjectCleanupProcessor", () => {
  it("deletes the drive object by id and completes the leased job", async () => {
    const lease = jobs([job()]);
    const service = { deleteStored: vi.fn(async () => undefined) };
    const processor = new DriveObjectCleanupProcessor({
      jobs: lease,
      service,
      workerId: "worker-1",
    });

    await expect(processor.runOnce()).resolves.toBe(1);
    expect(lease.claim).toHaveBeenCalledWith({
      workerId: "worker-1",
      limit: 10,
      types: ["cleanup_drive_object"],
    });
    // The service resolves the object key from the row, so the payload only ever
    // carries the drive id.
    expect(service.deleteStored).toHaveBeenCalledWith(driveFileId, ownerUserId);
    expect(lease.succeedDriveCleanup).toHaveBeenCalledWith(
      driveFileId,
      "worker-1",
      0,
    );
  });

  it("retries storage failures with a stable code and never leaks the key", async () => {
    const lease = jobs([job()]);
    lease.claim
      .mockResolvedValueOnce([job()])
      .mockResolvedValueOnce([job({ attempts: 2 })]);
    const service = {
      deleteStored: vi
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error("provider leaked private/key"), {
            name: "StorageProviderError",
            code: "STORAGE_UNAVAILABLE",
          }),
        )
        .mockResolvedValueOnce(undefined),
    };
    const processor = new DriveObjectCleanupProcessor({
      jobs: lease,
      service,
      workerId: "worker-1",
    });

    await processor.runOnce();
    await processor.runOnce();

    expect(lease.retryDriveCleanup).toHaveBeenCalledWith(
      driveFileId,
      "worker-1",
      0,
      "STORAGE_UNAVAILABLE",
      false,
    );
    expect(lease.succeedDriveCleanup).toHaveBeenCalledWith(
      driveFileId,
      "worker-1",
      0,
    );
    expect(JSON.stringify(lease.retryDriveCleanup.mock.calls)).not.toContain(
      "private/key",
    );
  });

  it("rejects a job with no drive id without touching storage", async () => {
    const lease = jobs([job({ payload: {} })]);
    const service = { deleteStored: vi.fn(async () => undefined) };
    const processor = new DriveObjectCleanupProcessor({
      jobs: lease,
      service,
      workerId: "worker-1",
    });

    await processor.runOnce();

    expect(service.deleteStored).not.toHaveBeenCalled();
    expect(lease.retry).toHaveBeenCalledWith(
      driveFileId,
      "worker-1",
      "DRIVE_CLEANUP_INVALID_JOB",
      false,
    );
  });

  it("defers cleanup claimed while the writer's lease is still active", async () => {
    const lease = jobs([
      job({
        lockedAt: new Date("2026-09-06T00:00:00.000Z"),
        payload: {
          driveFileId,
          uploadInProgressUntil: "2026-09-06T00:05:00.000Z",
        },
      }),
    ]);
    const service = { deleteStored: vi.fn(async () => undefined) };
    const processor = new DriveObjectCleanupProcessor({
      jobs: lease,
      service,
      workerId: "worker-1",
    });

    await processor.runOnce();

    expect(lease.deferDriveCleanup).toHaveBeenCalledWith(
      driveFileId,
      "worker-1",
      0,
    );
    expect(lease.succeedDriveCleanup).not.toHaveBeenCalled();
  });
});

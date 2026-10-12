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
    leaseGeneration: 1,
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

function guards(
  guard: Record<string, unknown> | undefined,
  claim: Record<string, unknown> | undefined = {
    generation: 0,
    lockedBy: "worker-1",
    leaseGeneration: 1,
    type: "cleanup_drive_object",
  },
) {
  return {
    findDriveCleanupGuard: vi.fn(async () => guard),
    findCleanupJobClaim: vi.fn(async () => claim),
  };
}

function liveLeaseGuard() {
  return {
    ownerUserId,
    deletionState: "pending",
    writeLeaseUntil: new Date("2026-09-06T00:05:00.000Z"),
  };
}

describe("DriveObjectCleanupProcessor", () => {
  it("deletes the drive object by id and completes the leased job", async () => {
    const lease = jobs([job()]);
    const service = { deleteStored: vi.fn(async () => undefined) };
    const processor = new DriveObjectCleanupProcessor({
      jobs: lease,
      guards: guards({
        ownerUserId,
        deletionState: "deleted",
        writeLeaseUntil: null,
        orphanedAt: null,
      }),
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
      1,
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
      guards: guards({
        ownerUserId,
        deletionState: "deleted",
        writeLeaseUntil: null,
      }),
      service,
      workerId: "worker-1",
    });

    await processor.runOnce();
    await processor.runOnce();

    expect(lease.retryDriveCleanup).toHaveBeenCalledWith(
      driveFileId,
      "worker-1",
      0,
      1,
      "STORAGE_UNAVAILABLE",
      false,
    );
    expect(lease.succeedDriveCleanup).toHaveBeenCalledWith(
      driveFileId,
      "worker-1",
      0,
      1,
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
      guards: guards({
        ownerUserId: "00000000-0000-4000-8000-000000000099",
        deletionState: "deleted",
        writeLeaseUntil: null,
        orphanedAt: null,
      }),
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
      1,
    );
  });

  it("defers cleanup while the live write lease is still active", async () => {
    const lease = jobs([job()]);
    const service = { deleteStored: vi.fn(async () => undefined) };
    const processor = new DriveObjectCleanupProcessor({
      jobs: lease,
      guards: guards(liveLeaseGuard()),
      service,
      workerId: "worker-1",
      now: () => new Date("2026-09-06T00:00:00.000Z"),
    });

    await processor.runOnce();

    // The lease check happens against the live row BEFORE any destructive
    // call, so a claimed job cannot delete a partial object mid-write.
    expect(lease.deferDriveCleanup).toHaveBeenCalledWith(
      driveFileId,
      "worker-1",
      0,
      1,
    );
    expect(service.deleteStored).not.toHaveBeenCalled();
    expect(lease.succeedDriveCleanup).not.toHaveBeenCalled();
  });

  it("reclaims an orphaned committed row through the GC intent", async () => {
    const lease = jobs([job()]);
    const service = { deleteStored: vi.fn(async () => undefined) };
    const processor = new DriveObjectCleanupProcessor({
      jobs: lease,
      guards: guards({
        ownerUserId,
        deletionState: "none",
        writeLeaseUntil: null,
        orphanedAt: new Date("2026-09-05T00:00:00.000Z"),
      }),
      service,
      workerId: "worker-1",
    });

    await processor.runOnce();

    // Orphan GC enqueues cleanup intents for committed rows it has already
    // proven unreferenced; the processor must reap them, not park them.
    expect(service.deleteStored).toHaveBeenCalledWith(driveFileId, ownerUserId);
    expect(lease.succeedDriveCleanup).toHaveBeenCalledWith(
      driveFileId,
      "worker-1",
      0,
      1,
    );
    expect(lease.retry).not.toHaveBeenCalled();
  });

  it("completes cleanup as a no-op for a committed live row", async () => {
    const lease = jobs([job()]);
    const service = { deleteStored: vi.fn(async () => undefined) };
    const processor = new DriveObjectCleanupProcessor({
      jobs: lease,
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

    // A commit raced the claim: the object is live (never orphaned), so the
    // bytes stay and the stale cleanup intent is retired successfully.
    expect(service.deleteStored).not.toHaveBeenCalled();
    expect(lease.succeedDriveCleanup).toHaveBeenCalledWith(
      driveFileId,
      "worker-1",
      0,
      1,
    );
    expect(lease.retryDriveCleanup).not.toHaveBeenCalled();
    expect(lease.retry).not.toHaveBeenCalled();
  });

  it.each([
    ["expired", new Date("2026-09-05T23:59:00.000Z")],
    ["absent", null],
  ])(
    "fails closed when a pending write lease is %s",
    async (_leaseState, writeLeaseUntil) => {
      const lease = jobs([job()]);
      const service = { deleteStored: vi.fn(async () => undefined) };
      const processor = new DriveObjectCleanupProcessor({
        jobs: lease,
        guards: guards({
          ownerUserId,
          deletionState: "pending",
          writeLeaseUntil,
          orphanedAt: null,
        }),
        service,
        workerId: "worker-1",
        now: () => new Date("2026-09-06T00:00:00.000Z"),
      });

      await processor.runOnce();

      expect(service.deleteStored).not.toHaveBeenCalled();
      expect(lease.succeedDriveCleanup).not.toHaveBeenCalled();
      expect(lease.retryDriveCleanup).toHaveBeenCalledWith(
        driveFileId,
        "worker-1",
        0,
        1,
        "DRIVE_CLEANUP_OBJECT_UNVERIFIED",
        true,
      );
      expect(lease.retry).not.toHaveBeenCalled();
    },
  );

  it("rejects a guard row owned by another user without touching storage", async () => {
    const lease = jobs([job()]);
    const service = { deleteStored: vi.fn(async () => undefined) };
    const processor = new DriveObjectCleanupProcessor({
      jobs: lease,
      guards: guards({
        ownerUserId: "00000000-0000-4000-8000-000000000099",
        deletionState: "deleted",
        writeLeaseUntil: null,
      }),
      service,
      workerId: "worker-1",
    });

    await processor.runOnce();

    expect(service.deleteStored).not.toHaveBeenCalled();
    expect(lease.retryDriveCleanup).toHaveBeenCalledWith(
      driveFileId,
      "worker-1",
      0,
      1,
      "DRIVE_CLEANUP_INVALID_JOB",
      false,
    );
  });

  it("touches no bytes when the claim was re-armed before the delete", async () => {
    const lease = jobs([job()]);
    const service = { deleteStored: vi.fn(async () => undefined) };
    const processor = new DriveObjectCleanupProcessor({
      jobs: lease,
      guards: guards(
        {
          ownerUserId,
          deletionState: "deleted",
          writeLeaseUntil: null,
          orphanedAt: null,
        },
        // The re-read finds the payload generation already advanced: this
        // execution lost the job and must leave the outcome to its owner.
        {
          generation: 1,
          lockedBy: "worker-1",
          leaseGeneration: 1,
          type: "cleanup_drive_object",
        },
      ),
      service,
      workerId: "worker-1",
    });

    await processor.runOnce();

    expect(service.deleteStored).not.toHaveBeenCalled();
    expect(lease.succeedDriveCleanup).not.toHaveBeenCalled();
    expect(lease.retryDriveCleanup).not.toHaveBeenCalled();
    expect(lease.retry).not.toHaveBeenCalled();
  });

  it("touches no bytes when another worker owns the current claim", async () => {
    const lease = jobs([job()]);
    const service = { deleteStored: vi.fn(async () => undefined) };
    const processor = new DriveObjectCleanupProcessor({
      jobs: lease,
      guards: guards(
        {
          ownerUserId,
          deletionState: "deleted",
          writeLeaseUntil: null,
          orphanedAt: null,
        },
        {
          generation: 0,
          lockedBy: "worker-2",
          leaseGeneration: 1,
          type: "cleanup_drive_object",
        },
      ),
      service,
      workerId: "worker-1",
    });

    await processor.runOnce();

    expect(service.deleteStored).not.toHaveBeenCalled();
    expect(lease.succeedDriveCleanup).not.toHaveBeenCalled();
  });

  it("surfaces a lost claim when deferring a live write lease", async () => {
    const lease = jobs([job()]);
    lease.deferDriveCleanup.mockResolvedValueOnce(false);
    const service = { deleteStored: vi.fn(async () => undefined) };
    const processor = new DriveObjectCleanupProcessor({
      jobs: lease,
      guards: guards(liveLeaseGuard()),
      service,
      workerId: "worker-1",
      now: () => new Date("2026-09-06T00:00:00.000Z"),
    });

    await expect(processor.runOnce()).rejects.toThrow(
      "Drive cleanup job claim lost",
    );

    expect(service.deleteStored).not.toHaveBeenCalled();
    expect(lease.retryDriveCleanup).not.toHaveBeenCalled();
    expect(lease.retry).not.toHaveBeenCalled();
  });

  it("surfaces a lost claim when parking an unverified write", async () => {
    const lease = jobs([job()]);
    lease.retryDriveCleanup.mockResolvedValueOnce(false);
    const service = { deleteStored: vi.fn(async () => undefined) };
    const processor = new DriveObjectCleanupProcessor({
      jobs: lease,
      guards: guards({
        ownerUserId,
        deletionState: "pending",
        writeLeaseUntil: null,
        orphanedAt: null,
      }),
      service,
      workerId: "worker-1",
    });

    await expect(processor.runOnce()).rejects.toThrow(
      "Drive cleanup job claim lost",
    );

    expect(service.deleteStored).not.toHaveBeenCalled();
    expect(lease.retry).not.toHaveBeenCalled();
  });

  it("surfaces a lost claim when completing a live-row no-op", async () => {
    const lease = jobs([job()]);
    lease.succeedDriveCleanup.mockResolvedValueOnce(false);
    const service = { deleteStored: vi.fn(async () => undefined) };
    const processor = new DriveObjectCleanupProcessor({
      jobs: lease,
      guards: guards({
        ownerUserId,
        deletionState: "none",
        writeLeaseUntil: null,
        orphanedAt: null,
      }),
      service,
      workerId: "worker-1",
    });

    await expect(processor.runOnce()).rejects.toThrow(
      "Drive cleanup job claim lost",
    );

    expect(service.deleteStored).not.toHaveBeenCalled();
    expect(lease.retryDriveCleanup).not.toHaveBeenCalled();
    expect(lease.retry).not.toHaveBeenCalled();
  });

  it("surfaces a lost claim after deleting storage", async () => {
    const lease = jobs([job()]);
    lease.succeedDriveCleanup.mockResolvedValueOnce(false);
    const service = { deleteStored: vi.fn(async () => undefined) };
    const processor = new DriveObjectCleanupProcessor({
      jobs: lease,
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
      "Drive cleanup job claim lost",
    );

    expect(service.deleteStored).toHaveBeenCalledWith(driveFileId, ownerUserId);
    expect(lease.retryDriveCleanup).not.toHaveBeenCalled();
    expect(lease.retry).not.toHaveBeenCalled();
  });

  it("surfaces a lost claim when the retry in catch is rejected", async () => {
    const lease = jobs([job()]);
    lease.retryDriveCleanup.mockResolvedValueOnce(false);
    const service = {
      deleteStored: vi.fn(async () => {
        throw new Error("storage failed");
      }),
    };
    const processor = new DriveObjectCleanupProcessor({
      jobs: lease,
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
      "Drive cleanup job claim lost",
    );

    expect(lease.retryDriveCleanup).toHaveBeenCalledWith(
      driveFileId,
      "worker-1",
      0,
      1,
      "DRIVE_CLEANUP_FAILED",
      false,
    );
    expect(lease.retry).not.toHaveBeenCalled();
  });
});

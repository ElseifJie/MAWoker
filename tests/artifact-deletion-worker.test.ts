import { describe, expect, it, vi } from "vitest";
import {
  ArtifactDeletionProcessor,
  type ArtifactDeletionJob,
} from "../apps/worker/src/artifact-deletion.js";

const artifactId = "00000000-0000-4000-8000-000000000001";
const ownerUserId = "00000000-0000-4000-8000-000000000002";
const timestamp = new Date("2026-09-06T00:00:00.000Z");

function job(
  overrides: Partial<ArtifactDeletionJob> = {},
): ArtifactDeletionJob {
  return {
    id: artifactId,
    ownerUserId,
    type: "delete_artifact",
    status: "running",
    priority: 100,
    payload: { artifactId },
    attempts: 1,
    maxAttempts: 10,
    runAfter: timestamp,
    lockedAt: timestamp,
    lockedBy: "worker-1",
    createdAt: timestamp,
    ...overrides,
  };
}

describe("ArtifactDeletionProcessor", () => {
  it("claims leased artifact jobs and completes deletion", async () => {
    const jobs = {
      claim: vi.fn(async () => [job()]),
      succeed: vi.fn(async () => undefined),
      retry: vi.fn(async () => undefined),
    };
    const service = {
      deleteStored: vi.fn(async () => undefined),
    };
    const processor = new ArtifactDeletionProcessor({
      jobs,
      service,
      workerId: "worker-1",
    });

    await expect(processor.runOnce()).resolves.toBe(1);
    expect(jobs.claim).toHaveBeenCalledWith({
      workerId: "worker-1",
      limit: 10,
      types: ["delete_artifact"],
    });
    expect(service.deleteStored).toHaveBeenCalledWith(artifactId, ownerUserId);
    expect(jobs.succeed).toHaveBeenCalledWith(artifactId, "worker-1");
  });

  it("retries partial storage/index failures and marks the final attempt", async () => {
    const jobs = {
      claim: vi.fn(async () => [job({ attempts: 10 })]),
      succeed: vi.fn(async () => undefined),
      retry: vi.fn(async () => undefined),
    };
    const service = {
      deleteStored: vi.fn(async () => {
        throw new Error("index delete failed");
      }),
    };
    const processor = new ArtifactDeletionProcessor({
      jobs,
      service,
      workerId: "worker-1",
    });

    await expect(processor.runOnce()).resolves.toBe(1);
    expect(jobs.retry).toHaveBeenCalledWith(
      artifactId,
      "worker-1",
      "ARTIFACT_DELETE_FAILED",
      true,
    );
    expect(jobs.succeed).not.toHaveBeenCalled();
  });

  it("rejects malformed and ownerless jobs without touching storage", async () => {
    const jobs = {
      claim: vi.fn(async () => [
        job({ ownerUserId: null }),
        job({ payload: { artifactId: "" } }),
      ]),
      succeed: vi.fn(async () => undefined),
      retry: vi.fn(async () => undefined),
    };
    const service = {
      deleteStored: vi.fn(async () => undefined),
    };
    const processor = new ArtifactDeletionProcessor({
      jobs,
      service,
      workerId: "worker-1",
    });

    await expect(processor.runOnce()).resolves.toBe(2);
    expect(service.deleteStored).not.toHaveBeenCalled();
    expect(jobs.retry).toHaveBeenCalledTimes(2);
    expect(jobs.retry).toHaveBeenNthCalledWith(
      1,
      artifactId,
      "worker-1",
      "ARTIFACT_DELETE_INVALID_JOB",
      false,
    );
    expect(jobs.retry).toHaveBeenNthCalledWith(
      2,
      artifactId,
      "worker-1",
      "ARTIFACT_DELETE_INVALID_JOB",
      false,
    );
  });

  it("persists a stable storage code instead of provider details", async () => {
    const jobs = {
      claim: vi.fn(async () => [job()]),
      succeed: vi.fn(async () => undefined),
      retry: vi.fn(async () => undefined),
    };
    const service = {
      deleteStored: vi.fn(async () => {
        throw Object.assign(
          new Error("provider leaked private/tenant/secret-object-key"),
          {
            name: "StorageProviderError",
            code: "STORAGE_UNAVAILABLE",
          },
        );
      }),
    };
    const processor = new ArtifactDeletionProcessor({
      jobs,
      service,
      workerId: "worker-1",
    });

    await processor.runOnce();

    expect(jobs.retry).toHaveBeenCalledWith(
      artifactId,
      "worker-1",
      "STORAGE_UNAVAILABLE",
      false,
    );
    expect(JSON.stringify(jobs.retry.mock.calls)).not.toMatch(
      /secret-object-key|provider leaked/,
    );
  });

  it.each([
    new Error("database password and object key leaked"),
    { message: "plain object provider detail" },
    "raw string failure",
    null,
  ])(
    "maps every unknown worker failure to one stable code",
    async (failure) => {
      const jobs = {
        claim: vi.fn(async () => [job()]),
        succeed: vi.fn(async () => undefined),
        retry: vi.fn(async () => undefined),
      };
      const processor = new ArtifactDeletionProcessor({
        jobs,
        service: {
          deleteStored: vi.fn(async () => {
            throw failure;
          }),
        },
        workerId: "worker-1",
      });

      await processor.runOnce();

      expect(jobs.retry).toHaveBeenCalledWith(
        artifactId,
        "worker-1",
        "ARTIFACT_DELETE_FAILED",
        false,
      );
      expect(JSON.stringify(jobs.retry.mock.calls)).not.toContain(
        String(failure),
      );
    },
  );
});

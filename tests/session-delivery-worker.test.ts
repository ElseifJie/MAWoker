import { describe, expect, it, vi } from "vitest";
import { SessionReconciliationProcessor } from "../apps/worker/src/session-reconciliation.js";

describe("background artifact sync jobs", () => {
  const job = {
    id: "turn",
    ownerUserId: "owner",
    type: "reconcile_session" as const,
    status: "running" as const,
    priority: 150,
    payload: {
      operation: "sync_artifacts",
      sessionId: "session",
      turnId: "turn",
    },
    attempts: 1,
    maxAttempts: 100,
    runAfter: new Date(),
    lockedAt: new Date(),
    lockedBy: "worker",
    leaseGeneration: 1,
    createdAt: new Date(),
  };

  it("dispatches artifact jobs with lease fencing and marks successful sync once", async () => {
    const jobs = {
      claim: vi.fn(async () => [job]),
      succeed: vi.fn(),
      retry: vi.fn(),
    };
    const syncArtifacts = vi.fn(async () => {});
    const service = { reconcileCreate: vi.fn() };
    const processor = new SessionReconciliationProcessor({
      jobs,
      service,
      workerId: "worker",
      delivery: { syncArtifacts },
    });
    await processor.runOnce();
    expect(syncArtifacts).toHaveBeenCalledWith(
      "turn",
      expect.objectContaining({
        userId: "owner",
        workerId: "worker",
        leaseGeneration: 1,
      }),
    );
    expect(service.reconcileCreate).not.toHaveBeenCalled();
    expect(jobs.succeed).toHaveBeenCalledWith("turn", "worker", 1);
  });

  it("requeues pending visibility instead of completing or terminating a session", async () => {
    const jobs = {
      claim: vi.fn(async () => [job]),
      succeed: vi.fn(),
      retry: vi.fn(),
    };
    const syncArtifacts = vi.fn(async () => {
      throw Object.assign(new Error("pending"), {
        code: "ARTIFACT_SYNC_PENDING",
      });
    });
    const processor = new SessionReconciliationProcessor({
      jobs,
      service: { reconcileCreate: vi.fn() },
      workerId: "worker",
      delivery: { syncArtifacts },
    });
    await processor.runOnce();
    expect(jobs.succeed).not.toHaveBeenCalled();
    expect(jobs.retry).toHaveBeenCalledWith(
      "turn",
      "worker",
      "ARTIFACT_SYNC_PENDING",
      false,
      1,
    );
  });
});

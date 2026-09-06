import { describe, expect, it, vi } from "vitest";
import {
  SessionReconciliationProcessor,
  type SessionReconciliationJob,
} from "../apps/worker/src/session-reconciliation.js";

const now = new Date("2026-09-06T00:00:00.000Z");

function job(
  overrides: Partial<SessionReconciliationJob> = {},
): SessionReconciliationJob {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    ownerUserId: "00000000-0000-4000-8000-000000000002",
    type: "reconcile_session",
    status: "running",
    priority: 100,
    payload: {
      operation: "create",
      sessionId: "00000000-0000-4000-8000-000000000001",
    },
    attempts: 1,
    maxAttempts: 10,
    runAfter: now,
    lockedAt: now,
    lockedBy: "worker-1",
    createdAt: now,
    ...overrides,
  };
}

describe("SessionReconciliationProcessor", () => {
  it("claims and completes Session create reconciliation", async () => {
    const jobs = {
      claim: vi.fn(async () => [job()]),
      succeed: vi.fn(async () => undefined),
      retry: vi.fn(async () => undefined),
    };
    const service = {
      reconcileCreate: vi.fn(async () => undefined),
    };
    const processor = new SessionReconciliationProcessor({
      jobs,
      service,
      workerId: "worker-1",
    });

    await expect(processor.runOnce()).resolves.toBe(1);
    expect(jobs.claim).toHaveBeenCalledWith({
      workerId: "worker-1",
      limit: 10,
      types: ["reconcile_session"],
    });
    expect(service.reconcileCreate).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000001",
      {
        userId: "00000000-0000-4000-8000-000000000002",
        requestId: "worker:00000000-0000-4000-8000-000000000001:1",
      },
    );
    expect(jobs.succeed).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000001",
      "worker-1",
    );
    expect(jobs.retry).not.toHaveBeenCalled();
  });

  it("retries failures and marks the final attempt", async () => {
    const jobs = {
      claim: vi.fn(async () => [job({ attempts: 10 })]),
      succeed: vi.fn(async () => undefined),
      retry: vi.fn(async () => undefined),
    };
    const service = {
      reconcileCreate: vi.fn(async () => {
        throw new Error("Ark unavailable");
      }),
    };
    const processor = new SessionReconciliationProcessor({
      jobs,
      service,
      workerId: "worker-1",
    });

    await expect(processor.runOnce()).resolves.toBe(1);
    expect(jobs.retry).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000001",
      "worker-1",
      "Ark unavailable",
      true,
    );
    expect(jobs.succeed).not.toHaveBeenCalled();
  });

  it("rejects malformed or unowned reconciliation jobs", async () => {
    const jobs = {
      claim: vi.fn(async () => [
        job({ ownerUserId: null }),
        job({ payload: { operation: "delete" } }),
      ]),
      succeed: vi.fn(async () => undefined),
      retry: vi.fn(async () => undefined),
    };
    const service = {
      reconcileCreate: vi.fn(async () => undefined),
    };
    const processor = new SessionReconciliationProcessor({
      jobs,
      service,
      workerId: "worker-1",
    });

    await expect(processor.runOnce()).resolves.toBe(2);
    expect(service.reconcileCreate).not.toHaveBeenCalled();
    expect(jobs.retry).toHaveBeenCalledTimes(2);
  });
});

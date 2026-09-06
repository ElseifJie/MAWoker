import { describe, expect, it, vi } from "vitest";
import {
  PersonalAgentReconciliationProcessor,
  type PersonalAgentReconciliationJob,
} from "../apps/worker/src/personal-agent-reconciliation.js";

const ownerUserId = "00000000-0000-4000-8000-000000000001";
const personalAgentId = "00000000-0000-4000-8000-000000000002";

function job(
  operation: "create" | "update" | "delete",
  attempts = 1,
): PersonalAgentReconciliationJob {
  return {
    id: personalAgentId,
    ownerUserId,
    type: "reconcile_personal_agent",
    status: "running",
    priority: 100,
    payload: {
      operation,
      personalAgentId,
      ...(operation === "update"
        ? {
            configuration: {
              name: "Recovered",
              description: "",
              modelId: "model-a",
              systemPrompt: "Prompt",
            },
            arkVersion: "1",
          }
        : {}),
    },
    attempts,
    maxAttempts: 3,
    runAfter: new Date("2026-09-06T00:00:00Z"),
    lockedAt: new Date("2026-09-06T00:00:00Z"),
    lockedBy: "worker-1",
    createdAt: new Date("2026-09-06T00:00:00Z"),
  };
}

describe("PersonalAgentReconciliationProcessor", () => {
  it.each(["create", "update", "delete"] as const)(
    "dispatches and completes a claimed %s reconciliation job",
    async (operation) => {
      const claimed = job(operation);
      const jobs = {
        claim: vi.fn().mockResolvedValue([claimed]),
        succeed: vi.fn().mockResolvedValue(undefined),
        retry: vi.fn().mockResolvedValue(undefined),
      };
      const service = {
        reconcileCreate: vi.fn().mockResolvedValue(undefined),
        reconcileUpdate: vi.fn().mockResolvedValue(undefined),
        reconcileDelete: vi.fn().mockResolvedValue(undefined),
      };
      const processor = new PersonalAgentReconciliationProcessor({
        jobs,
        service,
        workerId: "worker-1",
      });

      await expect(processor.runOnce()).resolves.toBe(1);

      expect(jobs.claim).toHaveBeenCalledWith({
        workerId: "worker-1",
        limit: 10,
        types: ["reconcile_personal_agent"],
      });
      expect(service.reconcileCreate).toHaveBeenCalledTimes(
        operation === "create" ? 1 : 0,
      );
      expect(service.reconcileUpdate).toHaveBeenCalledTimes(
        operation === "update" ? 1 : 0,
      );
      expect(service.reconcileDelete).toHaveBeenCalledTimes(
        operation === "delete" ? 1 : 0,
      );
      expect(jobs.succeed).toHaveBeenCalledWith(claimed.id, "worker-1");
      expect(jobs.retry).not.toHaveBeenCalled();
    },
  );

  it("requeues failures and marks the final repeated attempt failed", async () => {
    const jobs = {
      claim: vi
        .fn()
        .mockResolvedValueOnce([job("create", 1)])
        .mockResolvedValueOnce([job("create", 3)]),
      succeed: vi.fn().mockResolvedValue(undefined),
      retry: vi.fn().mockResolvedValue(undefined),
    };
    const service = {
      reconcileCreate: vi
        .fn()
        .mockRejectedValueOnce(new Error("temporary"))
        .mockRejectedValueOnce(new Error("still failing")),
      reconcileUpdate: vi.fn(),
      reconcileDelete: vi.fn(),
    };
    const processor = new PersonalAgentReconciliationProcessor({
      jobs,
      service,
      workerId: "worker-1",
    });

    await processor.runOnce();
    await processor.runOnce();

    expect(jobs.retry).toHaveBeenNthCalledWith(
      1,
      personalAgentId,
      "worker-1",
      "temporary",
      false,
    );
    expect(jobs.retry).toHaveBeenNthCalledWith(
      2,
      personalAgentId,
      "worker-1",
      "still failing",
      true,
    );
    expect(jobs.succeed).not.toHaveBeenCalled();
  });
});

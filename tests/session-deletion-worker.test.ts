import { describe, expect, it, vi } from "vitest";
import type { ArkSession } from "../packages/ark-client/src/index.js";
import {
  SessionDeletionProcessor,
  type SessionDeletionJob,
} from "../apps/worker/src/session-deletion.js";

const sessionId = "00000000-0000-4000-8000-000000000001";
const ownerUserId = "00000000-0000-4000-8000-000000000002";
const timestamp = new Date("2026-09-06T00:00:00.000Z");
const configSnapshot = {
  modelId: "model-a",
  skills: [],
  tools: [],
  environment: {
    id: "environment-1",
    type: "environment",
    configType: "cloud",
    scope: "account",
  },
  completeness: "complete" as const,
};

function job(overrides: Partial<SessionDeletionJob> = {}): SessionDeletionJob {
  return {
    id: sessionId,
    ownerUserId,
    type: "delete_session",
    status: "running",
    priority: 80,
    payload: { sessionId, completed: {} },
    attempts: 1,
    maxAttempts: 10,
    runAfter: timestamp,
    lockedAt: timestamp,
    lockedBy: "worker-1",
    createdAt: timestamp,
    ...overrides,
  };
}

function setup(
  input: {
    status?: "idle" | "running";
    payload?: SessionDeletionJob["payload"];
    localRemoval?: "removed" | "missing";
    settlement?: "confirmed" | "pending" | "unknown";
  } = {},
) {
  const order: string[] = [];
  const jobs = {
    claim: vi.fn(async () => [
      job(input.payload === undefined ? {} : { payload: input.payload }),
    ]),
    updatePayload: vi.fn(async (_id, _workerId, payload) => {
      order.push(`checkpoint:${Object.keys(payload.completed).join(",")}`);
    }),
    succeed: vi.fn(async () => {
      order.push("succeed");
    }),
    retry: vi.fn(async () => {
      order.push("retry");
    }),
    deferSessionDeletion: vi.fn(async () => {
      order.push("defer");
      return true;
    }),
  };
  const repository = {
    findDeleting: vi.fn(async () => ({
      id: sessionId,
      ownerUserId,
      arkSessionId: "ark-session-1",
      status: input.status ?? "idle",
    })),
    orphanDriveFiles: vi.fn(async () => {
      order.push("orphan");
      return 2;
    }),
    removeLocal: vi.fn(async () => {
      order.push("local");
      return input.localRemoval ?? "removed";
    }),
  };
  const ark = {
    getSession: vi.fn(async (): Promise<ArkSession> => {
      order.push("get");
      return {
        id: "ark-session-1",
        agentId: "agent-1",
        agentVersion: 1,
        environmentId: "environment-1",
        status: "idle" as const,
        configSnapshot,
      };
    }),
    submitEvent: vi.fn(async () => {
      order.push("interrupt");
      return {
        id: "event-1",
        type: "user.interrupt",
        createdAt: timestamp.toISOString(),
        data: {},
      };
    }),
    deleteSession: vi.fn(async () => {
      order.push("ark-delete");
    }),
  };
  const settlement = {
    verify: vi.fn(async () => input.settlement ?? "confirmed"),
  };
  const processor = new SessionDeletionProcessor({
    jobs,
    repository,
    ark,
    settlement,
    workerId: "worker-1",
    now: () => timestamp,
  });
  return { processor, jobs, repository, ark, order, settlement };
}

describe("SessionDeletionProcessor", () => {
  it("interrupts a running Session, then deletes Ark, orphans bytes, and removes local records", async () => {
    const state = setup({ status: "running" });
    state.ark.getSession
      .mockResolvedValueOnce({
        id: "ark-session-1",
        agentId: "agent-1",
        agentVersion: 1,
        environmentId: "environment-1",
        status: "running",
        configSnapshot,
      })
      .mockResolvedValueOnce({
        id: "ark-session-1",
        agentId: "agent-1",
        agentVersion: 1,
        environmentId: "environment-1",
        status: "idle",
        configSnapshot,
      });

    await expect(state.processor.runOnce()).resolves.toBe(1);

    expect(state.jobs.claim).toHaveBeenCalledWith({
      workerId: "worker-1",
      limit: 10,
      types: ["delete_session"],
    });
    expect(state.ark.getSession).toHaveBeenCalledTimes(2);
    expect(state.ark.getSession.mock.invocationCallOrder[0]).toBeLessThan(
      state.ark.submitEvent.mock.invocationCallOrder[0]!,
    );
    expect(state.ark.getSession.mock.invocationCallOrder[1]).toBeLessThan(
      state.ark.deleteSession.mock.invocationCallOrder[0]!,
    );
    expect(state.order).toEqual([
      "interrupt",
      "checkpoint:interruptRequested",
      "checkpoint:interruptRequested,nonRunningObserved",
      "checkpoint:interruptRequested,nonRunningObserved,settlementConfirmed",
      "ark-delete",
      "checkpoint:interruptRequested,nonRunningObserved,settlementConfirmed,arkDeleted",
      "orphan",
      "checkpoint:interruptRequested,nonRunningObserved,settlementConfirmed,arkDeleted,artifactsOrphaned",
      "local",
      "succeed",
    ]);
    // The bytes are handed to the drive GC rather than deleted inline, so the
    // retention setting decides when they actually go.
    expect(state.repository.orphanDriveFiles).toHaveBeenCalledWith(
      ownerUserId,
      sessionId,
      timestamp,
    );
  });

  it("resumes after an Ark checkpoint without repeating completed external steps", async () => {
    const state = setup({
      payload: {
        sessionId,
        completed: {
          nonRunningObserved: true,
          settlementConfirmed: true,
          arkDeleted: true,
        },
      },
    });
    state.repository.orphanDriveFiles.mockRejectedValueOnce(
      new Error("drive unavailable"),
    );

    await state.processor.runOnce();
    expect(state.jobs.retry).toHaveBeenCalledWith(
      sessionId,
      "worker-1",
      "SESSION_DELETE_FAILED",
      false,
    );
    expect(state.repository.removeLocal).not.toHaveBeenCalled();

    state.jobs.claim.mockResolvedValueOnce([
      job({
        attempts: 2,
        payload: {
          sessionId,
          completed: {
            nonRunningObserved: true,
            settlementConfirmed: true,
            arkDeleted: true,
          },
        },
      }),
    ]);
    await state.processor.runOnce();

    expect(state.ark.getSession).not.toHaveBeenCalled();
    expect(state.ark.deleteSession).not.toHaveBeenCalled();
    expect(state.repository.removeLocal).toHaveBeenCalledOnce();
    expect(state.jobs.succeed).toHaveBeenCalledWith(sessionId, "worker-1");
  });

  it("waits for an observed non-running state before deleting", async () => {
    const state = setup({ status: "running" });
    state.ark.getSession.mockResolvedValue({
      id: "ark-session-1",
      agentId: "agent-1",
      agentVersion: 1,
      environmentId: "environment-1",
      status: "running",
      configSnapshot,
    });

    await state.processor.runOnce();

    expect(state.ark.submitEvent).toHaveBeenCalledOnce();
    expect(state.ark.deleteSession).not.toHaveBeenCalled();
    expect(state.repository.orphanDriveFiles).not.toHaveBeenCalled();
    expect(state.jobs.retry).toHaveBeenCalledWith(
      sessionId,
      "worker-1",
      "SESSION_DELETE_WAITING",
      false,
    );

    state.jobs.claim.mockResolvedValueOnce([
      job({
        attempts: 2,
        payload: {
          sessionId,
          completed: { interruptRequested: true },
        },
      }),
    ]);
    await state.processor.runOnce();
    expect(state.ark.submitEvent).toHaveBeenCalledTimes(2);
  });

  it("holds deletion while the memory fence is capturing increments", async () => {
    const fence = vi
      .fn()
      .mockResolvedValueOnce("capturing")
      .mockResolvedValueOnce("clear");
    const state = setup();
    const processor = new SessionDeletionProcessor({
      jobs: state.jobs,
      repository: state.repository,
      ark: state.ark,
      memory: { fenceDeletion: fence },
      settlement: state.settlement,
      workerId: "worker-1",
      now: () => timestamp,
    });

    await processor.runOnce();

    // The fence gates the Ark deletion specifically: capture lands in the
    // episodic digest first. Waiting defers the job without consuming an
    // attempt — consolidation progresses in this same worker.
    expect(fence).toHaveBeenCalledWith(ownerUserId, "ark-session-1");
    expect(state.ark.deleteSession).not.toHaveBeenCalled();
    expect(state.jobs.deferSessionDeletion).toHaveBeenCalledWith(
      sessionId,
      "worker-1",
      new Date(timestamp.getTime() + 30_000),
    );
    expect(state.jobs.retry).not.toHaveBeenCalled();
    expect(state.jobs.succeed).not.toHaveBeenCalled();

    state.jobs.claim.mockResolvedValueOnce([
      job({
        attempts: 1,
        payload: {
          sessionId,
          completed: { interruptRequested: true, nonRunningObserved: true },
          fenceWaitStartedAt: timestamp.getTime(),
        },
      }),
    ]);
    await processor.runOnce();

    expect(fence).toHaveBeenCalledTimes(2);
    expect(state.ark.deleteSession).toHaveBeenCalledOnce();
    expect(state.jobs.deferSessionDeletion).toHaveBeenCalledTimes(1);
    expect(state.jobs.succeed).toHaveBeenCalledWith(sessionId, "worker-1");
  });

  it("falls back to the attempt budget after an hour without fence progress", async () => {
    const fence = vi.fn().mockResolvedValue("capturing");
    const state = setup();
    state.jobs.claim.mockResolvedValueOnce([
      job({
        attempts: 10,
        maxAttempts: 10,
        payload: {
          sessionId,
          completed: { interruptRequested: true, nonRunningObserved: true },
          fenceWaitStartedAt: timestamp.getTime() - 3_600_001,
        },
      }),
    ]);
    const processor = new SessionDeletionProcessor({
      jobs: state.jobs,
      repository: state.repository,
      ark: state.ark,
      memory: { fenceDeletion: fence },
      settlement: state.settlement,
      workerId: "worker-1",
      now: () => timestamp,
    });

    await processor.runOnce();

    expect(state.jobs.deferSessionDeletion).not.toHaveBeenCalled();
    expect(state.jobs.retry).toHaveBeenCalledWith(
      sessionId,
      "worker-1",
      "SESSION_DELETE_WAITING",
      true,
    );
  });

  it("rejects malformed and ownerless jobs before tenant or provider access", async () => {
    const state = setup();
    state.jobs.claim.mockResolvedValueOnce([
      job({ ownerUserId: null }),
      job({ payload: { sessionId: "other", completed: {} } }),
    ]);

    await expect(state.processor.runOnce()).resolves.toBe(2);

    expect(state.repository.findDeleting).not.toHaveBeenCalled();
    expect(state.ark.getSession).not.toHaveBeenCalled();
    expect(state.repository.orphanDriveFiles).not.toHaveBeenCalled();
    expect(state.jobs.retry).toHaveBeenCalledTimes(2);
    expect(state.jobs.retry).toHaveBeenNthCalledWith(
      1,
      sessionId,
      "worker-1",
      "SESSION_DELETE_INVALID_JOB",
      false,
    );
  });

  it("succeeds without touching anything when the Session is already gone", async () => {
    const state = setup();
    state.repository.findDeleting.mockResolvedValueOnce(undefined as never);

    await state.processor.runOnce();

    expect(state.repository.orphanDriveFiles).not.toHaveBeenCalled();
    expect(state.jobs.succeed).toHaveBeenCalledWith(sessionId, "worker-1");
  });

  it("fails deletion without removing local records when orphaning is exhausted", async () => {
    const state = setup({
      payload: {
        sessionId,
        completed: {
          nonRunningObserved: true,
          settlementConfirmed: true,
          arkDeleted: true,
        },
      },
    });
    state.repository.orphanDriveFiles.mockRejectedValue(
      new Error("drive store unavailable"),
    );
    state.jobs.claim.mockResolvedValueOnce([
      job({
        attempts: 10,
        payload: {
          sessionId,
          completed: {
            nonRunningObserved: true,
            settlementConfirmed: true,
            arkDeleted: true,
          },
        },
      }),
    ]);

    await state.processor.runOnce();

    expect(state.repository.removeLocal).not.toHaveBeenCalled();
    expect(state.jobs.succeed).not.toHaveBeenCalled();
    expect(state.jobs.retry).toHaveBeenCalledWith(
      sessionId,
      "worker-1",
      "SESSION_DELETE_FAILED",
      true,
    );
  });

  it("never deletes upstream before settlement is confirmed", async () => {
    const state = setup({ settlement: "unknown" });

    await state.processor.runOnce();

    // The irreversible upstream delete is gated on a confirmed settlement;
    // unknown parks the job instead, keeping the Session verifiable.
    expect(state.ark.deleteSession).not.toHaveBeenCalled();
    expect(state.settlement.verify).toHaveBeenCalledWith(
      ownerUserId,
      sessionId,
      expect.objectContaining({
        requestId: expect.stringContaining(sessionId),
      }),
    );
    const deferredAt = state.jobs.deferSessionDeletion.mock.calls[0]?.[2];
    expect(
      deferredAt?.getTime() ?? 0 - timestamp.getTime(),
    ).toBeGreaterThanOrEqual(60 * 60_000);
    expect(state.jobs.retry).not.toHaveBeenCalled();
  });

  it("defers without consuming attempts while settlement is pending", async () => {
    const state = setup({ settlement: "pending" });

    await state.processor.runOnce();

    expect(state.ark.deleteSession).not.toHaveBeenCalled();
    expect(state.jobs.deferSessionDeletion).toHaveBeenCalled();
    expect(state.jobs.retry).not.toHaveBeenCalled();
  });

  it("proceeds to the irreversible delete once settlement confirms", async () => {
    const state = setup({ settlement: "confirmed" });

    await state.processor.runOnce();

    expect(state.ark.deleteSession).toHaveBeenCalledWith(
      "ark-session-1",
      expect.objectContaining({
        idempotencyKey: expect.stringContaining("session-delete:"),
      }),
    );
    expect(state.order).toContain("ark-delete");
    expect(state.order).toContain("local");
  });

  it("does not re-verify settlement on a resumed job past the Ark delete", async () => {
    const state = setup({
      payload: {
        sessionId,
        completed: {
          nonRunningObserved: true,
          settlementConfirmed: true,
          arkDeleted: true,
          artifactsOrphaned: true,
        },
      },
      settlement: "unknown",
    });

    await state.processor.runOnce();

    // The irreversible steps already happened under a confirmed settlement;
    // the resume path must not re-open the gate or touch Ark again.
    expect(state.settlement.verify).not.toHaveBeenCalled();
    expect(state.ark.deleteSession).not.toHaveBeenCalled();
    expect(state.order).toContain("local");
    expect(state.jobs.succeed).toHaveBeenCalled();
  });

  it("emits a structured alert on terminal deletion failure", async () => {
    const alert = vi.fn();
    const state = setup({
      payload: {
        sessionId,
        completed: {
          nonRunningObserved: true,
          settlementConfirmed: true,
          arkDeleted: true,
        },
      },
    });
    state.repository.orphanDriveFiles.mockRejectedValue(
      new Error("drive store unavailable"),
    );
    state.jobs.claim.mockResolvedValueOnce([
      job({
        attempts: 10,
        payload: {
          sessionId,
          completed: {
            nonRunningObserved: true,
            settlementConfirmed: true,
            arkDeleted: true,
          },
        },
      }),
    ]);

    const processor = new SessionDeletionProcessor({
      jobs: state.jobs,
      repository: state.repository,
      ark: state.ark,
      settlement: state.settlement,
      workerId: "worker-1",
      now: () => timestamp,
      alert,
    });

    await processor.runOnce();

    expect(state.jobs.retry).toHaveBeenCalledWith(
      sessionId,
      "worker-1",
      "SESSION_DELETE_FAILED",
      true,
    );
    expect(alert).toHaveBeenCalledWith({
      jobType: "delete_session",
      jobId: sessionId,
      userId: ownerUserId,
      sessionId,
      attempts: 11,
      maxAttempts: 10,
      errorCode: "SESSION_DELETE_FAILED",
    });
  });
});

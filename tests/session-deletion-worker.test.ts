import { describe, expect, it, vi } from "vitest";
import type { ArkSession } from "../packages/ark-client/src/index.js";
import {
  SessionDeletionProcessor,
  type SessionDeletionJob,
} from "../apps/worker/src/session-deletion.js";

const sessionId = "00000000-0000-4000-8000-000000000001";
const ownerUserId = "00000000-0000-4000-8000-000000000002";
const timestamp = new Date("2026-09-06T00:00:00.000Z");

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
  const processor = new SessionDeletionProcessor({
    jobs,
    repository,
    ark,
    workerId: "worker-1",
    now: () => timestamp,
  });
  return { processor, jobs, repository, ark, order };
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
      })
      .mockResolvedValueOnce({
        id: "ark-session-1",
        agentId: "agent-1",
        agentVersion: 1,
        environmentId: "environment-1",
        status: "idle",
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
      "ark-delete",
      "checkpoint:interruptRequested,nonRunningObserved,arkDeleted",
      "orphan",
      "checkpoint:interruptRequested,nonRunningObserved,arkDeleted,artifactsOrphaned",
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

  it("emits a structured alert on terminal deletion failure", async () => {
    const alert = vi.fn();
    const state = setup({
      payload: {
        sessionId,
        completed: {
          nonRunningObserved: true,
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
            arkDeleted: true,
          },
        },
      }),
    ]);

    const processor = new SessionDeletionProcessor({
      jobs: state.jobs,
      repository: state.repository,
      ark: state.ark,
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

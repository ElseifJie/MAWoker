import { describe, expect, it, vi } from "vitest";
import { SessionHistoryProcessor } from "../apps/worker/src/session-history.js";
import { runProductionWorkerPoll } from "../apps/worker/src/poll.js";

describe("background history scanner", () => {
  it("bounds unresponsive initial database selection without calling upstream", async () => {
    let signal: AbortSignal | undefined;
    const listHistoryReconcilable = vi.fn(
      async (input: { signal?: AbortSignal }) => {
        signal = input.signal;
        return new Promise<never>(() => {});
      },
    );
    const reconcileHistory = vi.fn(async () => []);
    const reportError = vi.fn();
    const processor = new SessionHistoryProcessor({
      repository: { listHistoryReconcilable, finishHistoryAttempt: vi.fn() },
      service: { reconcileHistory },
      workerId: "selection-timeout",
      requestTimeoutMs: 10,
      reportError,
    });
    expect(
      await Promise.race([
        processor.runOnce(),
        new Promise((resolve) => setTimeout(() => resolve("blocked"), 100)),
      ]),
    ).toBe(0);
    expect(signal?.aborted).toBe(true);
    expect(reconcileHistory).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      "Session history selection failed",
      expect.any(Error),
    );
  });

  it("does not record success when an aborted service resolves cooperatively", async () => {
    const NativeAbortController = AbortController;
    const controller = new AbortController();
    let constructed = 0;
    const constructor = vi
      .spyOn(globalThis, "AbortController")
      .mockImplementation(() => {
        return ++constructed === 2 ? controller : new NativeAbortController();
      });
    const repository = {
      listHistoryReconcilable: vi.fn(async () => [
        { sessionId: "aborted", ownerUserId: "owner", arkSessionId: "ark" },
      ]),
      finishHistoryAttempt: vi.fn(async () => {}),
    };
    const processor = new SessionHistoryProcessor({
      repository,
      service: {
        reconcileHistory: vi.fn(async (_id, _context, signal) => {
          controller.abort();
          expect(signal!.aborted).toBe(true);
          return [];
        }),
      },
      workerId: "aborted",
      reportError: vi.fn(),
    });
    try {
      expect(await processor.runOnce()).toBe(1);
      expect(repository.finishHistoryAttempt).toHaveBeenCalledWith(
        "owner",
        "aborted",
        expect.objectContaining({ succeeded: false }),
      );
    } finally {
      constructor.mockRestore();
    }
  });

  it("bounds a stalled database scheduling write and continues the batch", async () => {
    const repository = {
      listHistoryReconcilable: vi.fn(async () => [
        { sessionId: "held-db", ownerUserId: "owner", arkSessionId: "held-db" },
        { sessionId: "next-db", ownerUserId: "owner", arkSessionId: "next-db" },
      ]),
      finishHistoryAttempt: vi.fn(async (_owner: string, id: string) => {
        if (id === "held-db") return new Promise<void>(() => {});
      }),
    };
    const reconcileHistory = vi.fn(async () => []);
    const processor = new SessionHistoryProcessor({
      repository,
      service: { reconcileHistory },
      workerId: "db-timeout",
      requestTimeoutMs: 10,
      reportError: vi.fn(),
    });
    expect(
      await Promise.race([
        processor.runOnce(),
        new Promise((resolve) => setTimeout(() => resolve("blocked"), 100)),
      ]),
    ).toBe(2);
    expect(reconcileHistory).toHaveBeenCalledTimes(2);
  });

  it("does not let an unresponsive upstream session block the remaining batch", async () => {
    const repository = {
      listHistoryReconcilable: vi.fn(async () => [
        { sessionId: "hung", ownerUserId: "owner", arkSessionId: "hung" },
        { sessionId: "next", ownerUserId: "owner", arkSessionId: "next" },
      ]),
      finishHistoryAttempt: vi.fn(async () => {}),
    };
    const reconcileHistory = vi.fn(async (id: string) => {
      if (id === "hung") return new Promise<never>(() => {});
      return [];
    });
    const processor = new SessionHistoryProcessor({
      repository,
      service: { reconcileHistory },
      workerId: "timeout",
      requestTimeoutMs: 10,
      reportError: vi.fn(),
    });
    const result = await Promise.race([
      processor.runOnce(),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 100)),
    ]);
    expect(result).toBe(2);
    expect(reconcileHistory).toHaveBeenCalledTimes(2);
  });

  it("uses a bounded fair repository schedule and continues after a timed out session", async () => {
    const finishHistoryAttempt = vi.fn(async () => {});
    const listHistoryReconcilable = vi.fn(async () => [
      { sessionId: "slow", ownerUserId: "owner", arkSessionId: "ark-slow" },
      { sessionId: "old-idle", ownerUserId: "owner", arkSessionId: "ark-old" },
    ]);
    const reconcileHistory = vi.fn(
      async (id: string, _context: unknown, signal: AbortSignal) => {
        if (id === "slow")
          await new Promise((_resolve, reject) =>
            signal.addEventListener(
              "abort",
              () => reject(new Error("timeout")),
              { once: true },
            ),
          );
        return [];
      },
    );
    const processor = new SessionHistoryProcessor({
      repository: { listHistoryReconcilable, finishHistoryAttempt },
      service: { reconcileHistory },
      workerId: "worker",
      batchSize: 99,
      requestTimeoutMs: 10,
      cooldownMs: 1000,
      reportError: vi.fn(),
    });
    expect(await processor.runOnce()).toBe(2);
    expect(listHistoryReconcilable).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5, cooldownMs: 1000 }),
    );
    expect(reconcileHistory).toHaveBeenCalledTimes(2);
    expect(
      finishHistoryAttempt.mock.calls.map((call) => call[2].succeeded),
    ).toEqual([false, true]);
  });

  it("does no upstream work when disabled", async () => {
    const listHistoryReconcilable = vi.fn();
    const processor = new SessionHistoryProcessor({
      repository: { listHistoryReconcilable, finishHistoryAttempt: vi.fn() },
      service: { reconcileHistory: vi.fn() },
      workerId: "worker",
      enabled: false,
    });
    expect(await processor.runOnce()).toBe(0);
    expect(listHistoryReconcilable).not.toHaveBeenCalled();
  });

  it("wires history as an optional independent production processor", async () => {
    const runOnce = vi.fn(async () => 0);
    const base = { runOnce };
    const history = { runOnce: vi.fn(async () => 1) };
    await runProductionWorkerPoll({
      personalAgent: base,
      session: base,
      sessionDeletion: base,
      usage: base,
      quotaInterrupt: base,
      uploadCleanup: base,
      artifactDeletion: base,
      artifactCleanup: base,
      driveCleanup: base,
      driveOrphanGc: base,
      history,
    });
    expect(history.runOnce).toHaveBeenCalledOnce();
  });
});

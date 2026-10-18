import { describe, expect, it, vi } from "vitest";
import type { ArkEvent } from "../packages/ark-client/src/index.js";
import { createHistoryScanCoordinator } from "../apps/worker/src/history-scan-coordinator.js";

const context = { userId: "owner", requestId: "request" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("history scan coordinator", () => {
  it("coalesces concurrent delivery and repair scans into one upstream read", async () => {
    const gate = deferred<ArkEvent[]>();
    const reconcileHistory = vi.fn(() => gate.promise);
    const coordinator = createHistoryScanCoordinator({ reconcileHistory });

    const delivery = coordinator.reconcileHistory("session", {
      ...context,
      requestId: "delivery",
    });
    const repair = coordinator.reconcileHistory("session", {
      ...context,
      requestId: "repair",
    });

    expect(reconcileHistory).toHaveBeenCalledTimes(1);
    gate.resolve([]);
    await expect(delivery).resolves.toEqual([]);
    await expect(repair).resolves.toEqual([]);
  });

  it("starts a new scan after the shared one settles", async () => {
    const reconcileHistory = vi.fn(async () => []);
    const coordinator = createHistoryScanCoordinator({ reconcileHistory });

    await coordinator.reconcileHistory("session", context);
    await coordinator.reconcileHistory("session", context);

    expect(reconcileHistory).toHaveBeenCalledTimes(2);
  });

  it("does not share a scan across sessions or owners", async () => {
    const gate = deferred<ArkEvent[]>();
    const reconcileHistory = vi.fn(() => gate.promise);
    const coordinator = createHistoryScanCoordinator({ reconcileHistory });

    const one = coordinator.reconcileHistory("session-a", context);
    const two = coordinator.reconcileHistory("session-b", context);
    const three = coordinator.reconcileHistory("session-a", {
      ...context,
      userId: "other-owner",
    });

    expect(reconcileHistory).toHaveBeenCalledTimes(3);
    gate.resolve([]);
    await expect(Promise.all([one, two, three])).resolves.toEqual([[], [], []]);
  });

  it("keeps the shared scan alive while another caller still waits", async () => {
    const gate = deferred<ArkEvent[]>();
    let scanSignal: AbortSignal | undefined;
    const reconcileHistory = vi.fn(
      (_id: string, _context: typeof context, signal?: AbortSignal) => {
        scanSignal = signal;
        return gate.promise;
      },
    );
    const coordinator = createHistoryScanCoordinator({ reconcileHistory });
    const delivery = coordinator.reconcileHistory("session", context);
    const controller = new AbortController();
    const repair = coordinator.reconcileHistory(
      "session",
      context,
      controller.signal,
    );

    controller.abort(new Error("repair timed out"));
    await expect(repair).rejects.toThrow("repair timed out");
    expect(scanSignal?.aborted).toBe(false);

    gate.resolve([]);
    await expect(delivery).resolves.toEqual([]);
    expect(scanSignal?.aborted).toBe(false);
  });

  it("aborts the shared scan once every caller has abandoned it", async () => {
    let calls = 0;
    let scanSignal: AbortSignal | undefined;
    const reconcileHistory = vi.fn(
      (
        _id: string,
        _context: typeof context,
        signal?: AbortSignal,
      ): Promise<ArkEvent[]> => {
        calls += 1;
        if (calls > 1) return Promise.resolve([]);
        scanSignal = signal;
        return new Promise<ArkEvent[]>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
    );
    const coordinator = createHistoryScanCoordinator({ reconcileHistory });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = coordinator.reconcileHistory(
      "session",
      context,
      firstController.signal,
    );
    const second = coordinator.reconcileHistory(
      "session",
      context,
      secondController.signal,
    );

    firstController.abort(new Error("first timed out"));
    secondController.abort(new Error("second timed out"));
    await expect(first).rejects.toThrow("first timed out");
    await expect(second).rejects.toThrow("second timed out");
    expect(scanSignal?.aborted).toBe(true);

    await expect(
      coordinator.reconcileHistory("session", context),
    ).resolves.toEqual([]);
    expect(reconcileHistory).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a failed scan", async () => {
    const reconcileHistory = vi
      .fn()
      .mockRejectedValueOnce(new Error("upstream down"))
      .mockResolvedValueOnce([]);
    const coordinator = createHistoryScanCoordinator({ reconcileHistory });

    await expect(
      coordinator.reconcileHistory("session", context),
    ).rejects.toThrow("upstream down");
    await expect(
      coordinator.reconcileHistory("session", context),
    ).resolves.toEqual([]);
    expect(reconcileHistory).toHaveBeenCalledTimes(2);
  });

  it("does not start a scan for an already aborted caller", async () => {
    const reconcileHistory = vi.fn(async () => []);
    const coordinator = createHistoryScanCoordinator({ reconcileHistory });
    const controller = new AbortController();

    controller.abort(new Error("cancelled"));
    await expect(
      coordinator.reconcileHistory("session", context, controller.signal),
    ).rejects.toThrow("cancelled");
    expect(reconcileHistory).not.toHaveBeenCalled();
  });
});

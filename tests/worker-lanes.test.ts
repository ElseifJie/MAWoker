import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runWorkerLaneProcessors,
  startWorkerLanes,
} from "../apps/worker/src/lanes.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("worker lanes", () => {
  it("continues a lane after one processor fails and reports it", async () => {
    const reportError = vi.fn();
    const first = {
      runOnce: vi.fn(async () => {
        throw new Error("cleanup unavailable");
      }),
    };
    const second = { runOnce: vi.fn(async () => 1) };

    const result = await runWorkerLaneProcessors(
      [first, second],
      reportError,
      "maintenance",
    );

    expect(result).toEqual({ processed: 1, failures: 1 });
    expect(second.runOnce).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledWith(
      'Worker lane "maintenance" processor failed',
      expect.objectContaining({ message: "cleanup unavailable" }),
    );
  });

  it("runs lanes on independent intervals without waiting for slower lanes", async () => {
    vi.useFakeTimers();
    const fast = { runOnce: vi.fn(async () => 0) };
    const slow = { runOnce: vi.fn(async () => 0) };
    const scheduler = startWorkerLanes({
      reportError: vi.fn(),
      lanes: [
        { name: "realtime", intervalMs: 100, processors: [fast] },
        { name: "maintenance", intervalMs: 1_000, processors: [slow] },
      ],
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(fast.runOnce).toHaveBeenCalledTimes(1);
    expect(slow.runOnce).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(300);
    expect(fast.runOnce).toHaveBeenCalledTimes(4);
    expect(slow.runOnce).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(700);
    expect(fast.runOnce).toHaveBeenCalledTimes(11);
    expect(slow.runOnce).toHaveBeenCalledTimes(2);

    const statuses = scheduler.statuses();
    expect(statuses).toEqual([
      expect.objectContaining({ name: "realtime", runs: 11, failures: 0 }),
      expect.objectContaining({ name: "maintenance", runs: 2, failures: 0 }),
    ]);

    scheduler.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fast.runOnce).toHaveBeenCalledTimes(11);
  });

  it("counts failures per lane and keeps other lanes running", async () => {
    vi.useFakeTimers();
    const broken = {
      runOnce: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    const healthy = { runOnce: vi.fn(async () => 1) };
    const reportError = vi.fn();
    const scheduler = startWorkerLanes({
      reportError,
      lanes: [
        { name: "broken", intervalMs: 1_000, processors: [broken] },
        { name: "healthy", intervalMs: 1_000, processors: [healthy] },
      ],
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(reportError).toHaveBeenCalledTimes(2);
    expect(healthy.runOnce).toHaveBeenCalledTimes(2);
    expect(scheduler.statuses()).toEqual([
      expect.objectContaining({ name: "broken", failures: 2 }),
      expect.objectContaining({ name: "healthy", failures: 0 }),
    ]);
    scheduler.stop();
  });
});

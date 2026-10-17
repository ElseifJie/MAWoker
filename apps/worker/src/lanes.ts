import type { WorkerProcessor } from "./poll.js";

export interface WorkerLaneDefinition {
  name: string;
  intervalMs: number;
  processors: readonly WorkerProcessor[];
}

export interface WorkerLaneStatus {
  name: string;
  intervalMs: number;
  runs: number;
  failures: number;
  lastRunAt: Date | null;
}

export interface LaneScheduler {
  stop(): void;
  statuses(): WorkerLaneStatus[];
}

/**
 * Runs one lane's processors sequentially. A failure is reported and the lane
 * moves on: a broken cleanup must not stop accounting or delivery work.
 */
export async function runWorkerLaneProcessors(
  processors: readonly WorkerProcessor[],
  reportError: (message: string, error: unknown) => void,
  laneName = "lane",
): Promise<{ processed: number; failures: number }> {
  let processed = 0;
  let failures = 0;
  for (const processor of processors) {
    try {
      await processor.runOnce();
      processed += 1;
    } catch (error) {
      failures += 1;
      reportError(`Worker lane "${laneName}" processor failed`, error);
    }
  }
  return { processed, failures };
}

/**
 * Independent lane timers. Each lane has its own `running` guard, so a slow
 * maintenance pass cannot delay realtime session delivery: it only skips its
 * own next tick. `unref` keeps the timers from holding the process open.
 */
export function startWorkerLanes(input: {
  lanes: readonly WorkerLaneDefinition[];
  reportError: (message: string, error: unknown) => void;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  onStatus?: (status: WorkerLaneStatus) => void;
}): LaneScheduler {
  const setTimer = input.setInterval ?? setInterval;
  const clearTimer = input.clearInterval ?? clearInterval;
  const timers: ReturnType<typeof setInterval>[] = [];
  const running = new Set<string>();
  const statuses: WorkerLaneStatus[] = input.lanes.map((lane) => ({
    name: lane.name,
    intervalMs: lane.intervalMs,
    runs: 0,
    failures: 0,
    lastRunAt: null,
  }));

  const run = async (lane: WorkerLaneDefinition, status: WorkerLaneStatus) => {
    if (running.has(lane.name)) return;
    running.add(lane.name);
    try {
      const result = await runWorkerLaneProcessors(
        lane.processors,
        input.reportError,
        lane.name,
      );
      status.runs += 1;
      status.failures += result.failures;
      status.lastRunAt = new Date();
      input.onStatus?.({ ...status });
    } finally {
      running.delete(lane.name);
    }
  };

  for (const [index, lane] of input.lanes.entries()) {
    const status = statuses[index]!;
    const timer = setTimer(() => void run(lane, status), lane.intervalMs);
    timer.unref?.();
    timers.push(timer);
    void run(lane, status);
  }

  return {
    stop() {
      for (const timer of timers) clearTimer(timer);
      timers.length = 0;
    },
    statuses() {
      return statuses.map((status) => ({ ...status }));
    },
  };
}

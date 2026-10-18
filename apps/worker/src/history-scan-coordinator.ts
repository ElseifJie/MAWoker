import type { ArkEvent } from "@pwa/ark-client";
import type { SessionService } from "@pwa/domain";

type HistoryService = Pick<SessionService, "reconcileHistory">;
type ReconcileHistory = HistoryService["reconcileHistory"];

interface SharedScan {
  controller: AbortController;
  promise: Promise<ArkEvent[]>;
  waiters: number;
  settled: boolean;
}

/**
 * Delivery discovery and periodic history repair both need a fresh upstream
 * snapshot for the same Session. Running both scans concurrently makes one
 * scan-generation supersede the other, so the loser reports
 * EVENT_HISTORY_REPAIR_PENDING even though the history is healthy.
 *
 * Coalesce the callers inside this Worker. Fencing by scan generation still
 * protects against other processes; this only removes the self-inflicted race
 * and the duplicate upstream work.
 *
 * A caller can abandon its own wait (its timeout), but the shared scan keeps
 * running while another caller still needs it and aborts only after every
 * caller has gone.
 */
export function createHistoryScanCoordinator(
  service: HistoryService,
): HistoryService {
  const scans = new Map<string, SharedScan>();

  const reconcileHistory: ReconcileHistory = async (id, context, signal) => {
    signal?.throwIfAborted();
    const key = `${context.userId}\u0000${id}`;
    let scan = scans.get(key);
    if (!scan) {
      const controller = new AbortController();
      const shared: SharedScan = {
        controller,
        promise: service.reconcileHistory(id, context, controller.signal),
        waiters: 0,
        settled: false,
      };
      scans.set(key, shared);
      scan = shared;
      // A scan must not become an unhandled rejection when every waiter has
      // already abandoned it.
      shared.promise.catch(() => {});
      void shared.promise
        .finally(() => {
          shared.settled = true;
          if (scans.get(key) === shared) scans.delete(key);
        })
        .catch(() => {});
    }
    return waitForScan(scans, key, scan, signal);
  };

  return { reconcileHistory };
}

async function waitForScan(
  scans: Map<string, SharedScan>,
  key: string,
  scan: SharedScan,
  signal: AbortSignal | undefined,
): Promise<ArkEvent[]> {
  if (signal?.aborted) throw signal.reason;
  scan.waiters += 1;
  let onAbort: (() => void) | undefined;
  try {
    if (!signal) return await scan.promise;
    return await new Promise<ArkEvent[]>((resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      scan.promise.then(resolve, reject);
    });
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    scan.waiters -= 1;
    if (scan.waiters === 0 && !scan.settled) {
      scan.controller.abort();
      // Do not pin a later caller to a scan every waiter has abandoned.
      if (scans.get(key) === scan) scans.delete(key);
    }
  }
}

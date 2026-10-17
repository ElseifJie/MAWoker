import { projectUiEvent, type UiEvent } from "@pwa/contracts";

export interface StoredEventRow {
  eventId: string;
  sourceType: string;
  occurredAt: Date;
  payload: Record<string, unknown>;
  localSequence?: string;
}

export interface StoredEventReader {
  listEventsAfter(
    userId: string,
    id: string,
    after: string,
    limit: number,
  ): PromiseLike<StoredEventRow[]>;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Reads the persisted event log after a local sequence and polls for new rows.
 * It never calls the upstream runtime: this is the `EVENT_SOURCE=local` path,
 * and the worker ingestor is the only writer.
 */
export async function* streamStoredEvents(input: {
  reader: StoredEventReader;
  userId: string;
  sessionId: string;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  initialCursor?: string;
  batchSize?: number;
}): AsyncIterable<UiEvent> {
  let cursor = input.initialCursor ?? "0";
  const pollIntervalMs = Math.max(10, input.pollIntervalMs ?? 500);
  const batchSize = Math.max(1, Math.min(input.batchSize ?? 100, 500));
  while (!input.signal?.aborted) {
    const batch = await input.reader.listEventsAfter(
      input.userId,
      input.sessionId,
      cursor,
      batchSize,
    );
    if (batch.length === 0) {
      await delay(pollIntervalMs, input.signal);
      continue;
    }
    for (const row of batch) {
      if (input.signal?.aborted) return;
      if (row.localSequence !== undefined) cursor = row.localSequence;
      yield projectUiEvent({
        id: row.eventId,
        sourceType: row.sourceType,
        type: "unknown",
        createdAt: row.occurredAt.toISOString(),
        payload: row.payload,
      });
    }
  }
}

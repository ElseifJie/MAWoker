import { describe, expect, it, vi } from "vitest";
import { EventIngestorProcessor } from "../apps/worker/src/event-ingestor.js";

function harness(
  overrides: {
    enabled?: boolean;
    claim?: () => Promise<
      { generation: number; lastEventId: string | null } | undefined
    >;
    openEvents?: () => Promise<{
      session: unknown;
      events: AsyncIterable<{ id: string }>;
    }>;
  } = {},
) {
  const repository = {
    listCandidates: vi.fn(async () => [
      { sessionId: "session-1", ownerUserId: "user-1" },
    ]),
    claim: vi.fn(
      overrides.claim ?? (async () => ({ generation: 1, lastEventId: null })),
    ),
    checkpoint: vi.fn(async () => true),
    release: vi.fn(async () => undefined),
  };
  const sessions = {
    openEvents: vi.fn(
      overrides.openEvents ??
        (async () => ({
          session: {},
          events: (async function* () {
            yield { id: "event-1" };
            yield { id: "event-2" };
          })(),
        })),
    ),
  };
  return {
    repository,
    sessions,
    processor: new EventIngestorProcessor({
      repository,
      sessions,
      workerId: "ingestor-1",
      enabled: overrides.enabled ?? true,
      leaseMs: 30_000,
      budgetMs: 1_000,
      batchSize: 2,
      maxEvents: 10,
      now: () => new Date("2026-10-17T00:00:00.000Z"),
    }),
  };
}

describe("EventIngestorProcessor", () => {
  it("claims a Session, drains its stream, and checkpoints the last event", async () => {
    const { processor, repository, sessions } = harness();

    await expect(processor.runOnce()).resolves.toBe(2);

    expect(sessions.openEvents).toHaveBeenCalledWith(
      "session-1",
      { userId: "user-1", requestId: "event-ingest:session-1:1" },
      expect.any(AbortSignal),
    );
    expect(repository.checkpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        consumerId: "ingestor-1",
        generation: 1,
        lastEventId: "event-2",
      }),
    );
    expect(repository.release).not.toHaveBeenCalled();
  });

  it("does nothing when the shadow flag is off", async () => {
    const { processor, repository, sessions } = harness({ enabled: false });

    await expect(processor.runOnce()).resolves.toBe(0);
    expect(repository.listCandidates).not.toHaveBeenCalled();
    expect(sessions.openEvents).not.toHaveBeenCalled();
  });

  it("skips a Session whose lease belongs to another consumer", async () => {
    const { processor, repository, sessions } = harness({
      claim: async () => undefined,
    });

    await expect(processor.runOnce()).resolves.toBe(0);
    expect(sessions.openEvents).not.toHaveBeenCalled();
    expect(repository.checkpoint).not.toHaveBeenCalled();
  });

  it("releases the lease when opening the upstream stream fails", async () => {
    const { processor, repository } = harness({
      openEvents: async () => {
        throw new Error("upstream unavailable");
      },
    });

    await expect(processor.runOnce()).resolves.toBe(0);
    expect(repository.release).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        consumerId: "ingestor-1",
        generation: 1,
        errorCode: "EVENT_INGEST_FAILED",
      }),
    );
    expect(repository.checkpoint).not.toHaveBeenCalled();
  });
});

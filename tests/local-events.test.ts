import { describe, expect, it, vi } from "vitest";
import {
  SessionService,
  streamStoredEvents,
  type SessionRecord,
  type SessionRepository,
} from "../packages/domain/src/index.js";

function row(sequence: string, id = `event-${sequence}`) {
  return {
    eventId: id,
    sourceType: "agent.message",
    occurredAt: new Date(`2026-10-17T00:00:0${sequence}.000Z`),
    payload: { content: `content-${sequence}` },
    localSequence: sequence,
  };
}

describe("streamStoredEvents", () => {
  it("replays stored rows after a cursor and then polls for new ones", async () => {
    const reader = {
      listEventsAfter: vi.fn(
        async (_userId: string, _id: string, after: string) => {
          if (after === "0") return [row("1"), row("2")];
          if (after === "2") return [row("3")];
          return [];
        },
      ),
    };
    const controller = new AbortController();
    const iterator = streamStoredEvents({
      reader,
      userId: "user-1",
      sessionId: "session-1",
      signal: controller.signal,
      pollIntervalMs: 10,
    })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { id: "event-1", type: "message" },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { id: "event-2", type: "message" },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { id: "event-3", type: "message" },
    });
    expect(reader.listEventsAfter).toHaveBeenLastCalledWith(
      "user-1",
      "session-1",
      "2",
      100,
    );

    controller.abort();
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it("stops while waiting for the next poll when the client disconnects", async () => {
    const reader = {
      listEventsAfter: vi.fn(async () => []),
    };
    const controller = new AbortController();
    const iterator = streamStoredEvents({
      reader,
      userId: "user-1",
      sessionId: "session-1",
      signal: controller.signal,
      pollIntervalMs: 1_000,
    })[Symbol.asyncIterator]();

    const pending = iterator.next();
    controller.abort();
    await expect(pending).resolves.toMatchObject({ done: true });
  });
});

describe("SessionService.openStoredEvents", () => {
  it("serves the local log without opening an upstream stream", async () => {
    const session = {
      id: "session-1",
      ownerUserId: "user-1",
      arkSessionId: "ark-session-1",
    } as SessionRecord;
    const repository = {
      findOwned: vi.fn(async () => session),
      listEventsAfter: vi.fn(async () => [row("1")]),
    } as unknown as SessionRepository;
    const ark = { streamEvents: vi.fn() };
    const service = new SessionService({
      repository,
      agentResolver: {} as never,
      ark: ark as never,
      environmentId: "env-1",
      createId: () => "id",
    });

    const opened = await service.openStoredEvents(
      "session-1",
      { userId: "user-1", requestId: "request-1" },
      new AbortController().signal,
    );
    const iterator = opened.events[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { id: "event-1", type: "message" },
    });
    expect(ark.streamEvents).not.toHaveBeenCalled();
  });
});

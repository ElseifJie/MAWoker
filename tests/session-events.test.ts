import { describe, expect, it, vi } from "vitest";
import type { ArkEvent } from "../packages/contracts/src/index.js";
import {
  ResourceNotFoundError,
  SessionService,
  type SessionRecord,
  type SessionRepository,
} from "../packages/domain/src/index.js";

const userId = "00000000-0000-4000-8000-000000000001";
const sessionId = "00000000-0000-4000-8000-000000000003";
const now = new Date("2026-09-06T00:00:00.000Z");

function event(
  id: string,
  type: string,
  data: Record<string, unknown>,
): ArkEvent {
  return { id, type, data, createdAt: now.toISOString() };
}

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: sessionId,
    ownerUserId: userId,
    arkSessionId: "ark-session-1",
    agentKind: "personal",
    platformAgentId: null,
    personalAgentId: "00000000-0000-4000-8000-000000000002",
    arkAgentId: "ark-agent-1",
    agentName: "Research Agent",
    agentVersion: "7",
    environmentId: "environment-1",
    title: "Task",
    status: "idle",
    lastErrorCode: null,
    errorRecoverable: null,
    archivedAt: null,
    deletionState: "none",
    lastEventAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function baseRepository(record = session()) {
  return {
    prepareCreate: vi.fn(),
    completeCreate: vi.fn(),
    preserveCreateOutcome: vi.fn(),
    failCreate: vi.fn(),
    listOwned: vi.fn(async () => [record]),
    findOwned: vi.fn(async (ownerUserId: string, id: string) =>
      ownerUserId === userId && id === sessionId ? record : undefined,
    ),
    findCreateIntent: vi.fn(),
    setArchived: vi.fn(),
    beginDelete: vi.fn(),
    beginMessage: vi.fn(),
    finishMessage: vi.fn(),
    projectEvent: vi.fn(),
    audit: vi.fn(),
  } satisfies SessionRepository;
}

function createService(
  repository: ReturnType<typeof baseRepository>,
  ark: {
    listEvents: (
      id: string,
      options?: { signal?: AbortSignal },
    ) => Promise<ArkEvent[]>;
    streamEvents: (
      id: string,
      options?: { signal?: AbortSignal },
    ) => Promise<AsyncIterable<ArkEvent>>;
  },
) {
  return new SessionService({
    repository,
    agentResolver: {
      resolveForNewSession: vi.fn(),
    },
    ark: {
      createSession: vi.fn(),
      getSession: vi.fn(),
      submitEvent: vi.fn(),
      ...ark,
    },
    environmentId: "environment-1",
    createId: () => sessionId,
    now: () => now,
  });
}

async function collect(events: AsyncIterable<unknown>) {
  const collected = [];
  for await (const item of events) collected.push(item);
  return collected;
}

describe("Session event recovery", () => {
  it("projects internal usage spans without exposing them to the browser", async () => {
    const repository = baseRepository();
    const service = createService(repository, {
      async streamEvents() {
        return {
          async *[Symbol.asyncIterator]() {
            yield event("event-message", "agent.message", {
              content: "visible",
            });
          },
        };
      },
      async listEvents() {
        return [
          {
            id: "event-usage",
            type: "span.model_request_end",
            createdAt: "2026-08-31T23:59:59.999Z",
            data: {
              model_usage: { input_tokens: 11, output_tokens: 7 },
              internal: "must not leak",
            },
          },
        ];
      },
    });

    const opened = await service.openEvents(sessionId, {
      userId,
      requestId: "request-usage",
    });

    await expect(collect(opened.events)).resolves.toEqual([
      expect.objectContaining({ id: "event-message" }),
    ]);
    expect(repository.projectEvent).toHaveBeenNthCalledWith(
      1,
      userId,
      sessionId,
      {
        eventId: "event-usage",
        observedAt: new Date("2026-08-31T23:59:59.999Z"),
        metrics: [
          { metricType: "input_tokens", quantity: 11 },
          { metricType: "output_tokens", quantity: 7 },
        ],
      },
    );
  });

  it("opens and consumes live events before history, then emits an ordered deduplicated stream", async () => {
    const order: string[] = [];
    const history = [
      event("event-1", "agent.message", { content: "history" }),
      event("event-2", "agent.message", { content: "overlap" }),
    ];
    const live = [
      history[1]!,
      event("event-3", "agent.message", { content: "live" }),
      event("event-4", "session.status", { status: "terminated" }),
    ];
    const repository = baseRepository();
    const service = createService(repository, {
      async streamEvents() {
        order.push("stream-open");
        return {
          async *[Symbol.asyncIterator]() {
            order.push("stream-read");
            for (const item of live) yield item;
          },
        };
      },
      async listEvents() {
        order.push("history");
        return history;
      },
    });

    const opened = await service.openEvents(sessionId, {
      userId,
      requestId: "request-events",
    });

    expect(order.slice(0, 3)).toEqual([
      "stream-open",
      "stream-read",
      "history",
    ]);
    await expect(collect(opened.events)).resolves.toEqual([
      expect.objectContaining({ id: "event-1", sourceType: "agent.message" }),
      expect.objectContaining({ id: "event-2", sourceType: "agent.message" }),
      expect.objectContaining({ id: "event-3", sourceType: "agent.message" }),
      expect.objectContaining({
        id: "event-4",
        sourceType: "session.status",
        payload: { status: "terminated" },
      }),
    ]);
    expect(repository.projectEvent).toHaveBeenCalledTimes(4);
  });

  it("rejects foreign Sessions before opening Ark", async () => {
    const repository = baseRepository();
    repository.findOwned.mockResolvedValueOnce(undefined);
    const ark = {
      streamEvents: vi.fn(),
      listEvents: vi.fn(),
    };
    const service = createService(repository, ark as never);

    await expect(
      service.openEvents(sessionId, {
        userId: "00000000-0000-4000-8000-000000000099",
        requestId: "request-foreign",
      }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
    expect(ark.streamEvents).not.toHaveBeenCalled();
    expect(ark.listEvents).not.toHaveBeenCalled();
  });

  it("reconnects through complete history without duplicating live overlap", async () => {
    const repository = baseRepository();
    let connection = 0;
    const service = createService(repository, {
      async streamEvents() {
        connection += 1;
        const live =
          connection === 1
            ? [event("event-2", "agent.message", { content: "overlap" })]
            : [
                event("event-2", "agent.message", { content: "overlap" }),
                event("event-3", "session.status", { status: "terminated" }),
              ];
        return {
          async *[Symbol.asyncIterator]() {
            for (const item of live) yield item;
          },
        };
      },
      async listEvents() {
        return [
          event("event-1", "agent.message", { content: "history" }),
          event("event-2", "agent.message", { content: "overlap" }),
        ];
      },
    });

    const first = await service.openEvents(sessionId, {
      userId,
      requestId: "request-first",
    });
    const second = await service.openEvents(sessionId, {
      userId,
      requestId: "request-reconnect",
    });

    await expect(collect(first.events)).resolves.toMatchObject([
      { id: "event-1" },
      { id: "event-2" },
    ]);
    await expect(collect(second.events)).resolves.toMatchObject([
      { id: "event-1" },
      { id: "event-2" },
      { id: "event-3" },
    ]);
  });

  it("cancels and releases the upstream iterator when the downstream closes", async () => {
    let released = false;
    const repository = baseRepository();
    const service = createService(repository, {
      async streamEvents(_id, options) {
        return {
          async *[Symbol.asyncIterator]() {
            try {
              yield event("event-1", "agent.message", { content: "live" });
              await new Promise<void>((resolve) => {
                options?.signal?.addEventListener("abort", () => resolve(), {
                  once: true,
                });
              });
            } finally {
              released = true;
            }
          },
        };
      },
      async listEvents() {
        return [];
      },
    });
    const controller = new AbortController();
    const opened = await service.openEvents(
      sessionId,
      { userId, requestId: "request-cancel" },
      controller.signal,
    );
    const iterator = opened.events[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      value: { id: "event-1" },
    });
    controller.abort();
    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(released).toBe(true);
  });

  it("projects running, rescheduled, running, and idle in event order", async () => {
    const repository = baseRepository();
    const statuses = ["running", "rescheduled", "running", "idle"] as const;
    const service = createService(repository, {
      async streamEvents() {
        return {
          async *[Symbol.asyncIterator]() {
            for (const [index, status] of statuses.entries()) {
              yield event(`event-${index + 1}`, "session.status", { status });
            }
          },
        };
      },
      async listEvents() {
        return [];
      },
    });

    const opened = await service.openEvents(sessionId, {
      userId,
      requestId: "request-status",
    });
    await collect(opened.events);

    expect(repository.projectEvent.mock.calls.map((call) => call[2])).toEqual(
      statuses.map((status, index) =>
        expect.objectContaining({
          eventId: `event-${index + 1}`,
          status,
        }),
      ),
    );
  });

  it("projects activity and recoverable/nonrecoverable errors without exposing thinking text", async () => {
    const repository = baseRepository();
    const service = createService(repository, {
      async streamEvents() {
        return {
          async *[Symbol.asyncIterator]() {
            yield event("event-1", "agent.thinking", {
              content: "private reasoning",
            });
            yield event("event-2", "agent.tool_use", {
              name: "bash",
              input: {
                command:
                  "curl -H 'Authorization: Bearer abc.def.ghi' https://api.example.com/prices",
                description: "抓取价格快照",
              },
              evaluated_permission: "allow",
            });
            yield event("event-3", "session.error", {
              code: "TEMPORARY",
              message: "Retrying",
              recoverable: true,
            });
            yield event("event-4", "session.error", {
              code: "FAILED",
              message: "Stopped",
              recoverable: false,
            });
          },
        };
      },
      async listEvents() {
        return [];
      },
    });

    const opened = await service.openEvents(sessionId, {
      userId,
      requestId: "request-projection",
    });
    const events = await collect(opened.events);

    expect(events[0]).toMatchObject({ type: "thinking", payload: {} });
    expect(JSON.stringify(events)).not.toContain("private reasoning");
    expect(events[1]).toMatchObject({
      type: "tool_use",
      payload: { callId: "event-2", name: "bash", argsSummary: "抓取价格快照" },
    });
    expect(JSON.stringify(events[1])).not.toContain("abc.def.ghi");
    expect(JSON.stringify(events[1])).not.toContain("evaluated_permission");
    expect(repository.projectEvent).toHaveBeenNthCalledWith(
      3,
      userId,
      sessionId,
      expect.objectContaining({
        status: "rescheduled",
        errorCode: "TEMPORARY",
        errorRecoverable: true,
      }),
    );
    expect(repository.projectEvent).toHaveBeenNthCalledWith(
      4,
      userId,
      sessionId,
      expect.objectContaining({
        status: "terminated",
        errorCode: "FAILED",
        errorRecoverable: false,
      }),
    );
  });

  it("keeps streaming after any recoverable session.error variant", async () => {
    const repository = baseRepository();
    const service = createService(repository, {
      async streamEvents() {
        return {
          async *[Symbol.asyncIterator]() {
            yield event("event-1", "session.error", {
              code: "TEMPORARY",
              message: "Retrying",
              recoverable: false,
              retryable: true,
            });
            yield event("event-2", "agent.message", {
              content: "Recovered",
            });
            yield event("event-3", "session.status", { status: "idle" });
          },
        };
      },
      async listEvents() {
        return [];
      },
    });

    const opened = await service.openEvents(sessionId, {
      userId,
      requestId: "request-retryable-error",
    });
    const events = await collect(opened.events);

    expect(events).toMatchObject([
      {
        id: "event-1",
        type: "error",
        payload: { code: "TEMPORARY", recoverable: true },
      },
      {
        id: "event-2",
        type: "message",
        payload: { content: "Recovered" },
      },
      {
        id: "event-3",
        type: "status",
        payload: { status: "idle" },
      },
    ]);
    expect(repository.projectEvent).toHaveBeenNthCalledWith(
      1,
      userId,
      sessionId,
      expect.objectContaining({
        status: "rescheduled",
        errorRecoverable: true,
      }),
    );
    expect(repository.projectEvent).toHaveBeenNthCalledWith(
      3,
      userId,
      sessionId,
      expect.objectContaining({ status: "idle" }),
    );
  });

  it("bounds live buffering while history is pending and resumes without loss", async () => {
    let resolveHistory!: (events: ArkEvent[]) => void;
    const history = new Promise<ArkEvent[]>((resolve) => {
      resolveHistory = resolve;
    });
    let produced = 0;
    const repository = baseRepository();
    const service = createService(repository, {
      async streamEvents() {
        return {
          async *[Symbol.asyncIterator]() {
            for (let index = 1; index <= 101; index += 1) {
              produced += 1;
              yield event(`event-${index}`, "agent.message", {
                content: `message-${index}`,
              });
            }
            produced += 1;
            yield event("event-102", "session.status", {
              status: "terminated",
            });
          },
        };
      },
      async listEvents() {
        return history;
      },
    });

    const opened = await service.openEvents(sessionId, {
      userId,
      requestId: "request-bounded-buffer",
    });
    const iterator = opened.events[Symbol.asyncIterator]();
    const first = iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(produced).toBeGreaterThan(0);
    expect(produced).toBeLessThanOrEqual(100);

    resolveHistory([]);
    const events = [];
    let next = await first;
    while (!next.done) {
      events.push(next.value);
      next = await iterator.next();
    }

    expect(events).toHaveLength(102);
    expect(events.at(-1)).toMatchObject({
      id: "event-102",
      payload: { status: "terminated" },
    });
  });

  it("cancels a producer blocked by a full live buffer", async () => {
    let produced = 0;
    let released = false;
    const repository = baseRepository();
    const service = createService(repository, {
      async streamEvents() {
        return {
          async *[Symbol.asyncIterator]() {
            try {
              for (let index = 1; index <= 1_000; index += 1) {
                produced += 1;
                yield event(`event-${index}`, "agent.message", {
                  content: `message-${index}`,
                });
              }
            } finally {
              released = true;
            }
          },
        };
      },
      async listEvents(_id, options) {
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) {
            resolve();
            return;
          }
          options?.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        return [];
      },
    });
    const controller = new AbortController();
    const opened = await service.openEvents(
      sessionId,
      { userId, requestId: "request-full-buffer-cancel" },
      controller.signal,
    );
    const iterator = opened.events[Symbol.asyncIterator]();
    const pending = iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 25));

    controller.abort();

    await expect(pending).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(produced).toBeLessThanOrEqual(100);
    expect(released).toBe(true);
  });
});

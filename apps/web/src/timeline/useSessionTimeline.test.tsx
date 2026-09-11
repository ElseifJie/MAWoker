// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionEventNames, useSessionTimeline } from "./useSessionTimeline.js";

class MockEventSource {
  static instances: MockEventSource[] = [];
  readonly listeners = new Map<string, Set<EventListener>>();
  readonly url: string;
  readonly withCredentials: boolean;
  closed = false;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string | URL, options?: EventSourceInit) {
    this.url = String(url);
    this.withCredentials = options?.withCredentials ?? false;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const callback =
      typeof listener === "function"
        ? listener
        : (event: Event) => listener.handleEvent(event);
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(callback);
    this.listeners.set(type, listeners);
  }

  close() {
    this.closed = true;
  }

  emitOpen() {
    this.onopen?.(new Event("open"));
  }

  emitError() {
    this.onerror?.(new Event("error"));
  }

  emit(name: string, data: unknown) {
    const event = new MessageEvent(name, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }

  emitRaw(name: string, data: string) {
    const event = new MessageEvent(name, { data });
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
}

const sessionId = "00000000-0000-4000-8000-00000000000a";

function render(options?: { enabled?: boolean; onInvalidEvent?: () => void }) {
  const onStreamReady = vi.fn();
  const hook = renderHook(() =>
    useSessionTimeline({
      sessionId,
      enabled: options?.enabled ?? true,
      onStreamReady,
      ...(options?.onInvalidEvent
        ? { onInvalidEvent: options.onInvalidEvent }
        : {}),
    }),
  );
  const source = MockEventSource.instances.at(-1)!;
  return { ...hook, source, onStreamReady };
}

beforeEach(() => {
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", MockEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useSessionTimeline", () => {
  it("opens a credentialed stream and subscribes to every Ark event name", () => {
    const { source } = render();

    expect(source.url).toBe(`/api/v1/sessions/${sessionId}/events`);
    expect(source.withCredentials).toBe(true);
    for (const name of sessionEventNames) {
      expect(source.listeners.has(name), name).toBe(true);
    }
    expect(source.listeners.has("ready")).toBe(true);
  });

  it("does not open a stream until enabled", () => {
    render({ enabled: false });

    expect(MockEventSource.instances).toHaveLength(0);
  });

  it("reports stream readiness so the first message can be delivered", () => {
    const { source, onStreamReady } = render();

    act(() => source.emitOpen());

    expect(onStreamReady).toHaveBeenCalledWith(sessionId);
  });

  it("adopts the authoritative status from the ready frame before any event", () => {
    const { source, result } = render();

    act(() => {
      source.emitOpen();
      source.emit("ready", {
        sessionId,
        status: "running",
        agentName: "Research",
        agentVersion: "7",
      });
    });

    expect(result.current.status).toBe("running");
    expect(result.current.connection).toBe("live");
    expect(result.current.items).toHaveLength(0);
  });

  it("ignores a ready frame whose status is not a known session status", () => {
    const { source, result } = render();

    act(() =>
      source.emit("ready", { sessionId, status: "paused", agentName: "R" }),
    );

    expect(result.current.status).toBeUndefined();
  });

  it("lets a replayed status event correct the ready snapshot", () => {
    const { source, result } = render();

    act(() => {
      source.emit("ready", { sessionId, status: "running", agentName: "R" });
      source.emit("session.status_idle", {
        id: "evt-idle",
        sourceType: "session.status_idle",
        type: "status",
        createdAt: "2026-09-07T08:00:00.000Z",
        payload: { status: "idle" },
      });
    });

    expect(result.current.status).toBe("idle");
  });

  it("folds a tool call and its result into one item", () => {
    const { source, result } = render();

    act(() => {
      source.emit("agent.tool_use", {
        id: "call_1",
        sourceType: "agent.tool_use",
        type: "tool_use",
        createdAt: "2026-09-07T08:00:00.000Z",
        payload: { callId: "call_1", name: "read", argsSummary: "a.md" },
      });
    });
    expect(result.current.items).toEqual([
      {
        kind: "tool",
        id: "call_1",
        ts: "2026-09-07T08:00:00.000Z",
        callId: "call_1",
        name: "read",
        argsSummary: "a.md",
        status: "running",
      },
    ]);

    act(() => {
      source.emit("agent.tool_result", {
        id: "evt_result",
        sourceType: "agent.tool_result",
        type: "tool_result",
        createdAt: "2026-09-07T08:00:00.250Z",
        payload: { callId: "call_1", status: "ok", preview: "contents" },
      });
    });
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0]).toMatchObject({
      status: "ok",
      preview: "contents",
      durationMs: 250,
    });
  });

  it("neither loses nor duplicates events across a reconnect", () => {
    const { source, result } = render();
    const message = {
      id: "evt-1",
      sourceType: "agent.message",
      type: "message",
      createdAt: "2026-09-07T08:00:00.000Z",
      payload: { content: "Hello" },
    };

    act(() => {
      source.emitOpen();
      source.emit("agent.message", message);
    });
    act(() => source.emitError());
    expect(result.current.connection).toBe("reconnecting");

    // A reconnect replays history, which repeats events already folded.
    act(() => {
      source.emitOpen();
      source.emit("agent.message", message);
      source.emit("agent.message", { ...message, id: "evt-2" });
    });

    expect(result.current.items.map((item) => item.id)).toEqual([
      "evt-1",
      "evt-2",
    ]);
    expect(result.current.connection).toBe("live");
  });

  it("closes the stream once the Session terminates", () => {
    const { source, result } = render();

    act(() =>
      source.emit("session.status_terminated", {
        id: "evt-end",
        sourceType: "session.status_terminated",
        type: "status",
        createdAt: "2026-09-07T08:00:00.000Z",
        payload: { status: "terminated" },
      }),
    );

    expect(source.closed).toBe(true);
    expect(result.current.connection).toBe("ended");
    expect(result.current.status).toBe("terminated");
  });

  it("keeps the stream open for a recoverable error", () => {
    const { source, result } = render();

    act(() =>
      source.emit("session.error", {
        id: "evt-retry",
        sourceType: "session.error",
        type: "error",
        createdAt: "2026-09-07T08:00:00.000Z",
        payload: { code: "TEMPORARY", message: "Retrying", recoverable: true },
      }),
    );

    expect(source.closed).toBe(false);
    expect(result.current.connection).not.toBe("ended");
    expect(result.current.items[0]).toMatchObject({
      kind: "notice",
      tone: "warn",
      retriable: true,
    });
  });

  it("reports an unparseable frame and keeps the stream alive", () => {
    const onInvalidEvent = vi.fn();
    const { source, result } = render({ onInvalidEvent });

    act(() => source.emitRaw("agent.message", "{not json"));

    expect(onInvalidEvent).toHaveBeenCalledTimes(1);
    expect(source.closed).toBe(false);
    expect(result.current.items).toHaveLength(0);
  });

  it("silently ignores a well-formed frame with an unusable shape", () => {
    const onInvalidEvent = vi.fn();
    const { source, result } = render({ onInvalidEvent });

    act(() => source.emit("agent.message", { id: "evt-x" }));

    expect(onInvalidEvent).not.toHaveBeenCalled();
    expect(result.current.items).toHaveLength(0);
  });

  it("does not tear the stream down when the caller passes an inline handler", () => {
    const onStreamReady = vi.fn();
    const { rerender } = renderHook(
      ({ tick }: { tick: number }) =>
        useSessionTimeline({
          sessionId,
          enabled: true,
          onStreamReady,
          onInvalidEvent: () => void tick,
        }),
      { initialProps: { tick: 0 } },
    );

    rerender({ tick: 1 });
    rerender({ tick: 2 });

    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0]!.closed).toBe(false);
  });

  it("exposes derived message roles and the Agent task list", () => {
    const { source, result } = render();

    act(() => {
      source.emit("user.message", {
        id: "evt-user",
        sourceType: "user.message",
        type: "message",
        createdAt: "2026-09-07T08:00:00.000Z",
        payload: { content: "Compare the prices" },
      });
      source.emit("agent.tool_use", {
        id: "call_todo_1",
        sourceType: "agent.tool_use",
        type: "tool_use",
        createdAt: "2026-09-07T08:00:01.000Z",
        payload: {
          callId: "call_todo_1",
          name: "todo_write",
          todos: [
            { content: "Fetch prices", status: "completed" },
            { content: "Write the comparison", status: "in_progress" },
          ],
        },
      });
      source.emit("agent.message", {
        id: "evt-narration",
        sourceType: "agent.message",
        type: "message",
        createdAt: "2026-09-07T08:00:02.000Z",
        payload: { content: "Fetching now" },
      });
      source.emit("agent.message", {
        id: "evt-answer",
        sourceType: "agent.message",
        type: "message",
        createdAt: "2026-09-07T08:00:03.000Z",
        payload: { content: "Done" },
      });
      source.emit("session.status_idle", {
        id: "evt-idle",
        sourceType: "session.status_idle",
        type: "status",
        createdAt: "2026-09-07T08:00:04.000Z",
        payload: { status: "idle" },
      });
    });

    expect(result.current.todos).toEqual([
      { content: "Fetch prices", status: "completed" },
      { content: "Write the comparison", status: "in_progress" },
    ]);
    expect(result.current.roles.get("evt-narration")).toBe("narration");
    expect(result.current.roles.get("evt-answer")).toBe("answer");
  });

  it("closes the stream on unmount", () => {
    const { source, unmount } = render();

    unmount();

    expect(source.closed).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import type { UiEvent } from "../packages/contracts/src/index.js";
import { normalizeArkEvent } from "../packages/contracts/src/index.js";
import {
  currentTodos,
  foldEvents,
  initialTimeline,
  timelineReducer,
  type TimelineState,
} from "../apps/web/src/timeline/fold.js";
import type { Item } from "../apps/web/src/timeline/items.js";
import {
  arkFixtures,
  loadArkFixture,
  type ArkFixtureName,
} from "./support/ark-fixtures.js";

function uiEvent(partial: {
  id: string;
  sourceType: string;
  type: UiEvent["type"];
  createdAt?: string;
  payload?: Record<string, unknown>;
}): UiEvent {
  return {
    id: partial.id,
    sourceType: partial.sourceType,
    type: partial.type,
    createdAt: partial.createdAt ?? "2026-09-07T08:00:00.000Z",
    payload: partial.payload ?? {},
  };
}

function fold(events: readonly UiEvent[]): TimelineState {
  return foldEvents(events);
}

const fixtureNames = Object.keys(arkFixtures) as ArkFixtureName[];

function fixtureEvents(name: ArkFixtureName): UiEvent[] {
  // Mirrors what the API emits: normalized events, including the unwhitelisted
  // span.* and thread-status types that reach the browser with empty payloads.
  return loadArkFixture(name).map((event) => normalizeArkEvent(event));
}

describe("timeline fold over captured Ark traffic", () => {
  it.each(fixtureNames)("pairs every tool call in %s", (name) => {
    const events = fixtureEvents(name);
    const state = fold(events);
    const tools = state.items.filter(
      (item): item is Extract<Item, { kind: "tool" }> => item.kind === "tool",
    );
    const calls = events.filter((event) => event.type === "tool_use").length;

    expect(tools).toHaveLength(calls);
    expect(tools.every((tool) => tool.status !== "running")).toBe(true);
    // Ark has no duration field; it is derived from the paired timestamps.
    expect(tools.every((tool) => typeof tool.durationMs === "number")).toBe(
      true,
    );
    expect(state.seenEventIds.size).toBe(events.length);
  });

  it.each(fixtureNames)(
    "folds unwhitelisted events to nothing in %s",
    (name) => {
      const unmapped = fixtureEvents(name).filter(
        (event) => event.type === "unknown",
      );

      // span.* is filtered server-side, but session.thread_status_* and
      // session.deleted do reach the browser with an empty payload.
      expect(
        unmapped.some((event) =>
          event.sourceType.startsWith("session.thread_status"),
        ),
      ).toBe(true);
      expect(fold(unmapped).items).toHaveLength(0);
    },
  );

  it("surfaces the Agent task list from todo_write", () => {
    const state = fold(fixtureEvents("toolsetAndMcp"));
    const todos = currentTodos(state.items);

    expect(todos.length).toBeGreaterThan(0);
    for (const todo of todos) {
      expect(["pending", "in_progress", "completed"]).toContain(todo.status);
      expect(todo.content.length).toBeGreaterThan(0);
    }
  });

  it("reports the one captured failure as failed rather than ok", () => {
    const state = fold(fixtureEvents("multiMessageTurn"));
    const failed = state.items.filter(
      (item) => item.kind === "tool" && item.status === "failed",
    );

    expect(failed).toHaveLength(1);
  });

  it("keeps replaying the same history idempotent", () => {
    const events = fixtureEvents("basic");
    const once = fold(events);
    const twice = foldEvents(events, once);

    expect(twice.items).toEqual(once.items);
    expect(twice.status).toBe(once.status);
    expect(twice.seenEventIds.size).toBe(once.seenEventIds.size);
  });
});

describe("timeline fold", () => {
  it("merges a tool result into its call and keeps the call's identity", () => {
    const state = fold([
      uiEvent({
        id: "call_1",
        sourceType: "agent.tool_use",
        type: "tool_use",
        createdAt: "2026-09-07T08:00:00.000Z",
        payload: {
          callId: "call_1",
          name: "read",
          argsSummary: "/workspace/a.md",
        },
      }),
      uiEvent({
        id: "evt_result",
        sourceType: "agent.tool_result",
        type: "tool_result",
        createdAt: "2026-09-07T08:00:01.500Z",
        payload: { callId: "call_1", status: "ok", preview: "# Title" },
      }),
    ]);

    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toEqual({
      kind: "tool",
      id: "call_1",
      ts: "2026-09-07T08:00:00.000Z",
      callId: "call_1",
      name: "read",
      argsSummary: "/workspace/a.md",
      status: "ok",
      preview: "# Title",
      durationMs: 1500,
    });
  });

  it("appends an unmatched result instead of dropping it", () => {
    const state = fold([
      uiEvent({
        id: "evt_orphan",
        sourceType: "agent.tool_result",
        type: "tool_result",
        payload: {
          callId: "call_absent",
          status: "failed",
          errorMessage: "gone",
        },
      }),
    ]);

    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      kind: "tool",
      id: "evt_orphan",
      status: "failed",
      errorMessage: "gone",
    });
  });

  it("carries no reasoning body on a thinking item", () => {
    const state = fold([
      uiEvent({
        id: "evt_thinking",
        sourceType: "agent.thinking",
        type: "thinking",
        payload: { content: "must never be forwarded" },
      }),
    ]);

    expect(state.items).toEqual([
      { kind: "thinking", id: "evt_thinking", ts: "2026-09-07T08:00:00.000Z" },
    ]);
    expect(JSON.stringify(state.items)).not.toContain("must never");
  });

  it("separates user and agent messages by source type", () => {
    const state = fold([
      uiEvent({
        id: "evt_user",
        sourceType: "user.message",
        type: "message",
        payload: { content: "Prepare the plan" },
      }),
      uiEvent({
        id: "evt_agent",
        sourceType: "agent.message",
        type: "message",
        payload: { content: "Here it is" },
      }),
    ]);

    expect(state.items.map((item) => item.kind)).toEqual(["user", "assistant"]);
  });

  it("ignores a duplicate event id without folding it twice", () => {
    const event = uiEvent({
      id: "evt_dup",
      sourceType: "agent.message",
      type: "message",
      payload: { content: "once" },
    });
    const state = timelineReducer(
      timelineReducer(initialTimeline, { type: "event", event }),
      { type: "event", event },
    );

    expect(state.items).toHaveLength(1);
  });

  it("is pure, so a StrictMode double invoke does not lose the event", () => {
    const event = uiEvent({
      id: "evt_pure",
      sourceType: "agent.message",
      type: "message",
      payload: { content: "kept" },
    });
    const first = timelineReducer(initialTimeline, { type: "event", event });
    const second = timelineReducer(initialTimeline, { type: "event", event });

    expect(second.items).toEqual(first.items);
    expect(initialTimeline.items).toHaveLength(0);
    expect(initialTimeline.seenEventIds.size).toBe(0);
  });

  it("announces rescheduling without asking anything of the user", () => {
    const state = fold([
      uiEvent({
        id: "evt_rescheduled",
        sourceType: "session.status_rescheduled",
        type: "status",
        payload: { status: "rescheduled" },
      }),
    ]);

    expect(state.status).toBe("rescheduled");
    expect(state.ended).toBe(false);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ kind: "notice", tone: "info" });
    expect(state.items[0]).not.toHaveProperty("retriable", true);
  });

  it("marks a recoverable error retriable and keeps the stream open", () => {
    const state = fold([
      uiEvent({
        id: "evt_error",
        sourceType: "session.error",
        type: "error",
        payload: {
          code: "TEMPORARY",
          message: "Retrying upstream",
          recoverable: true,
        },
      }),
    ]);

    expect(state.status).toBe("rescheduled");
    expect(state.ended).toBe(false);
    expect(state.items[0]).toMatchObject({
      kind: "notice",
      tone: "warn",
      text: "Retrying upstream",
      retriable: true,
    });
  });

  it("ends the stream on a non-recoverable error", () => {
    const state = fold([
      uiEvent({
        id: "evt_fatal",
        sourceType: "session.error",
        type: "error",
        payload: {
          code: "FAILED",
          message: "Execution stopped",
          recoverable: false,
        },
      }),
    ]);

    expect(state.status).toBe("terminated");
    expect(state.ended).toBe(true);
    expect(state.items[0]).toMatchObject({
      kind: "notice",
      tone: "danger",
      text: "Execution stopped",
      retriable: false,
    });
  });

  it("falls back to a default notice when the error carries no message", () => {
    const state = fold([
      uiEvent({
        id: "evt_bare",
        sourceType: "session.error",
        type: "error",
        payload: { recoverable: true },
      }),
    ]);

    expect(state.items[0]).toMatchObject({
      tone: "warn",
      text: "The Agent is retrying automatically.",
    });
  });

  it("tracks status transitions and ends only on termination", () => {
    const running = fold([
      uiEvent({
        id: "evt_running",
        sourceType: "session.status_running",
        type: "status",
        payload: { status: "running" },
      }),
    ]);
    expect(running.status).toBe("running");
    expect(running.ended).toBe(false);
    expect(running.items).toHaveLength(0);

    const idle = foldEvents(
      [
        uiEvent({
          id: "evt_idle",
          sourceType: "session.status_idle",
          type: "status",
          payload: { status: "idle", stopReason: "end_turn" },
        }),
      ],
      running,
    );
    expect(idle.status).toBe("idle");
    expect(idle.ended).toBe(false);

    const terminated = foldEvents(
      [
        uiEvent({
          id: "evt_terminated",
          sourceType: "session.status_terminated",
          type: "status",
          payload: { status: "terminated" },
        }),
      ],
      idle,
    );
    expect(terminated.status).toBe("terminated");
    expect(terminated.ended).toBe(true);
  });

  it("ignores a status value outside the known set", () => {
    const state = fold([
      uiEvent({
        id: "evt_odd",
        sourceType: "session.status",
        type: "status",
        payload: { status: "paused" },
      }),
    ]);

    expect(state.status).toBeUndefined();
    expect(state.items).toHaveLength(0);
  });

  it("adopts the authoritative status from the ready frame", () => {
    const state = timelineReducer(initialTimeline, {
      type: "ready",
      ready: {
        sessionId: "session-1",
        status: "running",
        agentName: "Research",
        agentVersion: "7",
      },
    });

    expect(state.status).toBe("running");
    expect(state.items).toHaveLength(0);
  });

  it("lets a replayed status event correct the ready snapshot", () => {
    const ready = timelineReducer(initialTimeline, {
      type: "ready",
      ready: {
        sessionId: "session-1",
        status: "running",
        agentName: "Research",
        agentVersion: "7",
      },
    });
    const corrected = foldEvents(
      [
        uiEvent({
          id: "evt_idle",
          sourceType: "session.status_idle",
          type: "status",
          payload: { status: "idle" },
        }),
      ],
      ready,
    );

    expect(corrected.status).toBe("idle");
  });

  it("resets to a clean timeline", () => {
    const dirty = fold([
      uiEvent({
        id: "evt_1",
        sourceType: "agent.message",
        type: "message",
        payload: { content: "x" },
      }),
    ]);
    const reset = timelineReducer(dirty, { type: "reset" });

    expect(reset.items).toHaveLength(0);
    expect(reset.seenEventIds.size).toBe(0);
    expect(reset.status).toBeUndefined();
  });
});

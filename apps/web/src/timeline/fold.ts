import type { TodoEntry, UiEvent } from "@pwa/contracts";
import type { SessionStatus } from "../api.js";
import type { Item, NoticeItem, ToolItem } from "./items.js";

export interface ReadyFrame {
  sessionId: string;
  status: SessionStatus;
  agentName: string;
  agentVersion: string;
}

export interface TimelineState {
  items: Item[];
  status: SessionStatus | undefined;
  /** Set once the Session terminates; the stream should be closed. */
  ended: boolean;
  seenEventIds: ReadonlySet<string>;
  callIndexes: ReadonlyMap<string, number>;
}

export type TimelineAction =
  | { type: "event"; event: UiEvent }
  | { type: "ready"; ready: ReadyFrame }
  | { type: "reset" };

export const initialTimeline: TimelineState = {
  items: [],
  status: undefined,
  ended: false,
  seenEventIds: new Set<string>(),
  callIndexes: new Map<string, number>(),
};

export function isSessionStatus(value: unknown): value is SessionStatus {
  return (
    value === "idle" ||
    value === "running" ||
    value === "rescheduled" ||
    value === "terminated"
  );
}

function textField(event: UiEvent, field: string): string | undefined {
  const value = event.payload[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function todosField(event: UiEvent): TodoEntry[] | undefined {
  const value = event.payload.todos;
  return Array.isArray(value) && value.length > 0
    ? (value as TodoEntry[])
    : undefined;
}

function elapsedMs(from: string, to: string): number | undefined {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end)) return undefined;
  const elapsed = end - start;
  return elapsed >= 0 ? elapsed : undefined;
}

/**
 * Ark has no duration field, so elapsed time is the gap between the paired
 * events' own timestamps.
 */
function foldToolResult(state: TimelineState, event: UiEvent): TimelineState {
  const failed = event.payload.status === "failed";
  const status = failed ? "failed" : "ok";
  const callId = textField(event, "callId");
  const preview = textField(event, "preview");
  const errorCode = textField(event, "errorCode");
  const errorMessage = textField(event, "errorMessage");

  const index =
    callId === undefined ? -1 : (state.callIndexes.get(callId) ?? -1);
  const pending = index >= 0 ? state.items[index] : undefined;
  if (pending?.kind === "tool") {
    const durationMs = elapsedMs(pending.ts, event.createdAt);
    const merged: ToolItem = {
      ...pending,
      status,
      ...(preview === undefined ? {} : { preview }),
      ...(errorCode === undefined ? {} : { errorCode }),
      ...(errorMessage === undefined ? {} : { errorMessage }),
      ...(durationMs === undefined ? {} : { durationMs }),
    };
    const items = state.items.slice();
    items[index] = merged;
    return { ...state, items };
  }

  // An unmatched result. Across 287 captured events there were 48 call/result
  // pairs and no orphans, so this only guards against upstream divergence;
  // nothing in the UI should depend on it.
  return {
    ...state,
    items: [
      ...state.items,
      {
        kind: "tool",
        id: event.id,
        ts: event.createdAt,
        status,
        ...(callId === undefined ? {} : { callId }),
        ...(preview === undefined ? {} : { preview }),
        ...(errorCode === undefined ? {} : { errorCode }),
        ...(errorMessage === undefined ? {} : { errorMessage }),
      },
    ],
  };
}

function foldToolUse(state: TimelineState, event: UiEvent): TimelineState {
  const callId = textField(event, "callId");
  const name = textField(event, "name");
  const argsSummary = textField(event, "argsSummary");
  const todos = todosField(event);
  const item: ToolItem = {
    kind: "tool",
    id: event.id,
    ts: event.createdAt,
    status: "running",
    ...(callId === undefined ? {} : { callId }),
    ...(name === undefined ? {} : { name }),
    ...(argsSummary === undefined ? {} : { argsSummary }),
    ...(todos === undefined ? {} : { todos }),
  };
  const items = [...state.items, item];
  const callIndexes =
    callId === undefined
      ? state.callIndexes
      : new Map(state.callIndexes).set(callId, items.length - 1);
  return { ...state, items, callIndexes };
}

function foldStatus(state: TimelineState, event: UiEvent): TimelineState {
  const raw = event.payload.status;
  const status = isSessionStatus(raw) ? raw : undefined;
  if (status === undefined) return state;
  if (status === "terminated") return { ...state, status, ended: true };
  if (status !== "rescheduled") return { ...state, status };
  const notice: NoticeItem = {
    kind: "notice",
    id: event.id,
    ts: event.createdAt,
    tone: "info",
    text: "The run was rescheduled and resumes on its own. No action needed.",
  };
  return { ...state, status, items: [...state.items, notice] };
}

function foldError(state: TimelineState, event: UiEvent): TimelineState {
  const recoverable = event.payload.recoverable === true;
  const message = textField(event, "message");
  const notice: NoticeItem = {
    kind: "notice",
    id: event.id,
    ts: event.createdAt,
    tone: recoverable ? "warn" : "danger",
    text:
      message ??
      (recoverable
        ? "The Agent is retrying automatically."
        : "The Session could not continue."),
    retriable: recoverable,
  };
  return {
    ...state,
    items: [...state.items, notice],
    status: recoverable ? "rescheduled" : "terminated",
    ended: state.ended || !recoverable,
  };
}

function foldEvent(state: TimelineState, event: UiEvent): TimelineState {
  switch (event.type) {
    case "message": {
      const text = textField(event, "content");
      if (text === undefined) return state;
      const item: Item =
        event.sourceType === "user.message"
          ? { kind: "user", id: event.id, ts: event.createdAt, text }
          : { kind: "assistant", id: event.id, ts: event.createdAt, text };
      return { ...state, items: [...state.items, item] };
    }
    case "thinking":
      return {
        ...state,
        items: [
          ...state.items,
          { kind: "thinking", id: event.id, ts: event.createdAt },
        ],
      };
    case "tool_use":
      return foldToolUse(state, event);
    case "tool_result":
      return foldToolResult(state, event);
    case "status":
      return foldStatus(state, event);
    case "error":
      return foldError(state, event);
    default:
      // Unwhitelisted Ark events arrive with an empty payload and nothing to show.
      return state;
  }
}

/**
 * Single-pass fold over a time-ordered Ark event stream.
 *
 * Ark emits `tool_use` before its `tool_result`, so one pass suffices: the call
 * is appended and indexed by call id, the result patches it in place. History
 * replay and live events go through the same reducer, and `event.id` dedup makes
 * a reconnect neither lose nor duplicate anything.
 *
 * Pure: the seen-set and call index are copied rather than mutated, because
 * React re-invokes reducers under StrictMode.
 */
export function timelineReducer(
  state: TimelineState,
  action: TimelineAction,
): TimelineState {
  switch (action.type) {
    case "reset":
      return initialTimeline;
    case "ready":
      return state.status === action.ready.status
        ? state
        : { ...state, status: action.ready.status };
    case "event":
      break;
  }
  const event = action.event;
  if (state.seenEventIds.has(event.id)) return state;
  const seenEventIds = new Set(state.seenEventIds);
  seenEventIds.add(event.id);
  return foldEvent({ ...state, seenEventIds }, event);
}

/** Folds a whole batch, as delivered by a history replay. */
export function foldEvents(
  events: readonly UiEvent[],
  state: TimelineState = initialTimeline,
): TimelineState {
  return events.reduce(
    (current, event) => timelineReducer(current, { type: "event", event }),
    state,
  );
}

/** The Agent's own task list, taken from the most recent `todo_write`. */
export function currentTodos(items: readonly Item[]): TodoEntry[] {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === "tool" && item.todos) return item.todos;
  }
  return [];
}

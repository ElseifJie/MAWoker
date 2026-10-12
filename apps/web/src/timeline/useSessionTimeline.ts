import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { TodoEntry, UiEvent } from "@pwa/contracts";
import { ApiClientError, apiClient, type SessionStatus } from "../api.js";
import {
  currentTodos,
  initialTimeline,
  isSessionStatus,
  timelineReducer,
  type ReadyFrame,
} from "./fold.js";
import type { Item } from "./items.js";
import { buildBlocks, type TranscriptBlock } from "./blocks.js";
import { messageRoles, type MessageRole } from "./messageRole.js";

/** Ark event names the stream subscribes to; `ready` is added separately. */
export const sessionEventNames = [
  "user.message",
  "agent.message",
  "agent.thinking",
  "tool.call",
  "tool.result",
  "agent.tool_use",
  "agent.tool_result",
  "agent.mcp_tool_use",
  "agent.mcp_tool_result",
  "agent.custom_tool_use",
  "session.status",
  "session.status_running",
  "session.status_rescheduled",
  "session.status_idle",
  "session.status_terminated",
  "session.error",
] as const;

export type TimelineConnection =
  "connecting" | "live" | "reconnecting" | "ended";

export interface SessionTimelineOptions {
  sessionId: string;
  /** Hold the stream until the Session record has loaded. */
  enabled: boolean;
  onStreamReady: (sessionId: string) => void;
  onInvalidEvent?: () => void;
  /**
   * The server closed the stream because the login session was revoked
   * (`auth_invalid` control event). The source is closed without letting
   * EventSource reconnect; the app should re-verify the account.
   */
  onAuthInvalid?: () => void;
}

export interface SessionTimeline {
  items: Item[];
  blocks: TranscriptBlock[];
  roles: ReadonlyMap<string, MessageRole>;
  todos: TodoEntry[];
  status: SessionStatus | undefined;
  connection: TimelineConnection;
}

function toUiEvent(value: unknown): UiEvent | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.sourceType !== "string" ||
    typeof candidate.createdAt !== "string" ||
    typeof candidate.payload !== "object" ||
    candidate.payload === null
  ) {
    return undefined;
  }
  return value as UiEvent;
}

function toReadyFrame(value: unknown): ReadyFrame | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.sessionId !== "string") return undefined;
  if (!isSessionStatus(candidate.status)) return undefined;
  return {
    sessionId: candidate.sessionId,
    status: candidate.status,
    agentName:
      typeof candidate.agentName === "string" ? candidate.agentName : "",
    agentVersion:
      typeof candidate.agentVersion === "string" ? candidate.agentVersion : "",
  };
}

/**
 * The single owner of Session timeline state: stream lifecycle, `event.id`
 * dedup, and the fold from Ark events to items. No other component keeps event
 * state, and nothing here reaches across the tree with window events.
 */
export function useSessionTimeline(
  options: SessionTimelineOptions,
): SessionTimeline {
  const { sessionId, enabled, onStreamReady, onInvalidEvent, onAuthInvalid } =
    options;
  const [state, dispatch] = useReducer(timelineReducer, initialTimeline);
  const [connection, setConnection] =
    useState<TimelineConnection>("connecting");
  const sourceRef = useRef<EventSource | null>(null);
  // Held in a ref so a caller passing an inline handler cannot tear down and
  // reopen the stream on every render.
  const invalidEventRef = useRef(onInvalidEvent);
  useEffect(() => {
    invalidEventRef.current = onInvalidEvent;
  });
  const authInvalidRef = useRef(onAuthInvalid);
  useEffect(() => {
    authInvalidRef.current = onAuthInvalid;
  });

  useEffect(() => {
    if (!enabled) return;
    dispatch({ type: "reset" });
    setConnection("connecting");
    const source = new EventSource(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/events`,
      { withCredentials: true },
    );
    sourceRef.current = source;
    let authTerminated = false;
    let disposed = false;

    const read = (raw: Event): unknown | undefined => {
      if (!(raw instanceof MessageEvent) || typeof raw.data !== "string") {
        return undefined;
      }
      try {
        return JSON.parse(raw.data) as unknown;
      } catch {
        invalidEventRef.current?.();
        return undefined;
      }
    };
    const receive = (raw: Event) => {
      const event = toUiEvent(read(raw));
      if (event) dispatch({ type: "event", event });
    };
    const ready = (raw: Event) => {
      const frame = toReadyFrame(read(raw));
      if (frame) dispatch({ type: "ready", ready: frame });
    };
    // A revoked login session closes the stream server-side. EventSource would
    // reconnect into a 401 loop, so close it here and let the app re-verify
    // the account instead of retrying an unwinnable request.
    const terminateAuth = () => {
      if (disposed || authTerminated) return;
      authTerminated = true;
      source.close();
      setConnection("ended");
      authInvalidRef.current?.();
    };
    // A plain stream error is ambiguous (server restart, network blip, or a
    // revoked session on reconnect). EventSource cannot see the status code,
    // so one identity probe separates the two: 401 closes the stream for
    // re-auth, anything else leaves the browser's bounded retry in charge.
    let probeInFlight = false;
    source.onerror = () => {
      if (disposed || authTerminated) return;
      setConnection("reconnecting");
      if (probeInFlight) return;
      probeInFlight = true;
      apiClient
        .getMe()
        .catch((error: unknown) => {
          if (error instanceof ApiClientError && error.isAuthRequired) {
            terminateAuth();
          }
          // Any other failure is transient; keep the EventSource retrying.
        })
        .finally(() => {
          if (!disposed) probeInFlight = false;
        });
    };

    for (const name of sessionEventNames) {
      source.addEventListener(name, receive);
    }
    source.addEventListener("ready", ready);
    source.addEventListener("auth_invalid", terminateAuth);
    source.onopen = () => {
      setConnection("live");
      onStreamReady(sessionId);
    };
    return () => {
      disposed = true;
      source.close();
      sourceRef.current = null;
    };
  }, [enabled, onStreamReady, sessionId]);

  useEffect(() => {
    if (!state.ended) return;
    sourceRef.current?.close();
    setConnection("ended");
  }, [state.ended]);

  const roles = useMemo(
    () => messageRoles(state.items, state.status),
    [state.items, state.status],
  );
  const todos = useMemo(() => currentTodos(state.items), [state.items]);
  const blocks = useMemo(
    () => buildBlocks(state.items, roles, state.status),
    [roles, state.items, state.status],
  );

  return {
    items: state.items,
    blocks,
    roles,
    todos,
    status: state.status,
    connection,
  };
}

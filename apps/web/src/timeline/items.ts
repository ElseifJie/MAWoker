import type { TodoEntry } from "@pwa/contracts";

export interface Attachment {
  name: string;
}

export type ToolCallStatus = "running" | "ok" | "failed";

export type NoticeTone = "info" | "warn" | "danger";

export interface UserItem {
  kind: "user";
  id: string;
  ts: string;
  text: string;
  attachments?: Attachment[];
}

export interface AssistantItem {
  kind: "assistant";
  id: string;
  ts: string;
  text: string;
}

/**
 * One tool call, folded from a `tool_use` event and patched in place by its
 * matching `tool_result`. The id stays the `tool_use` event id, so a completed
 * call renders as a single row rather than a call/result pair.
 */
export interface ToolItem {
  kind: "tool";
  id: string;
  ts: string;
  callId?: string;
  name?: string;
  argsSummary?: string;
  status: ToolCallStatus;
  preview?: string;
  durationMs?: number;
  errorCode?: string;
  errorMessage?: string;
  todos?: TodoEntry[];
}

/** Thinking carries no body: reasoning text never reaches the browser. */
export interface ThinkingItem {
  kind: "thinking";
  id: string;
  ts: string;
}

export interface NoticeItem {
  kind: "notice";
  id: string;
  ts: string;
  tone: NoticeTone;
  text: string;
  retriable?: boolean;
}

export type Item =
  UserItem | AssistantItem | ToolItem | ThinkingItem | NoticeItem;

export type ItemKind = Item["kind"];

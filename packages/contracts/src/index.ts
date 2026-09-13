import { z } from "zod";
import {
  extractTodos,
  redactCredentials,
  redactText,
  summarizeToolArgs,
  summarizeToolResult,
} from "./redact.js";

export * from "./redact.js";

export const errorCodeSchema = z.enum([
  "AUTH_REQUIRED",
  "FORBIDDEN",
  "ORIGIN_FORBIDDEN",
  "RESOURCE_NOT_FOUND",
  "VALIDATION_FAILED",
  "USER_EMAIL_CONFLICT",
  "SELF_TARGET_FORBIDDEN",
  "LAST_ACTIVE_ADMIN",
  "INVALID_MULTIPART",
  "INVALID_UPLOAD_NAME",
  "INVALID_SKILL_PACKAGE",
  "SKILL_NOT_AVAILABLE",
  "QUOTA_EXCEEDED",
  "CONCURRENCY_LIMITED",
  "RATE_LIMITED",
  "AGENT_BUSY",
  "ARK_RATE_LIMITED",
  "ARK_UNAVAILABLE",
  "ARK_CONFLICT",
  "ARK_INVALID_RESPONSE",
  "ARK_RUNTIME_BUSY",
  "ARK_REQUEST_REJECTED",
  "ARTIFACT_STORAGE_UNAVAILABLE",
  "ARTIFACT_SOURCE_UNAVAILABLE",
  "SESSION_TERMINATED",
  "SESSION_BUSY",
  "DELETION_PENDING",
  "DELETION_FAILED",
  "INTERNAL_ERROR",
]);

export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const apiErrorSchema = z
  .object({
    error: z
      .object({
        code: errorCodeSchema,
        message: z.string().min(1),
        requestId: z.string().min(1),
        retryable: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type ApiError = z.infer<typeof apiErrorSchema>;

export const paginationSchema = z
  .object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const agentKindSchema = z.enum(["platform", "personal"]);
export const agentStatusSchema = z.enum([
  "provisioning",
  "active",
  "disabled",
  "failed",
  "deleting",
]);

export const sessionStatusSchema = z.enum([
  "idle",
  "running",
  "rescheduled",
  "terminated",
]);

export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const createAgentSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).default(""),
    modelId: z.string().trim().min(1),
    systemPrompt: z.string().max(32_000).default(""),
  })
  .strict();

export const updateAgentSchema = createAgentSchema.partial().strict();

export const createSessionSchema = z
  .object({
    agentId: z.string().uuid(),
    uploadIds: z.array(z.string().uuid()).max(20).default([]),
    title: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export const sendMessageSchema = z
  .object({
    content: z.string().trim().min(1).max(100_000),
  })
  .strict();

export const deleteSessionSchema = z
  .object({
    confirmation: z.literal("DELETE"),
  })
  .strict();

export const renameSessionSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
  })
  .strict();

export const quotaSchema = z
  .object({
    personalAgentLimit: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    concurrentSessionLimit: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER),
    dailySessionLimit: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    monthlyTokenLimit: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export type Quota = z.infer<typeof quotaSchema>;

/**
 * Quota overrides are sparse: a dimension set to `null` (or omitted) falls
 * back to the default policy, so clearing a field means "inherit" rather
 * than "zero".
 */
export const partialQuotaSchema = z
  .object({
    personalAgentLimit: quotaSchema.shape.personalAgentLimit
      .nullable()
      .optional(),
    concurrentSessionLimit: quotaSchema.shape.concurrentSessionLimit
      .nullable()
      .optional(),
    dailySessionLimit: quotaSchema.shape.dailySessionLimit
      .nullable()
      .optional(),
    monthlyTokenLimit: quotaSchema.shape.monthlyTokenLimit
      .nullable()
      .optional(),
  })
  .strict();

export type PartialQuota = z.infer<typeof partialQuotaSchema>;

export const PASSWORD_MIN_LENGTH = 8;

export const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(320)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "must be a valid email address")
  .transform((value) => value.toLowerCase());

export const passwordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(200);

export const credentialsSchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1).max(200),
  })
  .strict();

export type Credentials = z.infer<typeof credentialsSchema>;

export const createUserSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    role: z.enum(["user", "admin"]).default("user"),
  })
  .strict();

export type CreateUserInput = z.infer<typeof createUserSchema>;

export const resetPasswordSchema = z
  .object({
    password: passwordSchema,
  })
  .strict();

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const arkEventSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    createdAt: z.string().datetime(),
    data: z.record(z.string(), z.unknown()),
  })
  .strict();

export type ArkEvent = z.infer<typeof arkEventSchema>;

export type UiEventType =
  | "message"
  | "thinking"
  | "tool_use"
  | "tool_result"
  | "status"
  | "error"
  | "unknown";

export interface UiEvent {
  id: string;
  sourceType: string;
  type: UiEventType;
  createdAt: string;
  payload: Record<string, unknown>;
}

// Derived from 287 events captured across 46 live sessions. That account was
// healthy, so `session.error` and `session.status_rescheduled` never occurred:
// their payload shapes below come from existing test fixtures, not observation.
const eventTypes: Record<string, UiEventType> = {
  "user.message": "message",
  "agent.message": "message",
  "agent.thinking": "thinking",
  "agent.tool_use": "tool_use",
  "agent.mcp_tool_use": "tool_use",
  "agent.custom_tool_use": "tool_use",
  "tool.call": "tool_use",
  "agent.tool_result": "tool_result",
  "agent.mcp_tool_result": "tool_result",
  "tool.result": "tool_result",
  "session.status": "status",
  "session.status_running": "status",
  "session.status_rescheduled": "status",
  "session.status_idle": "status",
  "session.status_terminated": "status",
  "session.error": "error",
};

function stringField(
  data: Record<string, unknown>,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    if (typeof data[name] === "string") return data[name];
  }
  return undefined;
}

/**
 * The UI type for an Ark event name. Exported so a stored event can be
 * re-projected on read rather than trusting a denormalized column, which keeps
 * rows written by an older release rendering correctly.
 */
export function uiEventType(sourceType: string): UiEventType {
  return eventTypes[sourceType] ?? "unknown";
}

// The `retry_status.type` probe is unverified: no `session.error` appeared in the
// captured traffic, so this shape has never been observed on the wire.
export function isRecoverableArkError(data: Record<string, unknown>): boolean {
  if (data.recoverable === true || data.retryable === true) return true;
  if (typeof data.error !== "object" || data.error === null) return false;
  const retryStatus = (data.error as Record<string, unknown>).retry_status;
  return (
    typeof retryStatus === "object" &&
    retryStatus !== null &&
    (retryStatus as Record<string, unknown>).type === "retrying"
  );
}

function messagePayload(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const content = typeof data.content === "string" ? data.content : undefined;
  return content === undefined ? {} : { content: redactCredentials(content) };
}

function toolUsePayload(event: ArkEvent): Record<string, unknown> {
  const data = event.data;
  const name = stringField(data, "name");
  const input = data.input ?? data.arguments;
  const argsSummary = summarizeToolArgs(name, input);
  const todos = extractTodos(input);
  const serverName = stringField(data, "mcp_server_name");
  return {
    // Ark reuses the tool_use event's own id as the call id that tool_result references.
    callId: event.id,
    ...(name === undefined ? {} : { name }),
    ...(serverName === undefined ? {} : { serverName }),
    ...(argsSummary === undefined ? {} : { argsSummary }),
    ...(todos === undefined ? {} : { todos }),
  };
}

function toolResultPayload(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const callId = stringField(
    data,
    "tool_use_id",
    "mcp_tool_use_id",
    "tool_call_id",
  );
  const summary = summarizeToolResult(data.content, data.is_error);
  return {
    ...(callId === undefined ? {} : { callId }),
    status: summary.status,
    ...(summary.preview === undefined ? {} : { preview: summary.preview }),
    ...(summary.errorCode === undefined
      ? {}
      : { errorCode: summary.errorCode }),
    ...(summary.errorMessage === undefined
      ? {}
      : { errorMessage: summary.errorMessage }),
  };
}

function stopReason(data: Record<string, unknown>): Record<string, unknown> {
  const reason = data.stop_reason;
  if (typeof reason !== "object" || reason === null) return {};
  const type = stringField(reason as Record<string, unknown>, "type");
  return type === undefined ? {} : { stopReason: type };
}

function publicEventPayload(event: ArkEvent): Record<string, unknown> {
  const data = event.data;
  if (event.type === "agent.thinking") {
    // Requirement 7.2: reasoning text is never transmitted to the browser.
    return {};
  }
  if (event.type === "user.message" || event.type === "agent.message") {
    return messagePayload(data);
  }
  if (
    event.type === "agent.tool_use" ||
    event.type === "agent.mcp_tool_use" ||
    event.type === "agent.custom_tool_use" ||
    event.type === "tool.call"
  ) {
    return toolUsePayload(event);
  }
  if (
    event.type === "agent.tool_result" ||
    event.type === "agent.mcp_tool_result" ||
    event.type === "tool.result"
  ) {
    return toolResultPayload(data);
  }
  if (event.type === "session.status") {
    const status = stringField(data, "status");
    return {
      ...(status === undefined ? {} : { status }),
      ...stopReason(data),
    };
  }
  if (event.type.startsWith("session.status_")) {
    return {
      status: event.type.slice("session.status_".length),
      ...stopReason(data),
    };
  }
  if (event.type === "session.error") {
    const code = stringField(data, "code");
    const message = stringField(data, "message");
    return {
      ...(code === undefined ? {} : { code }),
      ...(message === undefined ? {} : { message: redactText(message) }),
      recoverable: isRecoverableArkError(data),
    };
  }
  // No raw passthrough: unlisted Ark events (span.*, session.thread_status_*,
  // session.deleted, anything new) carry an empty payload rather than their data.
  return {};
}

export function normalizeArkEvent(input: ArkEvent): UiEvent {
  const event = arkEventSchema.parse(input);
  return {
    id: event.id,
    sourceType: event.type,
    type: eventTypes[event.type] ?? "unknown",
    createdAt: event.createdAt,
    payload: publicEventPayload(event),
  };
}

export interface FeatureCapability {
  available: boolean;
}

export interface FeatureCapabilities {
  skills: FeatureCapability;
  mcpServers: FeatureCapability;
  vaults: FeatureCapability;
  memoryStores: FeatureCapability;
}

export const capabilities: FeatureCapabilities = {
  skills: { available: true },
  mcpServers: { available: false },
  vaults: { available: false },
  memoryStores: { available: false },
};

import { z } from "zod";

export const errorCodeSchema = z.enum([
  "AUTH_REQUIRED",
  "FORBIDDEN",
  "RESOURCE_NOT_FOUND",
  "VALIDATION_FAILED",
  "QUOTA_EXCEEDED",
  "CONCURRENCY_LIMITED",
  "ARK_RATE_LIMITED",
  "ARK_UNAVAILABLE",
  "ARK_CONFLICT",
  "SESSION_TERMINATED",
  "SESSION_BUSY",
  "DELETION_PENDING",
  "DELETION_FAILED",
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

export const quotaSchema = z
  .object({
    personalAgentLimit: z.number().int().min(0),
    concurrentSessionLimit: z.number().int().min(0),
    dailySessionLimit: z.number().int().min(0),
    monthlyTokenLimit: z.number().int().min(0),
  })
  .strict();

export type Quota = z.infer<typeof quotaSchema>;

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
  "message" | "thinking" | "tool" | "status" | "error" | "unknown";

export interface UiEvent {
  id: string;
  sourceType: string;
  type: UiEventType;
  createdAt: string;
  payload: Record<string, unknown>;
}

const eventTypes: Record<string, UiEventType> = {
  "agent.message": "message",
  "agent.thinking": "thinking",
  "tool.call": "tool",
  "tool.result": "tool",
  "session.status": "status",
  "session.error": "error",
};

export function normalizeArkEvent(input: ArkEvent): UiEvent {
  const event = arkEventSchema.parse(input);
  return {
    id: event.id,
    sourceType: event.type,
    type: eventTypes[event.type] ?? "unknown",
    createdAt: event.createdAt,
    payload: event.data,
  };
}

export const capabilities = {
  skills: { available: false },
  mcpServers: { available: false },
  vaults: { available: false },
  memoryStores: { available: false },
} as const;

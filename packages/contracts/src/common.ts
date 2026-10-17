import { z } from "zod";

export const errorCodeSchema = z.enum([
  "AUTH_REQUIRED",
  "FORBIDDEN",
  "ORIGIN_FORBIDDEN",
  "RESOURCE_NOT_FOUND",
  "VALIDATION_FAILED",
  "INVITE_INVALID",
  "MCP_URL_UNSAFE",
  "MCP_NAME_CONFLICT",
  "CHANNEL_URL_UNSAFE",
  "CHANNEL_NAME_CONFLICT",
  "USER_EMAIL_CONFLICT",
  "SELF_TARGET_FORBIDDEN",
  "LAST_ACTIVE_ADMIN",
  "INVALID_MULTIPART",
  "INVALID_UPLOAD_NAME",
  "UPLOAD_TOO_LARGE",
  "UPLOAD_TOTAL_TOO_LARGE",
  "SUBMISSION_ADMISSION_PAUSED",
  "FILE_REUSE_ADMISSION_PAUSED",
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
  "ARTIFACT_RETRY_UNAVAILABLE",
  "SESSION_TERMINATED",
  "SESSION_BUSY",
  "EVENT_HISTORY_REPAIR_PENDING",
  "MEMORY_BUSY",
  "MEMORY_CONFLICT",
  "MEMORY_INVALID",
  "MEMORY_CAPACITY",
  "MEMORY_REPAIR_REQUIRED",
  "ASSISTANT_PROFILE_CONFLICT",
  "DELETION_PENDING",
  "DELETION_FAILED",
  "SUBMISSION_CONFLICT",
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

export const paginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

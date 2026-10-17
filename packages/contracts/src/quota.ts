import { z } from "zod";

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

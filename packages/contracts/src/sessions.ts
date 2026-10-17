import { z } from "zod";

export const sessionStatusSchema = z.enum([
  "idle",
  "running",
  "rescheduled",
  "initializing",
  "upgrading",
  "failed",
  "terminated",
]);

export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const createSessionSchema = z
  .object({
    agentId: z.string().uuid(),
    uploadIds: z.array(z.string().uuid()).max(20).default([]),
    title: z.string().trim().min(1).max(120).optional(),
    temporary: z.boolean().default(false),
    submissionId: z.string().uuid().optional(),
    content: z.string().trim().min(1).max(100_000).optional(),
  })
  .strict()
  .refine(
    (input) => Boolean(input.submissionId) === Boolean(input.content),
    "submissionId and content are required together",
  );

export const sendMessageSchema = z
  .object({
    content: z.string().trim().min(1).max(100_000),
    submissionId: z.string().uuid().optional(),
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

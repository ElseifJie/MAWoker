import { z } from "zod";

export const agentKindSchema = z.enum(["platform", "personal"]);
export const agentStatusSchema = z.enum([
  "provisioning",
  "active",
  "disabled",
  "failed",
  "deleting",
]);

export const createAgentSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).default(""),
    modelId: z.string().trim().min(1),
    systemPrompt: z.string().max(32_000).default(""),
  })
  .strict();

export const updateAgentSchema = createAgentSchema.partial().strict();

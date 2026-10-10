import type { ArkGateway } from "@pwa/ark-client";

export interface SystemAgentConfiguration {
  arkAgentId: string;
  name: string;
  description: string;
  modelId: string;
  systemPrompt: "";
  arkVersion: string;
  status: "active";
}

export async function resolveSystemAgents(input: {
  agentIds: readonly string[];
  ark: Pick<ArkGateway, "getAgent">;
  modelAllowlist: readonly string[];
}): Promise<SystemAgentConfiguration[]> {
  const allowedModels = new Set(input.modelAllowlist);
  const resolved: SystemAgentConfiguration[] = [];
  for (const agentId of input.agentIds) {
    const agent = await input.ark.getAgent(agentId);
    if (agent.id !== agentId) {
      throw new Error(
        `Ark returned Agent ${agent.id} while resolving ${agentId}`,
      );
    }
    if (!allowedModels.has(agent.modelId)) {
      throw new Error(
        `System Agent ${agentId} uses a model outside MODEL_ALLOWLIST`,
      );
    }
    resolved.push({
      arkAgentId: agent.id,
      name: agent.name,
      description: agent.description,
      modelId: agent.modelId,
      systemPrompt: "",
      arkVersion: String(agent.version),
      status: "active",
    });
  }
  return resolved;
}

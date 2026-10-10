import { describe, expect, it, vi } from "vitest";
import { resolveSystemAgents } from "../packages/domain/src/index.js";

describe("System Agent resolution", () => {
  it("loads every configured Agent ID from Ark and derives local metadata", async () => {
    const getAgent = vi.fn(async (agentId: string) => ({
      id: agentId,
      version: agentId === "agent-a" ? 2 : 4,
      name: agentId === "agent-a" ? "Research" : "Code",
      description: agentId === "agent-a" ? "Find evidence" : "Review code",
      modelId: agentId === "agent-a" ? "model-a" : "model-b",
    }));

    await expect(
      resolveSystemAgents({
        agentIds: ["agent-a", "agent-b"],
        ark: { getAgent },
        modelAllowlist: ["model-a", "model-b"],
      }),
    ).resolves.toEqual([
      {
        arkAgentId: "agent-a",
        name: "Research",
        description: "Find evidence",
        modelId: "model-a",
        systemPrompt: "",
        arkVersion: "2",
        status: "active",
      },
      {
        arkAgentId: "agent-b",
        name: "Code",
        description: "Review code",
        modelId: "model-b",
        systemPrompt: "",
        arkVersion: "4",
        status: "active",
      },
    ]);
    expect(getAgent).toHaveBeenCalledTimes(2);
  });

  it("rejects a resolved Agent whose model is outside the allowlist", async () => {
    await expect(
      resolveSystemAgents({
        agentIds: ["agent-a"],
        ark: {
          getAgent: async () => ({
            id: "agent-a",
            version: 1,
            name: "Research",
            description: "",
            modelId: "unapproved-model",
          }),
        },
        modelAllowlist: ["model-a"],
      }),
    ).rejects.toThrow(/agent-a.*MODEL_ALLOWLIST/);
  });

  it("rejects an Ark response for a different Agent ID", async () => {
    await expect(
      resolveSystemAgents({
        agentIds: ["agent-a"],
        ark: {
          getAgent: async () => ({
            id: "agent-b",
            version: 1,
            name: "Research",
            description: "",
            modelId: "model-a",
          }),
        },
        modelAllowlist: ["model-a"],
      }),
    ).rejects.toThrow(/agent-b.*agent-a/);
  });

  it("resolves configured Agents sequentially to avoid startup rate-limit bursts", async () => {
    let active = 0;
    let maximumActive = 0;
    await resolveSystemAgents({
      agentIds: ["agent-a", "agent-b", "agent-c"],
      ark: {
        getAgent: async (agentId) => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((resolve) => setTimeout(resolve, 1));
          active -= 1;
          return {
            id: agentId,
            version: 1,
            name: agentId,
            description: "",
            modelId: "model-a",
          };
        },
      },
      modelAllowlist: ["model-a"],
    });

    expect(maximumActive).toBe(1);
  });
});

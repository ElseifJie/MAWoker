import { describe, expect, it, vi } from "vitest";
import {
  AssistantProfileConflictError,
  AssistantProfileService,
  ResourceNotFoundError,
  type AssistantAgentSummary,
  type AssistantProfileRecord,
} from "../packages/domain/src/index.js";

const agent: AssistantAgentSummary = {
  id: "agent-1",
  name: "Assistant",
  modelId: "model-a",
  status: "active",
  arkAgentId: "ark-agent-1",
};

const profile: AssistantProfileRecord = {
  ownerUserId: "user-1",
  defaultAgentId: null,
  displayName: "",
  persona: "",
  preferences: {},
  revision: 1,
  createdAt: new Date("2026-10-17T00:00:00.000Z"),
  updatedAt: new Date("2026-10-17T00:00:00.000Z"),
};

function harness(
  overrides: {
    find?: () => Promise<AssistantProfileRecord | undefined>;
    update?: () => Promise<AssistantProfileRecord | undefined>;
  } = {},
) {
  let current = profile;
  const repository = {
    find: vi.fn(overrides.find ?? (async () => current)),
    ensure: vi.fn(async () => current),
    findDefaultAgent: vi.fn(async () => agent),
    findAgent: vi.fn(async () => undefined),
    attachDefault: vi.fn(async (_owner: string, agentId: string) => {
      current = { ...current, defaultAgentId: agentId, revision: 2 };
      return current;
    }),
    update: vi.fn(
      overrides.update ??
        (async () => {
          current = { ...current, displayName: "Updated", revision: 3 };
          return current;
        }),
    ),
  };
  return {
    repository,
    service: new AssistantProfileService({ repository }),
  };
}

describe("AssistantProfileService", () => {
  it("creates the profile and lazily links the auto-default agent", async () => {
    const { service, repository } = harness();

    const view = await service.get("user-1");

    expect(view.profile.defaultAgentId).toBe("agent-1");
    expect(view.agent).toEqual(agent);
    expect(repository.attachDefault).toHaveBeenCalledWith("user-1", "agent-1");
  });

  it("returns an update followed by the linked assistant", async () => {
    const { service } = harness();

    const view = await service.update("user-1", {
      displayName: "Updated",
      expectedRevision: 1,
    });

    expect(view.profile.displayName).toBe("Updated");
    expect(view.agent).toEqual(agent);
  });

  it("rejects a stale revision as a conflict", async () => {
    const { service } = harness({ update: async () => undefined });

    await expect(
      service.update("user-1", { displayName: "Stale", expectedRevision: 1 }),
    ).rejects.toBeInstanceOf(AssistantProfileConflictError);
  });

  it("reports a missing profile as not found", async () => {
    const { service } = harness({
      find: async () => undefined,
      update: async () => undefined,
    });

    await expect(
      service.update("missing", { displayName: "No profile" }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});

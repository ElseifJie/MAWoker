import { describe, expect, it, vi } from "vitest";
import { createRepositories } from "../packages/db/src/index.js";

const userId = "00000000-0000-4000-8000-000000000001";
const agentId = "00000000-0000-4000-8000-000000000002";
const adminId = "00000000-0000-4000-8000-000000000003";

function assignableClient() {
  const execute = vi.fn(async () => {
    // First the eligibility select, then the upsert returning the assignment.
    if (execute.mock.calls.length === 1) {
      return { rows: [{ id: agentId }] };
    }
    return {
      rows: [
        {
          userId,
          platformAgentId: agentId,
          assignedBy: adminId,
          // drizzle's execute() surfaces timestamps as raw driver text.
          assignedAt: "2026-09-11 15:56:49.05906+08",
        },
      ],
    };
  });
  return {
    execute,
    transaction: <T>(callback: (client: unknown) => Promise<T>) =>
      callback({ execute }),
  };
}

describe("platform Agent repository", () => {
  it("returns an assignable default Agent timestamp as a Date", async () => {
    const repositories = createRepositories(assignableClient());

    const assignment = await repositories.platformAgents.assignDefault({
      userId,
      platformAgentId: agentId,
      assignedBy: adminId,
    });

    expect(assignment?.assignedAt).toBeInstanceOf(Date);
    expect(assignment?.assignedAt.toISOString()).toBe(
      "2026-09-11T07:56:49.059Z",
    );
  });

  it("normalizes an already parsed timestamp without shifting it", async () => {
    const parsed = new Date("2026-09-11T07:56:49.059Z");
    const execute = vi.fn(async () => ({
      rows: [
        {
          userId,
          platformAgentId: agentId,
          assignedBy: adminId,
          assignedAt: parsed,
        },
      ],
    }));
    const repositories = createRepositories({
      execute,
      transaction: <T>(callback: (client: unknown) => Promise<T>) =>
        callback({ execute }),
    });

    const assignment = await repositories.platformAgents.assignDefault({
      userId,
      platformAgentId: agentId,
      assignedBy: adminId,
    });

    expect(assignment?.assignedAt.toISOString()).toBe(parsed.toISOString());
  });

  it("revives every aliased timestamp on list reads and leaves other values alone", async () => {
    const execute = vi.fn(async () => ({
      rows: [
        {
          id: agentId,
          arkAgentId: "ark-agent-1",
          name: "Research",
          description: "",
          modelId: "model-a",
          systemPrompt: "",
          arkVersion: "1",
          status: "active",
          createdBy: adminId,
          updatedBy: adminId,
          lastErrorCode: null,
          createdAt: "2026-09-07 21:09:18.080623+08",
          updatedAt: "2026-09-08 09:00:00.5+08",
        },
      ],
    }));
    const repositories = createRepositories({ execute });

    const [agent] = await repositories.platformAgents.list();

    expect(agent?.createdAt).toBeInstanceOf(Date);
    expect(agent?.createdAt.toISOString()).toBe("2026-09-07T13:09:18.080Z");
    expect(agent?.updatedAt).toBeInstanceOf(Date);
    expect(agent?.updatedAt.toISOString()).toBe("2026-09-08T01:00:00.500Z");
    expect(agent?.status).toBe("active");
    expect(agent?.arkVersion).toBe("1");
    expect(agent?.lastErrorCode).toBeNull();
  });
});

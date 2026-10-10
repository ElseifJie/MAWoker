import { describe, expect, it } from "vitest";
import { createRepositories } from "../packages/db/src/index.js";
import { createTestDatabase, id } from "./support/test-database.js";

describe("environment system Agents", () => {
  it("synchronizes multiple Agents, preserves IDs and assignments, and disables removed entries", async () => {
    const database = await createTestDatabase();
    try {
      const adminId = id();
      const userId = id();
      await database.client.query(
        `insert into users (id, auth_subject, email, role)
         values ($1, 'admin', 'admin@example.com', 'admin'),
                ($2, 'user', 'user@example.com', 'user')`,
        [adminId, userId],
      );
      const repository = createRepositories(database.db).platformAgents;
      const agents = [
        {
          arkAgentId: "ark-a",
          name: "Research",
          description: "",
          modelId: "model-a",
          systemPrompt: "Research",
          arkVersion: "2",
          status: "active" as const,
        },
        {
          arkAgentId: "ark-b",
          name: "Code",
          description: "",
          modelId: "model-b",
          systemPrompt: "",
          arkVersion: "1",
          status: "active" as const,
        },
      ];
      await repository.synchronizeSystemAgents(agents);
      const initial = await repository.list();
      expect(initial).toHaveLength(2);
      const research = initial.find((agent) => agent.arkAgentId === "ark-a")!;
      await repository.assignDefault({
        userId,
        platformAgentId: research.id,
        assignedBy: adminId,
      });

      await repository.synchronizeSystemAgents([
        {
          ...agents[0]!,
          name: "Research lead",
          systemPrompt: "",
          arkVersion: "3",
        },
      ]);
      const updated = await repository.list();
      expect(
        updated.find((agent) => agent.arkAgentId === "ark-a"),
      ).toMatchObject({
        id: research.id,
        name: "Research lead",
        systemPrompt: "Research",
        arkVersion: "3",
        status: "active",
      });
      expect(
        updated.find((agent) => agent.arkAgentId === "ark-b")?.status,
      ).toBe("disabled");
      expect(
        await repository.findAssignedToUser(userId, research.id),
      ).toBeDefined();

      await repository.synchronizeSystemAgents([]);
      expect(
        (await repository.list()).every((agent) => agent.status === "disabled"),
      ).toBe(true);
      await repository.synchronizeSystemAgents(agents);
      expect(
        (await repository.list()).find((agent) => agent.arkAgentId === "ark-a")
          ?.id,
      ).toBe(research.id);

      await repository.synchronizeSystemAgents([...agents].reverse());
      expect(
        (await repository.list())
          .filter((agent) => agent.status === "active")
          .map((agent) => agent.arkAgentId),
      ).toEqual(["ark-b", "ark-a"]);
    } finally {
      await database.close();
    }
  });

  it("requires a seeded administrator before importing configured Agents", async () => {
    const database = await createTestDatabase();
    try {
      const repository = createRepositories(database.db).platformAgents;
      await repository.synchronizeSystemAgents([]);
      await expect(
        repository.synchronizeSystemAgents([
          {
            arkAgentId: "ark-a",
            name: "Research",
            description: "",
            modelId: "model-a",
            systemPrompt: "",
            arkVersion: "1",
            status: "active",
          },
        ]),
      ).rejects.toThrow(/admin:seed/);
      expect(await repository.list()).toEqual([]);
    } finally {
      await database.close();
    }
  });
});

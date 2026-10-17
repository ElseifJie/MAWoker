import { describe, expect, it } from "vitest";
import { createRepositories } from "../packages/db/src/index.js";
import { createTestDatabase, id } from "./support/test-database.js";

async function seedUserAndDefaultAgent(
  client: Awaited<ReturnType<typeof createTestDatabase>>["client"],
  ownerUserId: string,
) {
  await client.query(
    `insert into users (id, auth_subject, email) values ($1, $2, $3)`,
    [ownerUserId, `subject-${ownerUserId}`, `${ownerUserId}@example.com`],
  );
  const agentId = id();
  await client.query(
    `insert into personal_agents
      (id, owner_user_id, ark_agent_id, name, model_id, system_prompt,
       ark_version, status, is_auto_default)
     values ($1, $2, $3, 'Assistant', 'model-a', 'Prompt', '1', 'active', true)`,
    [agentId, ownerUserId, `ark-agent-${id()}`],
  );
  return agentId;
}

describe("assistant profile repository", () => {
  it("lazily ensures, links the auto-default agent, and fences revisions", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const ownerId = id();
    const agentId = await seedUserAndDefaultAgent(database.client, ownerId);

    const created = await repositories.assistantProfiles.ensure(ownerId);
    expect(created).toMatchObject({
      ownerUserId: ownerId,
      defaultAgentId: null,
      revision: 1,
      preferences: {},
    });

    await expect(
      repositories.assistantProfiles.findDefaultAgent(ownerId),
    ).resolves.toMatchObject({ id: agentId, name: "Assistant" });

    const linked = await repositories.assistantProfiles.attachDefault(
      ownerId,
      agentId,
    );
    expect(linked).toMatchObject({
      defaultAgentId: agentId,
      revision: 2,
    });

    const updated = await repositories.assistantProfiles.update(ownerId, {
      displayName: "My Assistant",
      persona: "Concise and careful.",
      preferences: { tone: "brief" },
      expectedRevision: 2,
    });
    expect(updated).toMatchObject({
      displayName: "My Assistant",
      persona: "Concise and careful.",
      preferences: { tone: "brief" },
      revision: 3,
    });

    await expect(
      repositories.assistantProfiles.update(ownerId, {
        displayName: "Stale",
        expectedRevision: 2,
      }),
    ).resolves.toBeUndefined();
    await expect(
      repositories.assistantProfiles.update(id(), {
        displayName: "Other tenant",
        expectedRevision: 3,
      }),
    ).resolves.toBeUndefined();

    await database.close();
  });
});

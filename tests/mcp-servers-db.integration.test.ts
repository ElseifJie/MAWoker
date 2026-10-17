import { describe, expect, it } from "vitest";
import { createRepositories } from "../packages/db/src/index.js";
import {
  McpServerNameConflictError,
  McpServerService,
  ResourceNotFoundError,
} from "../packages/domain/src/index.js";
import { createTestDatabase, id } from "./support/test-database.js";

async function seedUser(
  client: Awaited<ReturnType<typeof createTestDatabase>>["client"],
) {
  const userId = id();
  await client.query(
    `insert into users (id, auth_subject, email, role)
     values ($1, $2, $3, 'user')`,
    [userId, `local:${userId}@example.com`, `${userId}@example.com`],
  );
  return userId;
}

describe("MCP server registry", () => {
  it("creates, isolates, disables, and deletes a user's servers", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const owner = await seedUser(database.client);
    const other = await seedUser(database.client);
    const service = new McpServerService({
      repository: repositories.mcpServers,
      createId: id,
      validateUrl: async (url) => url,
    });

    const server = await service.create(owner, {
      name: "Feishu",
      url: "https://mcp.example.com/mcp",
    });
    expect(await service.list(owner)).toHaveLength(1);
    expect(await service.list(other)).toEqual([]);

    await expect(
      service.create(owner, {
        name: "Feishu",
        url: "https://other.example.com/mcp",
      }),
    ).rejects.toBeInstanceOf(McpServerNameConflictError);
    await expect(
      service.setEnabled(other, server.id, false),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);

    await expect(
      service.setEnabled(owner, server.id, false),
    ).resolves.toMatchObject({ status: "disabled" });
    await service.delete(owner, server.id);
    expect(await service.list(owner)).toEqual([]);
    await database.close();
  });
});

import { describe, expect, it } from "vitest";
import { createRepositories } from "../packages/db/src/index.js";
import {
  InvalidChannelUrlError,
  maskWebhookUrl,
  NotificationChannelNameConflictError,
  NotificationChannelService,
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

describe("notification channels", () => {
  it("stores owner-scoped channels, masks URLs, and enforces names", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const owner = await seedUser(database.client);
    const other = await seedUser(database.client);
    const service = new NotificationChannelService({
      repository: repositories.notificationChannels,
      createId: id,
      validateUrl: async (url) => url,
    });

    const channel = await service.create(owner, {
      name: "Feishu",
      url: "https://open.feishu.cn/open-apis/bot/v2/hook/secret-token",
    });
    expect(maskWebhookUrl(channel.url)).toBe("https://open.feishu.cn/…oken");
    expect(await service.list(other)).toEqual([]);
    await expect(
      service.create(owner, {
        name: "Feishu",
        url: "https://other.example.com/hook",
      }),
    ).rejects.toBeInstanceOf(NotificationChannelNameConflictError);
    await expect(
      service.setEnabled(other, channel.id, false),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);

    await expect(
      service.setEnabled(owner, channel.id, false),
    ).resolves.toMatchObject({ enabled: false });
    await service.delete(owner, channel.id);
    expect(await service.list(owner)).toEqual([]);
    await database.close();
  });

  it("rejects unsafe webhook URLs", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const owner = await seedUser(database.client);
    const service = new NotificationChannelService({
      repository: repositories.notificationChannels,
      createId: id,
    });
    await expect(
      service.create(owner, { name: "bad", url: "https://127.0.0.1/hook" }),
    ).rejects.toBeInstanceOf(InvalidChannelUrlError);
    await database.close();
  });
});

import { describe, expect, it } from "vitest";
import { createRepositories } from "../packages/db/src/index.js";
import {
  AccountAlreadyDeletedError,
  AccountDeletionService,
} from "../packages/domain/src/index.js";
import { createTestDatabase, id } from "./support/test-database.js";

describe("account deletion", () => {
  it("anonymizes the account, revokes sessions, and removes connector data", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const userId = id();
    const now = new Date("2026-10-17T00:00:00.000Z");
    await database.client.query(
      `insert into users (id, auth_subject, email, password_hash, role)
       values ($1, $2, 'owner@example.com', 'secret-hash', 'user')`,
      [userId, `local:${userId}@example.com`],
    );
    await database.client.query(
      `insert into auth_sessions (id, user_id, token_hash, expires_at)
       values ($1, $2, 'hash-1', $3)`,
      [id(), userId, new Date("2026-10-24T00:00:00.000Z")],
    );
    await database.client.query(
      `insert into automations
         (id, owner_user_id, title, kind, schedule, timezone, next_run_at)
       values ($1, $2, '喝水', 'reminder', '{"type":"daily","time":"09:00"}',
               'Asia/Shanghai', $3)`,
      [id(), userId, now],
    );
    await database.client.query(
      `insert into notification_channels
         (id, owner_user_id, name, type, url)
       values ($1, $2, 'Feishu', 'webhook',
               'https://open.feishu.cn/open-apis/bot/v2/hook/x')`,
      [id(), userId],
    );
    await database.client.query(
      `insert into mcp_servers (id, owner_user_id, name, url, status)
       values ($1, $2, 'MCP', 'https://mcp.example.com/mcp', 'active')`,
      [id(), userId],
    );
    await database.client.query(
      `insert into user_memory_stores (user_id, state, revision)
       values ($1, '{"preferences":{}}', 1)`,
      [userId],
    );

    const service = new AccountDeletionService({
      repository: repositories.accountDeletion,
      now: () => now,
    });
    await service.delete(userId);

    const user = await database.client.query<{
      email: string;
      auth_subject: string;
      status: string;
      password_hash: string | null;
      account_deleted_at: string;
    }>(
      `select email, auth_subject, status, password_hash, account_deleted_at
       from users where id = $1`,
      [userId],
    );
    expect(user.rows[0]).toMatchObject({
      email: `deleted+${userId}@invalid.local`,
      auth_subject: `deleted:${userId}`,
      status: "disabled",
      password_hash: null,
    });
    expect(new Date(user.rows[0]!.account_deleted_at).toISOString()).toBe(
      now.toISOString(),
    );
    const sessions = await database.client.query<{ revoked_at: string | null }>(
      "select revoked_at from auth_sessions where user_id = $1",
      [userId],
    );
    expect(sessions.rows[0]!.revoked_at).not.toBeNull();
    const automation = await database.client.query<{ enabled: boolean }>(
      "select enabled from automations where owner_user_id = $1",
      [userId],
    );
    expect(automation.rows[0]!.enabled).toBe(false);
    for (const table of [
      "notification_channels",
      "mcp_servers",
      "user_memory_stores",
    ]) {
      const column =
        table === "user_memory_stores" ? "user_id" : "owner_user_id";
      const remaining = await database.client.query<{ count: number }>(
        `select count(*)::int as count from ${table} where ${column} = $1`,
        [userId],
      );
      expect(remaining.rows[0]!.count).toBe(0);
    }
    await expect(service.delete(userId)).rejects.toBeInstanceOf(
      AccountAlreadyDeletedError,
    );
    await database.close();
  });
});

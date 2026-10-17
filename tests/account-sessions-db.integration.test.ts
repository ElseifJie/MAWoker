import { describe, expect, it } from "vitest";
import { createRepositories } from "../packages/db/src/index.js";
import { createTestDatabase, id } from "./support/test-database.js";

describe("account auth sessions", () => {
  it("lists active sessions and revokes every other one", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const userId = id();
    const current = id();
    const other = id();
    const revoked = id();
    const now = new Date("2026-10-17T00:00:00.000Z");

    await database.client.query(
      `insert into users (id, auth_subject, email, role)
       values ($1, $2, $3, 'user')`,
      [userId, `local:${userId}@example.com`, "user@example.com"],
    );
    await database.client.query(
      `insert into auth_sessions
         (id, user_id, token_hash, expires_at, created_at, revoked_at)
       values ($1, $2, 'hash-current', $3, $4, null),
              ($5, $2, 'hash-other', $3, $4, null),
              ($6, $2, 'hash-revoked', $3, $4, $4)`,
      [
        current,
        userId,
        new Date("2026-10-24T00:00:00.000Z"),
        now,
        other,
        revoked,
      ],
    );

    const active = await repositories.authSessions.listActiveForUser(
      userId,
      now,
    );
    expect(active.map((session) => session.id).sort()).toEqual(
      [current, other].sort(),
    );

    await expect(
      repositories.authSessions.revokeOthersForUser(userId, current, now),
    ).resolves.toBe(1);
    const remaining = await repositories.authSessions.listActiveForUser(
      userId,
      now,
    );
    expect(remaining.map((session) => session.id)).toEqual([current]);
    await database.close();
  });
});

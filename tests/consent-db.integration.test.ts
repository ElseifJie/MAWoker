import { afterEach, describe, expect, it } from "vitest";
import { createRepositories } from "../packages/db/src/index.js";
import { createTestDatabase, id } from "./support/test-database.js";

describe("user consent persistence", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
  });

  it("upserts a document version, lists it, and cascades with the user", async () => {
    const database = await createTestDatabase();
    close = database.close;
    const repositories = createRepositories(database.db);
    const userId = id();
    await database.client.query(
      `insert into users (id, auth_subject, email, role)
       values ($1, $2, $3, 'user')`,
      [userId, `subject-${userId}`, `${userId}@example.com`],
    );

    const first = await repositories.consents.record({
      userId,
      document: "privacy",
      version: "2026-10-18",
      now: new Date("2026-10-18T08:00:00.000Z"),
    });
    expect(first).toEqual({
      document: "privacy",
      version: "2026-10-18",
      acceptedAt: new Date("2026-10-18T08:00:00.000Z"),
    });

    const updated = await repositories.consents.record({
      userId,
      document: "privacy",
      version: "2026-10-18",
      now: new Date("2026-10-19T08:00:00.000Z"),
    });
    expect(updated.acceptedAt).toEqual(new Date("2026-10-19T08:00:00.000Z"));

    await repositories.consents.record({
      userId,
      document: "terms",
      version: "2026-10-18",
      now: new Date("2026-10-18T08:01:00.000Z"),
    });
    const listed = await repositories.consents.listForUser(userId);
    expect(listed).toHaveLength(2);
    expect(listed.map((record) => record.document).sort()).toEqual([
      "privacy",
      "terms",
    ]);

    await database.client.query(`delete from users where id = $1`, [userId]);
    await expect(repositories.consents.listForUser(userId)).resolves.toEqual(
      [],
    );
  });
});

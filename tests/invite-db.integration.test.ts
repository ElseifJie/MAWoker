import { describe, expect, it } from "vitest";
import { createRepositories } from "../packages/db/src/index.js";
import {
  InvalidInviteError,
  InviteCodeService,
  UserEmailConflictError,
} from "../packages/domain/src/index.js";
import { createTestDatabase, id } from "./support/test-database.js";

async function seedAdmin(
  client: Awaited<ReturnType<typeof createTestDatabase>>["client"],
) {
  const adminId = id();
  await client.query(
    `insert into users (id, auth_subject, email, role)
     values ($1, $2, $3, 'admin')`,
    [adminId, `local:${adminId}@example.com`, `${adminId}@example.com`],
  );
  return adminId;
}

describe("invite codes", () => {
  it("creates a one-time invite, accepts it, and records the new user", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const adminId = await seedAdmin(database.client);
    const now = new Date("2026-10-17T00:00:00.000Z");
    const service = new InviteCodeService({
      repository: repositories.inviteCodes,
      passwordHasher: { hash: async (password) => `hash:${password}` },
      createId: id,
      now: () => now,
    });

    const { invite, code } = await service.create(adminId, {
      email: "Invitee@Example.com",
      expiresInDays: 7,
    });
    expect(invite).toMatchObject({
      email: "invitee@example.com",
      status: "pending",
    });
    expect(code.length).toBeGreaterThanOrEqual(16);

    await expect(service.accept(code, "password123")).resolves.toMatchObject({
      email: "invitee@example.com",
    });
    const user = await database.client.query<{
      email: string;
      auth_subject: string;
      password_hash: string;
      role: string;
    }>(
      "select email, auth_subject, password_hash, role from users where email = $1",
      ["invitee@example.com"],
    );
    expect(user.rows[0]).toEqual({
      email: "invitee@example.com",
      auth_subject: "local:invitee@example.com",
      password_hash: "hash:password123",
      role: "user",
    });
    await expect(service.list()).resolves.toEqual([
      expect.objectContaining({ status: "used" }),
    ]);

    await expect(service.accept(code, "password123")).rejects.toBeInstanceOf(
      InvalidInviteError,
    );
    await database.close();
  });

  it("rejects revoked, expired, unknown, and duplicate-email invites", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const adminId = await seedAdmin(database.client);
    let now = new Date("2026-10-17T00:00:00.000Z");
    const service = new InviteCodeService({
      repository: repositories.inviteCodes,
      passwordHasher: { hash: async (password) => `hash:${password}` },
      createId: id,
      now: () => now,
    });

    const revoked = await service.create(adminId, {
      email: "revoked@example.com",
    });
    await service.revoke(adminId, revoked.invite.id);
    await expect(
      service.accept(revoked.code, "password123"),
    ).rejects.toBeInstanceOf(InvalidInviteError);

    const expiring = await service.create(adminId, {
      email: "expired@example.com",
      expiresInDays: 1,
    });
    now = new Date("2026-10-19T00:00:00.000Z");
    await expect(
      service.accept(expiring.code, "password123"),
    ).rejects.toBeInstanceOf(InvalidInviteError);
    await expect(service.list()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          email: "expired@example.com",
          status: "expired",
        }),
      ]),
    );

    await expect(
      service.accept("too-short", "password123"),
    ).rejects.toBeInstanceOf(InvalidInviteError);
    await expect(
      service.accept("unknown-code-that-is-long-enough", "password123"),
    ).rejects.toBeInstanceOf(InvalidInviteError);

    // Create the account through a first invite, then reuse the email.
    const first = await service.create(adminId, {
      email: "duplicate@example.com",
    });
    await service.accept(first.code, "password123");
    const second = await service.create(adminId, {
      email: "duplicate@example.com",
    });
    await expect(
      service.accept(second.code, "password123"),
    ).rejects.toBeInstanceOf(UserEmailConflictError);
    await database.close();
  });
});

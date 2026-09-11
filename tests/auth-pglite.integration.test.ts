import { describe, expect, it } from "vitest";
import {
  ApplicationSessionService,
  AuthRequiredError,
  hashPassword,
} from "../packages/auth/src/index.js";
import { buildApp } from "../apps/api/src/app.js";
import {
  createAuthStore,
  createRepositories,
} from "../packages/db/src/index.js";
import { createTestDatabase } from "./support/test-database.js";

const password = "integration-password";

async function seedUser(
  database: Awaited<ReturnType<typeof createTestDatabase>>,
  email: string,
  passwordHash: string | null,
): Promise<void> {
  await database.client.query(
    `insert into users (id, auth_subject, email, password_hash, role, status)
     values (gen_random_uuid(), $1, $2, $3, 'user', 'active')`,
    [`local:${email}`, email, passwordHash],
  );
}

describe("database auth store", () => {
  it("signs in with a stored password hash and enforces revocation and user status", async () => {
    const database = await createTestDatabase();
    let tokenSequence = 0;
    const service = new ApplicationSessionService({
      store: createAuthStore(database.db),
      randomToken: () => `opaque-database-token-${tokenSequence++}`,
    });
    await seedUser(database, "user@example.com", await hashPassword(password));

    const issued = await service.login("User@Example.com", password);
    const stored = await database.client.query<{
      token_hash: string;
      email: string;
      role: string;
    }>(
      `select s.token_hash, u.email, u.role
         from auth_sessions s
         join users u on u.id = s.user_id`,
    );

    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]).toMatchObject({
      email: "user@example.com",
      role: "user",
    });
    expect(stored.rows[0]?.token_hash).not.toContain(issued.token);
    await expect(service.authenticate(issued.token)).resolves.toMatchObject({
      role: "user",
    });

    await expect(
      service.login("user@example.com", "wrong-password"),
    ).rejects.toBeInstanceOf(AuthRequiredError);

    await service.logout(issued.token);
    await expect(service.authenticate(issued.token)).rejects.toBeInstanceOf(
      AuthRequiredError,
    );

    const disabledSession = await service.login("user@example.com", password);
    await database.client.query(
      `update users set status = 'disabled' where email = $1`,
      ["user@example.com"],
    );
    await expect(
      service.authenticate(disabledSession.token),
    ).rejects.toBeInstanceOf(AuthRequiredError);
    await expect(service.renew(disabledSession.token)).rejects.toBeInstanceOf(
      AuthRequiredError,
    );
    await expect(
      service.login("user@example.com", password),
    ).rejects.toBeInstanceOf(AuthRequiredError);
    await database.close();
  });

  it("normalizes credential failures at the HTTP boundary", async () => {
    const database = await createTestDatabase();
    const service = new ApplicationSessionService({
      store: createAuthStore(database.db),
    });
    const app = buildApp({ auth: service });

    try {
      await seedUser(
        database,
        "user@example.com",
        await hashPassword(password),
      );

      const wrongPassword = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: "user@example.com", password: "not-the-password" },
      });

      await database.client.query(
        `update users set status = 'disabled' where email = $1`,
        ["user@example.com"],
      );
      const disabledUser = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: "user@example.com", password },
      });

      expect(wrongPassword.statusCode).toBe(401);
      expect(disabledUser.statusCode).toBe(401);
      expect(disabledUser.json().error).toMatchObject({
        code: wrongPassword.json().error.code,
        message: wrongPassword.json().error.message,
        retryable: wrongPassword.json().error.retryable,
      });
      expect(disabledUser.headers["set-cookie"]).toBeUndefined();
    } finally {
      await app.close();
      await database.close();
    }
  });

  it("signs in a user created through the administration repository", async () => {
    const database = await createTestDatabase();
    const service = new ApplicationSessionService({
      store: createAuthStore(database.db),
      randomToken: () => "created-user-token",
    });
    await database.client.query(
      `insert into users (id, auth_subject, email, password_hash, role, status)
       values (gen_random_uuid(), 'local:admin@example.com',
               'admin@example.com', null, 'admin', 'active')`,
    );
    await database.client.query(
      `insert into quota_policies
         (key, personal_agent_limit, concurrent_session_limit,
          daily_session_limit, monthly_token_limit)
       values ('default', 10, 2, 25, 1000000)`,
    );
    const repositories = createRepositories(database.db);
    const repository = repositories.platformAgents as unknown as {
      listUsers(): Promise<Array<{ email: string; hasPassword: boolean }>>;
      createUser(input: {
        id: string;
        authSubject: string;
        email: string;
        passwordHash: string;
        role: "user" | "admin";
        createdBy: string;
      }): Promise<{ id: string } | undefined>;
    };
    const admin = await database.client.query<{ id: string }>(
      "select id from users where email = 'admin@example.com'",
    );

    const created = await repository.createUser({
      id: "00000000-0000-4000-8000-0000000000aa",
      authSubject: "local:newcomer@example.com",
      email: "newcomer@example.com",
      passwordHash: await hashPassword(password),
      role: "user",
      createdBy: admin.rows[0]!.id,
    });

    expect(created).toBeDefined();
    const listed = await repository.listUsers();
    expect(listed.map((user) => user.email)).toEqual([
      "admin@example.com",
      "newcomer@example.com",
    ]);
    expect(listed.map((user) => user.hasPassword)).toEqual([false, true]);

    const issued = await service.login("Newcomer@Example.com", password);
    await expect(service.authenticate(issued.token)).resolves.toMatchObject({
      role: "user",
    });
    await database.close();
  });
});

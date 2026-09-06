import { describe, expect, it } from "vitest";
import {
  ApplicationSessionService,
  AuthRequiredError,
  DeterministicManagedIdentityStub,
} from "../packages/auth/src/index.js";
import { buildApp } from "../apps/api/src/app.js";
import { createAuthStore } from "../packages/db/src/index.js";
import { createTestDatabase } from "./support/test-database.js";

describe("database auth store", () => {
  it("provisions users and enforces session revocation and user status", async () => {
    const database = await createTestDatabase();
    const identity = new DeterministicManagedIdentityStub({ code: "123456" });
    let tokenSequence = 0;
    const service = new ApplicationSessionService({
      identity,
      store: createAuthStore(database.db),
      randomToken: () => `opaque-database-token-${tokenSequence++}`,
    });
    await service.requestEmailCode("User@Example.com");

    const issued = await service.verifyEmailCode("user@example.com", "123456");
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

    await service.logout(issued.token);
    await expect(service.authenticate(issued.token)).rejects.toBeInstanceOf(
      AuthRequiredError,
    );

    await service.requestEmailCode("user@example.com");
    const disabledSession = await service.verifyEmailCode(
      "user@example.com",
      "123456",
    );
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
    await database.close();
  });

  it("normalizes disabled-user verification at the HTTP boundary", async () => {
    const database = await createTestDatabase();
    const identity = new DeterministicManagedIdentityStub({ code: "123456" });
    const service = new ApplicationSessionService({
      identity,
      store: createAuthStore(database.db),
    });
    const app = buildApp({ auth: service });

    try {
      await service.requestEmailCode("user@example.com");
      const invalidCode = await app.inject({
        method: "POST",
        url: "/api/v1/auth/verify",
        payload: { email: "user@example.com", code: "invalid" },
      });
      await service.verifyEmailCode("user@example.com", "123456");
      await database.client.query(
        `update users set status = 'disabled' where email = $1`,
        ["user@example.com"],
      );
      await service.requestEmailCode("user@example.com");

      const disabledUser = await app.inject({
        method: "POST",
        url: "/api/v1/auth/verify",
        payload: { email: "user@example.com", code: "123456" },
      });

      expect(invalidCode.statusCode).toBe(401);
      expect(disabledUser.statusCode).toBe(401);
      expect(disabledUser.json().error).toMatchObject({
        code: invalidCode.json().error.code,
        message: invalidCode.json().error.message,
        retryable: invalidCode.json().error.retryable,
      });
      expect(disabledUser.headers["set-cookie"]).toBeUndefined();
    } finally {
      await app.close();
      await database.close();
    }
  });
});

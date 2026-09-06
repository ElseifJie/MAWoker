import { describe, expect, it } from "vitest";
import { parseServerConfig } from "../packages/config/src/index.js";

const valid = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://localhost/pwa",
  APP_ORIGIN: "http://localhost:5173",
  OIDC_ISSUER: "https://identity.example.com",
  OIDC_CLIENT_ID: "client",
  OIDC_CLIENT_SECRET: "secret",
  ARK_API_BASE_URL: "https://ark.example.com",
  ARK_API_KEY: "ark-secret",
  ARK_ENVIRONMENT_ID: "env-1",
  TOS_ENDPOINT: "https://tos.example.com",
  TOS_BUCKET: "private",
  MODEL_ALLOWLIST: "model-a,model-b",
  OUTBOUND_HOST_ALLOWLIST: "ark.example.com,tos.example.com",
  SESSION_DAILY_LIMIT: "25",
  MONTHLY_TOKEN_LIMIT: "1000000",
};

describe("server configuration", () => {
  it("parses allowlists and defaults", () => {
    const config = parseServerConfig(valid);

    expect(config.modelAllowlist).toEqual(["model-a", "model-b"]);
    expect(config.personalAgentLimit).toBe(10);
    expect(config.concurrentSessionLimit).toBe(2);
  });

  it.each(["mysql://localhost/pwa", "https://localhost/pwa"])(
    "rejects non-PostgreSQL database URL %s",
    (databaseUrl) => {
      expect(() =>
        parseServerConfig({ ...valid, DATABASE_URL: databaseUrl }),
      ).toThrow(/DATABASE_URL/);
    },
  );

  it.each(["MODEL_ALLOWLIST", "OUTBOUND_HOST_ALLOWLIST"] as const)(
    "rejects a normalized-empty %s",
    (name) => {
      expect(() => parseServerConfig({ ...valid, [name]: " , " })).toThrow(
        new RegExp(name),
      );
    },
  );

  it.each(["SESSION_DAILY_LIMIT", "MONTHLY_TOKEN_LIMIT"] as const)(
    "rejects a blank %s",
    (name) => {
      expect(() => parseServerConfig({ ...valid, [name]: "   " })).toThrow(
        new RegExp(name),
      );
    },
  );

  it("fails readiness configuration without the server-only Ark key", () => {
    const invalid: Record<string, string> = { ...valid };
    delete invalid.ARK_API_KEY;

    expect(() => parseServerConfig(invalid)).toThrow(/ARK_API_KEY/);
  });

  it("does not expose secrets in its public projection", () => {
    const config = parseServerConfig(valid);

    expect(JSON.stringify(config.public)).not.toContain("ark-secret");
    expect(JSON.stringify(config.public)).not.toContain("secret");
  });
});

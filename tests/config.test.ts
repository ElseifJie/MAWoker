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
  TOS_REGION: "cn-beijing",
  TOS_ACCESS_KEY_ID: "tos-access-key",
  TOS_SECRET_ACCESS_KEY: "tos-secret-key",
  MODEL_ALLOWLIST: "model-a,model-b",
  OUTBOUND_HOST_ALLOWLIST: "ark.example.com,tos.example.com",
  SESSION_DAILY_LIMIT: "25",
  MONTHLY_TOKEN_LIMIT: "1000000",
  API_RATE_LIMIT_MAX: "120",
  API_RATE_LIMIT_WINDOW_MS: "60000",
  ARK_REQUEST_TIMEOUT_MS: "15000",
  ARK_MAX_ATTEMPTS: "3",
  ARK_RETRY_BASE_DELAY_MS: "100",
  ARK_RETRY_MAX_DELAY_MS: "2000",
  HEALTH_DB_TIMEOUT_MS: "1000",
  WORKER_HEALTH_HOST: "0.0.0.0",
  WORKER_HEALTH_PORT: "3001",
  WORKER_POLL_INTERVAL_MS: "1000",
};

describe("server configuration", () => {
  it("parses allowlists and defaults", () => {
    const config = parseServerConfig(valid);

    expect(config.modelAllowlist).toEqual(["model-a", "model-b"]);
    expect(config.personalAgentLimit).toBe(10);
    expect(config.concurrentSessionLimit).toBe(2);
    expect(config.apiRateLimit).toEqual({ max: 120, windowMs: 60_000 });
    expect(config.ark.requestTimeoutMs).toBe(15_000);
    expect(config.ark.maxAttempts).toBe(3);
    expect(config.health.databaseTimeoutMs).toBe(1_000);
    expect(config.worker).toEqual({
      healthHost: "0.0.0.0",
      healthPort: 3_001,
      pollIntervalMs: 1_000,
    });
  });

  it("derives the TOS S3-compatible endpoint for the configured region", () => {
    const config = parseServerConfig({
      ...valid,
      NODE_ENV: "production",
      TOS_ENDPOINT: "https://tos-cn-beijing.volces.com",
      OUTBOUND_HOST_ALLOWLIST: "ark.example.com,tos-s3-cn-beijing.volces.com",
    });

    expect(config.tos.endpoint).toBe("https://tos-s3-cn-beijing.volces.com");
  });

  it("preserves a matching TOS S3-compatible endpoint", () => {
    const config = parseServerConfig({
      ...valid,
      NODE_ENV: "production",
      TOS_ENDPOINT: "https://tos-s3-cn-beijing.volces.com",
      OUTBOUND_HOST_ALLOWLIST: "ark.example.com,tos-s3-cn-beijing.volces.com",
    });

    expect(config.tos.endpoint).toBe("https://tos-s3-cn-beijing.volces.com");
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

  it.each([
    "TOS_ENDPOINT",
    "TOS_BUCKET",
    "TOS_REGION",
    "TOS_ACCESS_KEY_ID",
    "TOS_SECRET_ACCESS_KEY",
  ] as const)("fails readiness configuration without %s", (name) => {
    const invalid: Record<string, string> = { ...valid };
    delete invalid[name];

    expect(() => parseServerConfig(invalid)).toThrow(new RegExp(name));
  });

  it.each(["ftp://tos.example.com", "https://tos.example.com/storage"])(
    "rejects an unusable TOS endpoint %s",
    (endpoint) => {
      expect(() =>
        parseServerConfig({ ...valid, TOS_ENDPOINT: endpoint }),
      ).toThrow(/TOS_ENDPOINT/);
    },
  );

  it.each([
    ["production", "http://tos-s3-cn-beijing.volces.com"],
    ["development", "http://tos-s3-cn-beijing.volces.com"],
    ["production", "https://tos-s3-cn-guangzhou.volces.com"],
    ["production", "https://tos-s3-cn-beijing.volces.com:8443"],
    ["production", "https://storage.example.com"],
  ])("rejects incompatible TOS endpoint in %s: %s", (nodeEnv, endpoint) => {
    expect(() =>
      parseServerConfig({
        ...valid,
        NODE_ENV: nodeEnv,
        TOS_ENDPOINT: endpoint,
      }),
    ).toThrow(/TOS_ENDPOINT/);
  });

  it.each(["test", "development"])(
    "permits an HTTP localhost S3-compatible test endpoint in %s",
    (nodeEnv) => {
      const config = parseServerConfig({
        ...valid,
        NODE_ENV: nodeEnv,
        TOS_ENDPOINT: "http://127.0.0.1:9000",
        OUTBOUND_HOST_ALLOWLIST: "ark.example.com,127.0.0.1",
      });

      expect(config.tos.endpoint).toBe("http://127.0.0.1:9000");
    },
  );

  it("does not expose secrets in its public projection", () => {
    const config = parseServerConfig(valid);

    expect(JSON.stringify(config.public)).not.toContain("ark-secret");
    expect(JSON.stringify(config.public)).not.toContain("secret");
  });

  it.each([
    ["APP_ORIGIN", "https://assistant.example.com/path"],
    ["APP_ORIGIN", "https://user:pass@assistant.example.com"],
    ["API_RATE_LIMIT_MAX", "0"],
    ["API_RATE_LIMIT_WINDOW_MS", "0"],
    ["ARK_REQUEST_TIMEOUT_MS", "0"],
    ["ARK_MAX_ATTEMPTS", "0"],
    ["HEALTH_DB_TIMEOUT_MS", "0"],
    ["WORKER_HEALTH_PORT", "70000"],
    ["WORKER_POLL_INTERVAL_MS", "0"],
  ])("rejects unsafe process configuration %s=%s", (name, value) => {
    expect(() => parseServerConfig({ ...valid, [name]: value })).toThrow(
      new RegExp(name),
    );
  });

  it("requires Ark and TOS endpoints to be in the outbound host allowlist", () => {
    expect(() =>
      parseServerConfig({
        ...valid,
        OUTBOUND_HOST_ALLOWLIST: "unrelated.example.com",
      }),
    ).toThrow(/OUTBOUND_HOST_ALLOWLIST/);
  });
});

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../apps/api/src/app.js";

const root = resolve(import.meta.dirname, "..");

function read(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

function readPackage(path = "package.json") {
  return JSON.parse(read(path)) as {
    scripts?: Record<string, string>;
  };
}

describe("production container structure", () => {
  it("rejects resets with durable memory manifests before any mutation", () => {
    const reset = read("scripts/reset-data.ts");
    const preflight = reset.indexOf("select 1 from user_memory_stores");
    const rejection = reset.indexOf("throw new Error(", preflight);
    const truncate = reset.indexOf("`truncate table");

    expect(preflight).toBeGreaterThan(-1);
    expect(rejection).toBeGreaterThan(preflight);
    expect(truncate).toBeGreaterThan(rejection);
    expect(reset.indexOf("await ensureDefaultQuotaPolicy")).toBeGreaterThan(
      rejection,
    );
    expect(reset.indexOf("await ensureAdministrator")).toBeGreaterThan(
      rejection,
    );
  });

  it("builds one non-root OCI image with every runtime artifact", () => {
    const dockerfile = read("Dockerfile");

    expect(dockerfile).toMatch(/^FROM node:22-bookworm-slim AS build/m);
    expect(dockerfile).toContain("npm ci");
    expect(dockerfile).toContain("npm run build");
    expect(dockerfile).toContain("npm prune --omit=dev");
    expect(dockerfile).toContain("apps/web/dist");
    expect(dockerfile).toContain("apps/api/dist");
    expect(dockerfile).toContain("apps/worker/dist");
    expect(dockerfile).toContain("packages/db/migrations");
    expect(dockerfile).toContain("USER node");
    expect(dockerfile).toContain("HEALTHCHECK");
    expect(dockerfile).toContain('CMD ["npm", "run", "start:api"]');
    expect(existsSync(resolve(root, ".dockerignore"))).toBe(true);
  });

  it("provides distinct API, worker, migration, and healthcheck commands", () => {
    expect(readPackage().scripts).toMatchObject({
      "start:api": "npm run start -w @pwa/api",
      "start:worker": "npm run start -w @pwa/worker",
      "db:migrate": "npm run db:migrate -w @pwa/db",
      healthcheck: "node scripts/container-healthcheck.mjs",
      "healthcheck:api": "node scripts/container-healthcheck.mjs api",
      "healthcheck:worker": "node scripts/container-healthcheck.mjs worker",
    });
    expect(readPackage("packages/db/package.json").scripts).toMatchObject({
      "db:migrate": "node --env-file=../../.env dist/migrate.js",
    });
    expect(existsSync(resolve(root, "scripts/container-healthcheck.mjs"))).toBe(
      true,
    );
  });

  it("keeps .env.example synchronized with validated runtime settings", () => {
    const keys = new Set(
      read(".env.example")
        .split("\n")
        .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
        .map((line) => line.slice(0, line.indexOf("="))),
    );

    expect(keys).toEqual(
      new Set([
        "NODE_ENV",
        "DATABASE_URL",
        "APP_ORIGIN",
        "OIDC_ISSUER",
        "OIDC_CLIENT_ID",
        "OIDC_CLIENT_SECRET",
        "ARK_API_BASE_URL",
        "ARK_API_KEY",
        "ARK_ENVIRONMENT_ID",
        "SYSTEM_AGENT_IDS",
        "ARK_REQUEST_TIMEOUT_MS",
        "ARK_MAX_ATTEMPTS",
        "ARK_RETRY_BASE_DELAY_MS",
        "ARK_RETRY_MAX_DELAY_MS",
        "TOS_ENDPOINT",
        "TOS_BUCKET",
        "TOS_REGION",
        "TOS_ACCESS_KEY_ID",
        "TOS_SECRET_ACCESS_KEY",
        "TOS_SESSION_TOKEN",
        "MODEL_ALLOWLIST",
        "OUTBOUND_HOST_ALLOWLIST",
        "DRIVE_ORPHAN_RETENTION_MS",
        "MEMORY_BYTE_BUDGET",
        "MEMORY_DREAM_MODEL",
        "MEMORY_MONITOR_INTERVAL_MS",
        "MEMORY_COOLDOWN_MS",
        "PERSONAL_AGENT_LIMIT",
        "CONCURRENT_SESSION_LIMIT",
        "SESSION_DAILY_LIMIT",
        "SESSION_SUBMISSION_ADMISSION_ENABLED",
        "FILE_REUSE_ADMISSION_ENABLED",
        "SESSION_HISTORY_ENABLED",
        "SESSION_DELIVERY_ENABLED",
        "SESSION_HISTORY_BATCH_SIZE",
        "SESSION_HISTORY_COOLDOWN_MS",
        "SESSION_HISTORY_TIMEOUT_MS",
        "SESSION_DELIVERY_BATCH_SIZE",
        "SESSION_DELIVERY_TIMEOUT_MS",
        "SESSION_EVENT_SOURCE",
        "SESSION_EVENT_INGESTOR_ENABLED",
        "SESSION_EVENT_INGESTOR_LEASE_MS",
        "SESSION_EVENT_INGESTOR_BUDGET_MS",
        "SESSION_EVENT_INGESTOR_BATCH_SIZE",
        "SESSION_ARTIFACT_RETRY_WINDOW_MS",
        "SESSION_ARTIFACT_EMPTY_GRACE_MS",
        "MONTHLY_TOKEN_LIMIT",
        "API_RATE_LIMIT_MAX",
        "API_RATE_LIMIT_WINDOW_MS",
        "PORT",
        "HEALTH_DB_TIMEOUT_MS",
        "WORKER_HEALTH_HOST",
        "WORKER_HEALTH_PORT",
        "WORKER_POLL_INTERVAL_MS",
      ]),
    );
  });

  it("serves the built SPA and BrowserRouter deep links from the API origin", async () => {
    const app = buildApp({
      webRoot: resolve(root, "apps/web/dist"),
    });

    const rootResponse = await app.inject({ method: "GET", url: "/" });
    const agentsResponse = await app.inject({
      method: "GET",
      url: "/agents",
    });
    const deepLinkResponse = await app.inject({
      method: "GET",
      url: "/sessions/00000000-0000-4000-8000-000000000099",
    });

    expect(rootResponse.statusCode).toBe(200);
    expect(rootResponse.headers["content-type"]).toContain("text/html");
    expect(rootResponse.body).toContain('<div id="root"></div>');
    expect(agentsResponse.statusCode).toBe(200);
    expect(agentsResponse.headers["content-type"]).toContain("text/html");
    expect(agentsResponse.body).toBe(rootResponse.body);
    expect(deepLinkResponse.statusCode).toBe(200);
    expect(deepLinkResponse.headers["content-type"]).toContain("text/html");
    expect(deepLinkResponse.body).toBe(rootResponse.body);
    await app.close();
  });

  it("does not use the SPA fallback for missing assets, APIs, or health routes", async () => {
    const app = buildApp({
      webRoot: resolve(root, "apps/web/dist"),
    });

    const responses = await Promise.all([
      app.inject({ method: "GET", url: "/assets/missing.js" }),
      app.inject({ method: "GET", url: "/api/v1/missing" }),
      app.inject({ method: "GET", url: "/health/missing" }),
    ]);

    expect(responses.map(({ statusCode }) => statusCode)).toEqual([
      404, 404, 404,
    ]);
    expect(
      responses.every(
        ({ headers }) => !headers["content-type"]?.includes("text/html"),
      ),
    ).toBe(true);
    await app.close();
  });

  it.each(["/assets/missing", "/assets/missing.js/child"])(
    "does not use the SPA fallback for missing static path %s",
    async (url) => {
      const app = buildApp({
        webRoot: resolve(root, "apps/web/dist"),
      });

      const response = await app.inject({ method: "GET", url });

      expect(response.statusCode).toBe(404);
      expect(response.headers["content-type"]).not.toContain("text/html");
      await app.close();
    },
  );

  it.each(["/@vite/client", "/@react-refresh"])(
    "does not use the SPA fallback for Vite resource path %s",
    async (url) => {
      const app = buildApp({
        webRoot: resolve(root, "apps/web/dist"),
      });

      const response = await app.inject({ method: "GET", url });

      expect(response.statusCode).toBe(404);
      expect(response.headers["content-type"]).not.toContain("text/html");
      await app.close();
    },
  );
});

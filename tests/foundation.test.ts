import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(root, path), "utf8")) as Record<
    string,
    unknown
  >;
}

const serverEnvironment = {
  ...process.env,
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
  MODEL_ALLOWLIST: "model-a",
  OUTBOUND_HOST_ALLOWLIST: "ark.example.com,tos.example.com",
  SESSION_DAILY_LIMIT: "25",
  MONTHLY_TOKEN_LIMIT: "1000000",
};

describe("modular monolith foundation", () => {
  it.each(["package.json", "apps/web/package.json"])(
    "requires Node.js >=22.12 in %s",
    (packagePath) => {
      expect(readJson(packagePath)).toMatchObject({
        engines: { node: ">=22.12" },
      });
    },
  );

  it.each(["web", "api", "worker"])(
    "defines the %s application workspace",
    (name) => {
      const packagePath = `apps/${name}/package.json`;

      expect(existsSync(resolve(root, packagePath))).toBe(true);
      expect(readJson(packagePath)).toMatchObject({
        name: `@pwa/${name}`,
        private: true,
      });
    },
  );

  it.each(["db", "ark-client", "auth", "domain", "ui"])(
    "defines the shared %s package",
    (name) => {
      const packagePath = `packages/${name}/package.json`;

      expect(existsSync(resolve(root, packagePath))).toBe(true);
      expect(readJson(packagePath)).toMatchObject({
        name: `@pwa/${name}`,
        private: true,
      });
    },
  );

  it("keeps server secrets out of the web package and public environment", () => {
    const webPackage = JSON.stringify(readJson("apps/web/package.json"));
    const exampleEnvironment = readFileSync(
      resolve(root, ".env.example"),
      "utf8",
    );

    expect(webPackage).not.toContain("@pwa/config");
    expect(webPackage).not.toContain("ARK_API_KEY");
    expect(exampleEnvironment).toContain("ARK_API_KEY=");
    expect(exampleEnvironment).not.toContain("VITE_ARK_API_KEY");
  });

  it("exposes an API health check only after server config is valid", async () => {
    const entry = resolve(root, "apps/api/src/app.ts");

    expect(existsSync(entry)).toBe(true);

    const { buildApp } = await import("../apps/api/src/app.js");
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("rejects invalid config before starting the API health endpoint", async () => {
    const invalidEnvironment: NodeJS.ProcessEnv = { ...serverEnvironment };
    delete invalidEnvironment.ARK_API_KEY;

    const api = spawn(
      process.execPath,
      ["--import", "tsx", "apps/api/src/index.ts"],
      {
        cwd: root,
        env: invalidEnvironment,
        stdio: ["ignore", "ignore", "pipe"],
      },
    );

    let stderr = "";
    api.stderr.setEncoding("utf8");
    api.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      api.kill("SIGTERM");
    }, 1_000);
    const [exitCode] = await once(api, "exit");
    clearTimeout(timeout);

    expect(timedOut).toBe(false);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("ARK_API_KEY");
  });

  it("keeps the worker process alive until shutdown", async () => {
    const worker = spawn(
      process.execPath,
      ["--import", "tsx", "apps/worker/src/index.ts"],
      {
        cwd: root,
        env: serverEnvironment,
        stdio: "ignore",
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(worker.exitCode).toBeNull();
    worker.kill("SIGTERM");
  });
});

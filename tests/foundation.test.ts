import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const startupTimeoutMs = 15_000;
const testTimeoutMs = 20_000;

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
  TOS_ENDPOINT: "https://tos-s3-cn-beijing.volces.com",
  TOS_BUCKET: "private",
  TOS_REGION: "cn-beijing",
  TOS_ACCESS_KEY_ID: "tos-access-key",
  TOS_SECRET_ACCESS_KEY: "tos-secret-key",
  MODEL_ALLOWLIST: "model-a",
  OUTBOUND_HOST_ALLOWLIST: "ark.example.com,tos-s3-cn-beijing.volces.com",
  SESSION_DAILY_LIMIT: "25",
  MONTHLY_TOKEN_LIMIT: "1000000",
};

async function availablePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to reserve a test port");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return child.exitCode;
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      child.kill("SIGKILL");
      reject(new Error(`Subprocess did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    const exited = (code: number | null) => {
      cleanup();
      resolve(code);
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("exit", exited);
      child.off("error", failed);
    };
    child.once("exit", exited);
    child.once("error", failed);
  });
}

async function stopSubprocess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  try {
    await waitForExit(child, 5_000);
  } catch {
    if (child.exitCode === null) child.kill("SIGKILL");
    await waitForExit(child, 5_000);
  }
}

async function waitForApi(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `API subprocess exited with code ${child.exitCode} and signal ${child.signalCode}`,
      );
    }
    try {
      const response = await fetch(`${url}/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return;
    } catch {
      // The subprocess has not started listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("API subprocess did not become ready");
}

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

  it(
    "rejects invalid config before starting the API health endpoint",
    async () => {
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

      const exitCode = await waitForExit(api, 10_000);

      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("ARK_API_KEY");
    },
    testTimeoutMs,
  );

  it(
    "starts the production API entrypoint with secure cookies",
    async () => {
      const port = await availablePort();
      const api = spawn(
        process.execPath,
        ["--import", "tsx", "apps/api/src/index.ts"],
        {
          cwd: root,
          env: {
            ...serverEnvironment,
            NODE_ENV: "production",
            PORT: String(port),
          },
          stdio: "ignore",
        },
      );

      try {
        const origin = `http://127.0.0.1:${port}`;
        await waitForApi(origin, api);
        const response = await fetch(`${origin}/api/v1/auth/logout`, {
          method: "POST",
        });

        expect(response.status).toBe(204);
        expect(response.headers.get("set-cookie")).toContain("Secure");
      } finally {
        await stopSubprocess(api);
      }
    },
    testTimeoutMs,
  );

  it(
    "wires user Agent and Session routes in the production API entrypoint",
    async () => {
      const port = await availablePort();
      const api = spawn(
        process.execPath,
        ["--import", "tsx", "apps/api/src/index.ts"],
        {
          cwd: root,
          env: {
            ...serverEnvironment,
            PORT: String(port),
          },
          stdio: "ignore",
        },
      );

      try {
        const origin = `http://127.0.0.1:${port}`;
        await waitForApi(origin, api);
        const [agents, sessions, artifacts, emailCode] = await Promise.all([
          fetch(`${origin}/api/v1/agents`),
          fetch(`${origin}/api/v1/sessions`),
          fetch(`${origin}/api/v1/artifacts`),
          fetch(`${origin}/api/v1/auth/email-code`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email: "user@example.com" }),
          }),
        ]);

        expect(agents.status).toBe(401);
        expect(sessions.status).toBe(401);
        expect(artifacts.status).toBe(401);
        expect(emailCode.status).toBe(401);
      } finally {
        await stopSubprocess(api);
      }
    },
    testTimeoutMs,
  );

  it(
    "keeps the worker process alive until shutdown",
    async () => {
      const worker = spawn(
        process.execPath,
        ["--import", "tsx", "apps/worker/src/index.ts"],
        {
          cwd: root,
          env: serverEnvironment,
          stdio: "ignore",
        },
      );

      try {
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(worker.exitCode).toBeNull();
      } finally {
        await stopSubprocess(worker);
      }
    },
    testTimeoutMs,
  );
});

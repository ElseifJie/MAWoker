import { PGlite } from "@electric-sql/pglite";
import { AuthRequiredError } from "@pwa/auth";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { resolve } from "node:path";
import { buildApp, type ApiAuthService } from "../../apps/api/src/app.js";
import { InMemoryArkGateway } from "../../packages/ark-client/src/stub.js";
import { createMemoryRepository } from "../../packages/db/src/memory-repository.js";
import * as schema from "../../packages/db/src/schema.js";
import { MemoryService } from "../../packages/domain/src/memory.js";
import type { AgentList, UsageSummary } from "../../apps/web/src/api.js";

const port = Number(process.env.MEMORY_E2E_PORT ?? 4183);
const origin = `http://127.0.0.1:${port}`;
const users = {
  A: {
    id: "00000000-0000-4000-8000-000000000001",
    email: "user-a@example.com",
  },
  B: {
    id: "00000000-0000-4000-8000-000000000002",
    email: "user-b@example.com",
  },
};
const expiresAt = () => new Date(Date.now() + 60 * 60 * 1000);
const auth: ApiAuthService = {
  async login(email, password) {
    const token = Object.entries(users).find(
      ([, user]) => user.email === email,
    )?.[0];
    if (!token || password !== "acceptance-password") {
      throw new AuthRequiredError();
    }
    return { token, expiresAt: expiresAt() };
  },
  async authenticate(token) {
    const user = token === "A" || token === "B" ? users[token] : undefined;
    if (!user) throw new AuthRequiredError();
    return {
      userId: user.id,
      authSubject: `local:${user.email}`,
      role: "user",
    };
  },
  async renew(token) {
    await this.authenticate(token);
    return { expiresAt: expiresAt() };
  },
  async logout() {},
};

// No dataDir, environment loader, production credentials or network gateway.
const client = new PGlite();
const db = drizzle(client, { schema });
await migrate(db, {
  migrationsFolder: resolve(
    import.meta.dirname,
    "../../packages/db/migrations",
  ),
});
await db.insert(schema.users).values(
  Object.values(users).map((user) => ({
    ...user,
    authSubject: `local:${user.email}`,
  })),
);
const ark = new InMemoryArkGateway();
const memory = new MemoryService({
  repository: createMemoryRepository(db),
  ark,
  modelId: "",
});
for (const user of Object.values(users)) {
  await memory.ensure(user.id);
  await memory.settings(user.id, false);
}
const storeId = await memory.ensure(users.A.id);
// Model upstream event writes; compression must pack these real gateway entries.
await ark.createMemory(storeId, {
  path: "/episodes/digest/acceptance/one.md",
  content: "First acceptance event: budget 8000.",
});
await ark.createMemory(storeId, {
  path: "/episodes/digest/acceptance/two.md",
  content: "Second acceptance event: review Friday.",
});

const app = buildApp({
  auth,
  memory,
  isProduction: false,
  appOrigin: origin,
  webRoot: resolve(import.meta.dirname, "../../apps/web/dist"),
  logStream: { write() {} },
});

// buildApp's global authorization hook also protects these bootstrap fixtures.
app.get("/api/v1/agents", async (): Promise<AgentList> => ({
  agents: [],
  selection: null,
  blocker: {
    code: "NO_DEFAULT_AGENT",
    message: "No Agent is needed for the isolated Memory acceptance test.",
  },
}));
app.get("/api/v1/sessions", async () => ({
  sessions: [],
  nextCursor: null,
}));
app.get("/api/v1/usage", async (): Promise<UsageSummary> => ({
  period: {
    startsAt: "2026-10-01T00:00:00.000Z",
    endsAt: "2026-11-01T00:00:00.000Z",
  },
  quota: {
    personalAgentLimit: 10,
    concurrentSessionLimit: 3,
    dailySessionLimit: 30,
    monthlyTokenLimit: 100000,
  },
  usage: {
    personalAgents: 0,
    concurrentSessions: 0,
    dailySessions: 0,
    inputTokens: 0,
    outputTokens: 0,
    tokens: 0,
    runtimeMs: 0,
    toolCalls: 0,
  },
  exhausted: {
    personalAgents: false,
    concurrentSessions: false,
    dailySessions: false,
    monthlyTokens: false,
  },
}));

// Advance only explicitly queued runs, never runOnce's automatic monitoring.
// Track the in-flight tick so shutdown cannot close PGlite underneath it.
let tick: Promise<void> | undefined;
const timer = setInterval(() => {
  if (tick) return;
  tick = (async () => {
    for (const user of Object.values(users)) {
      const state = await memory.status(user.id);
      if (state.run && !["completed", "failed"].includes(state.run.stage)) {
        await memory.advance(user.id);
      }
    }
    if (ark.calls.some((call) => call.operation === "createDream")) {
      throw new Error("The Memory acceptance harness must not invoke Dream.");
    }
  })()
    .catch((error) => {
      console.error("Memory acceptance worker failed:", error);
      process.exitCode = 1;
      void shutdown();
    })
    .finally(() => {
      tick = undefined;
    });
}, 250);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  await app.close();
  await tick;
  await client.close();
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
await app.listen({ host: "127.0.0.1", port });

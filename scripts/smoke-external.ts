import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { Pool } from "pg";
import { HttpArkGateway } from "../packages/ark-client/src/http.js";
import { parseServerConfig } from "../packages/config/src/index.js";
import { createTosArtifactStorage } from "../packages/storage/src/index.js";

/**
 * Opt-in smoke test for the three external dependencies that local fakes cannot
 * prove: PostgreSQL, TOS, and the Ark Managed Agents API. It creates one short
 * Ark agent/session, writes one TOS object, and rolls back one database write.
 * Pass --confirm because it spends Ark tokens and touches the real bucket.
 */
if (!process.argv.includes("--confirm")) {
  console.error(
    "Refusing to touch real services without --confirm.\n" +
      "Usage: npx tsx --env-file=.env scripts/smoke-external.ts --confirm",
  );
  process.exit(1);
}

const config = parseServerConfig(process.env);

async function checkDatabase(): Promise<void> {
  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    const version = await pool.query<{ version: string }>("select version()");
    const counts = await pool.query<{
      users: string;
      sessions: string;
      consents: string | null;
    }>(
      `select (select count(*) from users)::text as users,
              (select count(*) from sessions)::text as sessions,
              to_regclass('public.user_consents')::text as consents`,
    );
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `insert into users (id, auth_subject, email, role)
         values ($1, $2, $3, 'user')`,
        [
          randomUUID(),
          `smoke:${randomUUID()}`,
          `smoke-${randomUUID()}@example.com`,
        ],
      );
      const inserted = await client.query<{ count: string }>(
        "select count(*)::text as count from users",
      );
      await client.query("rollback");
      console.log(
        `DB OK ${version.rows[0]?.version.split(",")[0]} users=${counts.rows[0]?.users} sessions=${counts.rows[0]?.sessions} consentTable=${counts.rows[0]?.consents} rollbackUsers=${inserted.rows[0]?.count}`,
      );
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

async function checkTos(): Promise<void> {
  const storage = createTosArtifactStorage(config.tos);
  const key = `smoke/${Date.now()}-${randomUUID()}.txt`;
  const payload = `ma-worker TOS smoke ${new Date().toISOString()}`;
  const body = Buffer.from(payload, "utf8");
  try {
    await storage.write(key, Readable.from([body]), {
      contentType: "text/plain; charset=utf-8",
      contentLength: body.byteLength,
    });
    const stream = await storage.openRead(key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const readBack = Buffer.concat(chunks).toString("utf8");
    if (readBack !== payload) {
      throw new Error("TOS read-back content did not match the write");
    }
    console.log(
      `TOS OK bucket=${config.tos.bucket} key=${key} bytes=${Buffer.byteLength(payload)}`,
    );
  } finally {
    try {
      await storage.delete(key);
      console.log(`TOS cleanup OK key=${key}`);
    } catch (error) {
      console.error(
        `TOS cleanup failed key=${key}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}

async function checkArk(): Promise<void> {
  const gateway = new HttpArkGateway({
    baseUrl: config.ark.baseUrl,
    apiKey: config.ark.apiKey,
    timeoutMs: 60_000,
    maxAttempts: 2,
    baseDelayMs: 250,
    maxDelayMs: 2_000,
  });
  const modelId = config.modelAllowlist[0]!;
  const stamp = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  let agentId: string | undefined;
  let sessionId: string | undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  try {
    const agent = await gateway.createAgent({
      name: `ma-smoke-${stamp}`,
      description: "MA Worker external smoke test; safe to delete.",
      modelId,
      systemPrompt:
        "You are a concise smoke-test assistant. Reply with one short sentence and do not call tools.",
      tools: [
        {
          type: "agent_toolset_20260701",
          defaultConfig: {
            permissionPolicy: { type: "always_allow" },
          },
        },
      ],
    });
    agentId = agent.id;
    const session = await gateway.createSession({
      agentId: agent.id,
      agentVersion: agent.version,
      environmentId: config.ark.environmentId,
      resources: [],
    });
    sessionId = session.id;
    await gateway.submitEvent(
      session.id,
      {
        type: "user.message",
        data: { content: "只回复：smoke-ok。不要调用任何工具。" },
      },
      { correlationId: `smoke-${stamp}` },
    );

    const events = await gateway.streamEvents(session.id, {
      signal: controller.signal,
    });
    const types = new Map<string, number>();
    const messages: string[] = [];
    let stopReason: string | undefined;
    let eventCount = 0;
    for await (const event of events) {
      eventCount += 1;
      types.set(event.type, (types.get(event.type) ?? 0) + 1);
      if (event.type === "agent.message") {
        const content = event.data.content;
        if (typeof content === "string") messages.push(content);
      }
      const reason = event.data.stop_reason;
      if (typeof reason === "object" && reason !== null) {
        const type = (reason as Record<string, unknown>).type;
        if (typeof type === "string") stopReason = type;
        if (
          stopReason === "end_turn" &&
          (event.type === "session.status_idle" ||
            event.type === "session.status")
        ) {
          break;
        }
      }
    }
    const text = messages.join("\n").trim();
    console.log(
      `ARK OK model=${modelId} agent=${agentId} session=${sessionId} events=${eventCount} stop=${stopReason ?? "none"} text=${JSON.stringify(text)}`,
    );
    console.log(
      `ARK event types: ${[...types.entries()].map(([type, count]) => `${type}=${count}`).join(", ")}`,
    );
    if (!text) throw new Error("Ark returned no agent.message content");
    if (stopReason !== "end_turn") {
      throw new Error(
        `Ark did not reach end_turn (stop=${stopReason ?? "none"})`,
      );
    }
  } finally {
    clearTimeout(timer);
    if (sessionId) {
      await gateway
        .deleteSession(sessionId)
        .then(() => console.log(`ARK cleanup OK session=${sessionId}`))
        .catch((error: unknown) =>
          console.error(
            `ARK session cleanup failed ${sessionId}:`,
            error instanceof Error ? error.message : error,
          ),
        );
    }
    if (agentId) {
      await gateway
        .deleteAgent(agentId)
        .then(() => console.log(`ARK cleanup OK agent=${agentId}`))
        .catch((error: unknown) =>
          console.error(
            `ARK agent cleanup failed ${agentId}:`,
            error instanceof Error ? error.message : error,
          ),
        );
    }
  }
}

try {
  await checkDatabase();
  await checkTos();
  await checkArk();
  console.log("SMOKE EXTERNAL: all checks passed");
} catch (error) {
  console.error(
    "SMOKE EXTERNAL failed:",
    error instanceof Error ? `${error.name}: ${error.message}` : error,
  );
  process.exitCode = 1;
}

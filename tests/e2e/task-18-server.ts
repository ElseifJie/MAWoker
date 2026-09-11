import cookie from "@fastify/cookie";
import staticFiles from "@fastify/static";
import Fastify from "fastify";
import { resolve } from "node:path";
import { createTask18BrowserBackend } from "../../apps/web/src/task-18-browser-harness.js";

const port = Number(process.env.TASK18_E2E_PORT ?? 4179);
const backend = createTask18BrowserBackend();
const app = Fastify({ logger: false });

await app.register(cookie);
await app.register(staticFiles, {
  root: resolve(import.meta.dirname, "../../apps/web/dist"),
  wildcard: false,
});

app.addContentTypeParser(
  /^multipart\/form-data/,
  { parseAs: "buffer" },
  (_request, body, done) => done(null, body),
);

app.get("/health", async () => ({ status: "ok" }));

app.get("/api/v1/sessions/:id/events", async (request, reply) => {
  if (!request.cookies.pwa_session) {
    return reply.code(401).send({
      error: {
        code: "AUTH_REQUIRED",
        message: "Authentication required",
        requestId: "task-18-e2e",
        retryable: false,
      },
    });
  }

  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  reply.raw.write(
    `event: ready\ndata: ${JSON.stringify({
      sessionId: request.params.id,
      status: "running",
      agentName: "Acceptance Agent",
      agentVersion: "1",
    })}\n\nretry: 100\n\n`,
  );

  const events = [
    {
      id: "event-user",
      sourceType: "user.message",
      type: "message",
      createdAt: "2026-09-07T08:00:00.000Z",
      payload: { content: "Prepare an acceptance report" },
    },
    {
      id: "event-thinking",
      sourceType: "agent.thinking",
      type: "thinking",
      createdAt: "2026-09-07T08:00:01.000Z",
      payload: {},
    },
    {
      id: "call_write_1",
      sourceType: "agent.tool_use",
      type: "tool_use",
      createdAt: "2026-09-07T08:00:02.000Z",
      payload: {
        callId: "call_write_1",
        name: "write",
        argsSummary: "/workspace/acceptance-report.md",
      },
    },
    {
      id: "event-tool-result",
      sourceType: "agent.tool_result",
      type: "tool_result",
      createdAt: "2026-09-07T08:00:02.500Z",
      payload: {
        callId: "call_write_1",
        status: "ok",
        preview: "Wrote /workspace/acceptance-report.md",
      },
    },
    {
      id: "event-agent",
      sourceType: "agent.message",
      type: "message",
      createdAt: "2026-09-07T08:00:03.000Z",
      payload: { content: "Acceptance report ready." },
    },
    {
      id: "event-running",
      sourceType: "session.status",
      type: "status",
      createdAt: "2026-09-07T08:00:04.000Z",
      payload: { status: "running" },
    },
  ];

  const timer = setTimeout(() => {
    if (reply.raw.destroyed || reply.raw.writableEnded) return;
    for (const event of events) {
      reply.raw.write(
        `id: ${event.id}\nevent: ${event.sourceType}\ndata: ${JSON.stringify(event)}\n\n`,
      );
    }
  }, 50);
  reply.raw.once("close", () => clearTimeout(timer));
  return reply;
});

app.all("/api/v1/*", async (request, reply) => {
  const pathname = request.url.split("?", 1)[0] ?? request.url;
  const isAuthRoute = pathname.startsWith("/api/v1/auth/");
  if (!isAuthRoute && !request.cookies.pwa_session) {
    return reply.code(401).send({
      error: {
        code: "AUTH_REQUIRED",
        message: "Authentication required",
        requestId: "task-18-e2e",
        retryable: false,
      },
    });
  }

  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers.set(name, value);
  }
  const method = request.method;
  let body: BodyInit | undefined;
  if (method !== "GET" && method !== "HEAD") {
    body =
      request.body instanceof Uint8Array
        ? undefined
        : JSON.stringify(request.body ?? {});
  }
  const response = await backend.fetch(request.url, {
    method,
    headers,
    body,
  });

  reply.code(response.status);
  response.headers.forEach((value, name) => reply.header(name, value));
  if (pathname === "/api/v1/auth/login" && response.status === 204) {
    reply.setCookie("pwa_session", "task-18-e2e-session", {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
    });
  }
  if (pathname.endsWith("/download") && response.ok) {
    reply.header(
      "content-disposition",
      'attachment; filename="acceptance-report.txt"',
    );
  }
  if (response.status === 204) return reply.send();
  return reply.send(Buffer.from(await response.arrayBuffer()));
});

app.setNotFoundHandler((request, reply) => {
  const pathname = request.url.split("?", 1)[0] ?? request.url;
  if (
    request.method === "GET" &&
    !pathname.startsWith("/api/") &&
    !pathname.startsWith("/assets/")
  ) {
    return reply.type("text/html").sendFile("index.html");
  }
  return reply.code(404).send({ error: "not found" });
});

await app.listen({ host: "127.0.0.1", port });

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

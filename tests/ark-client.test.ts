import { describe, expect, it, vi } from "vitest";
import {
  ArkGatewayError,
  HttpArkGateway,
  InMemoryArkGateway,
} from "../packages/ark-client/src/index.js";

const agentInput = {
  name: "Research",
  description: "Find evidence",
  modelId: "model-a",
  systemPrompt: "Be precise.",
};

describe("InMemoryArkGateway", () => {
  it("creates deterministic agents and requires the current version on update", async () => {
    const gateway = new InMemoryArkGateway();

    const created = await gateway.createAgent(agentInput);
    const updated = await gateway.updateAgent(created.id, {
      ...agentInput,
      name: "Research v2",
      currentVersion: created.version,
    });

    expect(created).toMatchObject({ id: "agent-1", version: 1 });
    expect(updated).toMatchObject({ id: "agent-1", version: 2 });
    await expect(
      gateway.updateAgent(created.id, {
        ...agentInput,
        currentVersion: 1,
      }),
    ).rejects.toMatchObject({ category: "version_conflict" });
  });

  it("tracks session transitions, history, and deterministic live events", async () => {
    const gateway = new InMemoryArkGateway({
      now: () => new Date("2026-09-06T00:00:00.000Z"),
    });
    const agent = await gateway.createAgent(agentInput);
    const session = await gateway.createSession({
      agentId: agent.id,
      agentVersion: agent.version,
      environmentId: "environment-1",
      resources: [],
    });
    const stream = gateway.streamEvents(session.id)[Symbol.asyncIterator]();
    const nextEvent = stream.next();

    const message = await gateway.submitEvent(session.id, {
      type: "user.message",
      data: { content: "Start" },
    });

    await expect(nextEvent).resolves.toEqual({
      done: false,
      value: message,
    });
    expect(await gateway.listEvents(session.id)).toEqual([message]);
    expect(await gateway.getSession(session.id)).toMatchObject({
      id: "session-1",
      status: "running",
    });

    await gateway.submitEvent(session.id, {
      type: "user.interrupt",
      data: {},
    });
    expect(await gateway.getSession(session.id)).toMatchObject({
      status: "idle",
    });
    await stream.return?.();
  });

  it("rejects writes to terminal sessions", async () => {
    const gateway = new InMemoryArkGateway();
    const agent = await gateway.createAgent(agentInput);
    const session = await gateway.createSession({
      agentId: agent.id,
      agentVersion: agent.version,
      environmentId: "environment-1",
      resources: [],
    });
    gateway.setSessionStatus(session.id, "terminated");

    await expect(
      gateway.submitEvent(session.id, {
        type: "user.message",
        data: { content: "Too late" },
      }),
    ).rejects.toMatchObject({ category: "session_terminated" });
  });

  it("stores files and exposes session resources and artifacts", async () => {
    const gateway = new InMemoryArkGateway();
    const file = await gateway.uploadFile({
      name: "brief.txt",
      contentType: "text/plain",
      bytes: new Uint8Array([1, 2, 3]),
      purpose: "agent",
    });
    const agent = await gateway.createAgent(agentInput);
    const session = await gateway.createSession({
      agentId: agent.id,
      agentVersion: agent.version,
      environmentId: "environment-1",
      resources: [{ fileId: file.id, mountPath: "/mnt/session/brief.txt" }],
    });
    gateway.addArtifact(session.id, {
      name: "result.txt",
      contentType: "text/plain",
      bytes: new Uint8Array([4, 5]),
    });

    await expect(gateway.listSessionResources(session.id)).resolves.toEqual([
      {
        id: "resource-1",
        fileId: "file-1",
        mountPath: "/mnt/session/brief.txt",
      },
    ]);
    await expect(gateway.listArtifacts(session.id)).resolves.toMatchObject([
      { id: "artifact-1", name: "result.txt", size: 2 },
    ]);
  });

  it("injects failures and records inspectable calls without credentials", async () => {
    const gateway = new InMemoryArkGateway();
    gateway.failNext("getAgent", "rate_limited");

    await expect(gateway.getAgent("agent-1")).rejects.toMatchObject({
      category: "rate_limited",
      retryable: true,
    });
    expect(gateway.calls).toEqual([
      expect.objectContaining({
        operation: "getAgent",
        input: { agentId: "agent-1" },
      }),
    ]);
    expect(JSON.stringify(gateway.calls)).not.toContain("apiKey");
  });

  it("programs upstream events and connection failures", async () => {
    const gateway = new InMemoryArkGateway({
      now: () => new Date("2026-09-06T00:00:00.000Z"),
    });
    const agent = await gateway.createAgent(agentInput);
    const session = await gateway.createSession({
      agentId: agent.id,
      agentVersion: agent.version,
      environmentId: "environment-1",
      resources: [],
    });
    const stream = gateway.streamEvents(session.id)[Symbol.asyncIterator]();
    const nextEvent = stream.next();

    const emitted = gateway.emitEvent(session.id, {
      type: "session.status",
      data: { status: "rescheduled" },
    });

    await expect(nextEvent).resolves.toEqual({
      done: false,
      value: emitted,
    });
    expect(await gateway.getSession(session.id)).toMatchObject({
      status: "rescheduled",
    });
    gateway.failNext("createAgent", "connection_failure");
    await expect(gateway.createAgent(agentInput)).rejects.toMatchObject({
      category: "unknown_write_outcome",
    });
    gateway.failNext("getAgent", "connection_failure");
    await expect(gateway.getAgent(agent.id)).rejects.toMatchObject({
      category: "unavailable",
    });
    await stream.return?.();
  });

  it("closes a pending event iterator when its session is deleted", async () => {
    const gateway = new InMemoryArkGateway();
    const agent = await gateway.createAgent(agentInput);
    const session = await gateway.createSession({
      agentId: agent.id,
      agentVersion: agent.version,
      environmentId: "environment-1",
      resources: [],
    });
    const stream = gateway.streamEvents(session.id)[Symbol.asyncIterator]();
    const pending = stream.next();

    await gateway.deleteSession(session.id);

    await expect(
      Promise.race([
        pending,
        new Promise((resolve) =>
          setTimeout(() => resolve("iterator remained pending"), 50),
        ),
      ]),
    ).resolves.toEqual({ done: true, value: undefined });
  });

  it("removes the abort listener after each event-stream wait", async () => {
    const gateway = new InMemoryArkGateway();
    const agent = await gateway.createAgent(agentInput);
    const session = await gateway.createSession({
      agentId: agent.id,
      agentVersion: agent.version,
      environmentId: "environment-1",
      resources: [],
    });
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const events = gateway.streamEvents(session.id, {
      signal: controller.signal,
    });
    const stream = events[Symbol.asyncIterator]();
    const pending = stream.next();

    gateway.emitEvent(session.id, {
      type: "agent.message",
      data: { content: "ready" },
    });
    await pending;

    expect(addListener).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledWith(
      "abort",
      addListener.mock.calls[0]?.[1],
    );
    await stream.return?.();
  });
});

describe("HttpArkGateway", () => {
  it("owns authentication and correlation IDs and validates responses", async () => {
    const fetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer ark-secret-value",
        );
        expect(new Headers(init?.headers).get("x-correlation-id")).toBe(
          "corr-fixed",
        );
        return Response.json({
          id: "agent-1",
          version: 1,
          ...agentInput,
        });
      },
    );
    const gateway = new HttpArkGateway({
      baseUrl: "https://ark.example.com",
      apiKey: "ark-secret-value",
      fetch,
      createCorrelationId: () => "corr-fixed",
    });

    await expect(gateway.getAgent("agent-1")).resolves.toMatchObject({
      id: "agent-1",
      version: 1,
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    fetch.mockResolvedValueOnce(Response.json({ id: "agent-1" }));
    await expect(gateway.getAgent("agent-1")).rejects.toMatchObject({
      category: "invalid_response",
      retryable: false,
    });
  });

  it.each([
    [429, { code: "RATE_LIMITED" }, "rate_limited", true],
    [503, { code: "UNAVAILABLE" }, "unavailable", true],
    [409, { code: "VERSION_CONFLICT" }, "version_conflict", false],
    [409, { code: "RUNTIME_BUSY" }, "runtime_busy", true],
    [409, { code: "SESSION_TERMINATED" }, "session_terminated", false],
  ] as const)(
    "classifies HTTP %s without leaking upstream details",
    async (status, body, category, retryable) => {
      const secret = "ark-secret-value";
      const fetch = vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { ...body, message: `upstream included ${secret}` },
            { status },
          ),
        );
      const gateway = new HttpArkGateway({
        baseUrl: "https://ark.example.com",
        apiKey: secret,
        fetch,
        maxAttempts: 1,
      });

      const error = await gateway.getAgent("agent-1").catch((caught) => caught);

      expect(error).toMatchObject({ category, retryable });
      expect(String(error)).not.toContain(secret);
      expect(String(error)).not.toContain("upstream included");
    },
  );

  it("retries safe operations with capped jittered backoff", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({}, { status: 429 }))
      .mockResolvedValueOnce(Response.json({}, { status: 503 }))
      .mockResolvedValueOnce(
        Response.json({
          id: "agent-1",
          version: 1,
          ...agentInput,
        }),
      );
    const sleep = vi.fn().mockResolvedValue(undefined);
    const gateway = new HttpArkGateway({
      baseUrl: "https://ark.example.com",
      apiKey: "secret",
      fetch,
      sleep,
      random: () => 0.5,
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 150,
    });

    await gateway.getAgent("agent-1");

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 50, expect.any(AbortSignal));
    expect(sleep).toHaveBeenNthCalledWith(2, 75, expect.any(AbortSignal));
  });

  it("does not replay writes when a network failure leaves the outcome unknown", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("socket closed"));
    const gateway = new HttpArkGateway({
      baseUrl: "https://ark.example.com",
      apiKey: "secret",
      fetch,
      maxAttempts: 3,
    });

    await expect(gateway.createAgent(agentInput)).rejects.toMatchObject({
      category: "unknown_write_outcome",
      retryable: false,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("classifies a timed-out write as an unknown outcome without replaying it", async () => {
    const fetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        }),
    );
    const gateway = new HttpArkGateway({
      baseUrl: "https://ark.example.com",
      apiKey: "secret",
      fetch,
      timeoutMs: 5,
      maxAttempts: 3,
    });

    await expect(gateway.createAgent(agentInput)).rejects.toMatchObject({
      category: "unknown_write_outcome",
      retryable: false,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("classifies a 5xx write response as an unknown outcome", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({}, { status: 503 }));
    const gateway = new HttpArkGateway({
      baseUrl: "https://ark.example.com",
      apiKey: "secret",
      fetch,
      maxAttempts: 3,
    });

    await expect(gateway.createAgent(agentInput)).rejects.toMatchObject({
      category: "unknown_write_outcome",
      retryable: false,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("classifies caller cancellation during retry backoff", async () => {
    const controller = new AbortController();
    const fetch = vi.fn().mockResolvedValue(Response.json({}, { status: 503 }));
    const sleep = vi.fn(
      async (_milliseconds: number, signal: AbortSignal) =>
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
          controller.abort(new Error("caller cancelled"));
        }),
    );
    const gateway = new HttpArkGateway({
      baseUrl: "https://ark.example.com",
      apiKey: "secret",
      fetch,
      sleep,
    });

    await expect(
      gateway.getAgent("agent-1", { signal: controller.signal }),
    ).rejects.toMatchObject({ category: "cancelled" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("honors caller cancellation and request timeouts", async () => {
    const fetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        }),
    );
    const gateway = new HttpArkGateway({
      baseUrl: "https://ark.example.com",
      apiKey: "secret",
      fetch,
      timeoutMs: 5,
      maxAttempts: 1,
    });

    await expect(gateway.getAgent("agent-1")).rejects.toBeInstanceOf(
      ArkGatewayError,
    );
    await expect(gateway.getAgent("agent-1")).rejects.toMatchObject({
      category: "timeout",
    });

    const controller = new AbortController();
    controller.abort(new Error("caller cancelled"));
    await expect(
      gateway.getAgent("agent-1", { signal: controller.signal }),
    ).rejects.toMatchObject({ category: "cancelled" });
  });

  it.each([
    ["safe operation", "getAgent", "timeout"],
    ["write", "createAgent", "unknown_write_outcome"],
  ] as const)(
    "keeps the timeout active while parsing a JSON body for a %s",
    async (_label, operation, category) => {
      const fetch = vi.fn(
        async (_input: string | URL | Request, init?: RequestInit) =>
          new Response(
            new ReadableStream({
              start(controller) {
                init?.signal?.addEventListener(
                  "abort",
                  () => controller.error(init.signal?.reason),
                  { once: true },
                );
              },
            }),
            { headers: { "content-type": "application/json" } },
          ),
      );
      const gateway = new HttpArkGateway({
        baseUrl: "https://ark.example.com",
        apiKey: "secret",
        fetch,
        timeoutMs: 5,
        maxAttempts: 1,
      });
      const request =
        operation === "getAgent"
          ? gateway.getAgent("agent-1")
          : gateway.createAgent(agentInput);

      await expect(
        Promise.race([
          request.catch((error: unknown) => error),
          new Promise((resolve) =>
            setTimeout(() => resolve("body parsing did not time out"), 50),
          ),
        ]),
      ).resolves.toMatchObject({ category });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["malformed response", () => Promise.resolve(new Response("{secret"))],
    [
      "transport failure",
      () => Promise.reject(new Error("Bearer secret from response text")),
    ],
  ])(
    "does not export upstream details through a %s cause",
    async (_label, reply) => {
      const gateway = new HttpArkGateway({
        baseUrl: "https://ark.example.com",
        apiKey: "secret",
        fetch: vi.fn(reply),
        maxAttempts: 1,
      });

      const error = await gateway.getAgent("agent-1").catch((caught) => caught);

      expect(error).toBeInstanceOf(ArkGatewayError);
      expect(error).not.toHaveProperty("cause");
      expect(String(error)).not.toContain("secret");
    },
  );

  it("parses validated SSE events", async () => {
    const encoder = new TextEncoder();
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'id: evt-1\nevent: agent.message\ndata: {"content":"hello"}\n\n',
              ),
            );
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
    const gateway = new HttpArkGateway({
      baseUrl: "https://ark.example.com",
      apiKey: "secret",
      fetch,
    });

    const events = [];
    for await (const event of gateway.streamEvents("session-1")) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        id: "evt-1",
        type: "agent.message",
        createdAt: expect.any(String),
        data: { content: "hello" },
      },
    ]);
  });

  it("preserves invalid-response classification for malformed SSE", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response('id: evt-1\ndata: {"credential":"secret"\n\n', {
        headers: { "content-type": "text/event-stream" },
      }),
    );
    const gateway = new HttpArkGateway({
      baseUrl: "https://ark.example.com",
      apiKey: "secret",
      fetch,
    });
    const stream = gateway.streamEvents("session-1")[Symbol.asyncIterator]();

    const error = await stream.next().catch((caught) => caught);

    expect(error).toMatchObject({ category: "invalid_response" });
    expect(error).not.toHaveProperty("cause");
    expect(String(error)).not.toContain("secret");
  });

  it("cancels the upstream SSE body and removes listeners on early exit", async () => {
    const encoder = new TextEncoder();
    const cancel = vi.fn();
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(streamController) {
            streamController.enqueue(
              encoder.encode('id: evt-1\ndata: {"content":"hello"}\n\n'),
            );
          },
          cancel,
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
    const gateway = new HttpArkGateway({
      baseUrl: "https://ark.example.com",
      apiKey: "secret",
      fetch,
    });
    const events = gateway.streamEvents("session-1", {
      signal: controller.signal,
    });
    const stream = events[Symbol.asyncIterator]();

    await expect(stream.next()).resolves.toMatchObject({ done: false });
    await stream.return?.();

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(addListener).toHaveBeenCalled();
    expect(removeListener).toHaveBeenCalledWith(
      "abort",
      addListener.mock.calls[0]?.[1],
    );
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  ArkGatewayError,
  HttpArkGateway,
  InMemoryArkGateway,
  stubExportBucket,
} from "../packages/ark-client/src/index.js";

const agentInput = {
  name: "Research",
  description: "Find evidence",
  modelId: "model-a",
  systemPrompt: "Be precise.",
};

const unsafeJsonWrites: Array<
  [string, (gateway: HttpArkGateway) => Promise<unknown>]
> = [
  ["createAgent", (gateway) => gateway.createAgent(agentInput)],
  [
    "updateAgent",
    (gateway) =>
      gateway.updateAgent("agent-1", {
        ...agentInput,
        currentVersion: 1,
      }),
  ],
  [
    "createSession",
    (gateway) =>
      gateway.createSession({
        agentId: "agent-1",
        agentVersion: 1,
        environmentId: "environment-1",
        resources: [],
      }),
  ],
  [
    "submitEvent",
    (gateway) =>
      gateway.submitEvent("session-1", {
        type: "user.message",
        data: { content: "hello" },
      }),
  ],
  [
    "uploadFile",
    (gateway) =>
      gateway.uploadFile({
        name: "input.txt",
        contentType: "text/plain",
        bytes: new TextEncoder().encode("content"),
        purpose: "agent",
      }),
  ],
];

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

  it("deduplicates create by idempotency key without conflating correlation IDs", async () => {
    const gateway = new InMemoryArkGateway();

    const first = await gateway.createAgent(agentInput, {
      correlationId: "trace-id",
      idempotencyKey: "personal-agent-create:durable-id",
    });
    const replay = await gateway.createAgent(agentInput, {
      correlationId: "retry-trace-id",
      idempotencyKey: "personal-agent-create:durable-id",
    });
    const independent = await gateway.createAgent(agentInput, {
      correlationId: "trace-id",
    });

    expect(replay).toEqual(first);
    expect(independent.id).toBe("agent-2");
  });

  it("deduplicates Session creation by its durable idempotency key", async () => {
    const gateway = new InMemoryArkGateway();
    const agent = await gateway.createAgent(agentInput);
    const input = {
      agentId: agent.id,
      agentVersion: agent.version,
      environmentId: "environment-1",
      resources: [],
    };

    const first = await gateway.createSession(input, {
      correlationId: "first-attempt",
      idempotencyKey: "session-create:durable-id",
    });
    const replay = await gateway.createSession(input, {
      correlationId: "reconciliation-attempt",
      idempotencyKey: "session-create:durable-id",
    });
    const independent = await gateway.createSession(input, {
      correlationId: "first-attempt",
    });

    expect(replay).toEqual(first);
    expect(independent.id).toBe("session-2");
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
    const stream = (await gateway.streamEvents(session.id))[
      Symbol.asyncIterator
    ]();
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
      {
        id: "artifact-1",
        name: "result.txt",
        size: 2,
        tos: {
          bucket: stubExportBucket,
          objectKey: `ark_ma/outputs/${session.id}/result.txt`,
        },
      },
    ]);
    // Ark's Files API has no content endpoint, so the export is read from the
    // TOS location it reports rather than downloaded through the gateway.
    expect(gateway.artifactExport("artifact-1")).toMatchObject({
      bucket: stubExportBucket,
      objectKey: `ark_ma/outputs/${session.id}/result.txt`,
      bytes: new Uint8Array([4, 5]),
    });

    await gateway.deleteFile(file.id);
    await expect(
      gateway.createSession({
        agentId: agent.id,
        agentVersion: agent.version,
        environmentId: "environment-1",
        resources: [{ fileId: file.id, mountPath: "/mnt/session/brief.txt" }],
      }),
    ).rejects.toMatchObject({ category: "not_found" });
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
    const stream = (await gateway.streamEvents(session.id))[
      Symbol.asyncIterator
    ]();
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
    const stream = (await gateway.streamEvents(session.id))[
      Symbol.asyncIterator
    ]();
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
    const events = await gateway.streamEvents(session.id, {
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

  it("sends explicit create idempotency metadata", async () => {
    const fetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("x-correlation-id")).toBe(
          "create-operation",
        );
        expect(new Headers(init?.headers).get("idempotency-key")).toBe(
          "create-operation",
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
    });

    await gateway.createAgent(agentInput, {
      correlationId: "create-operation",
      idempotencyKey: "create-operation",
    });
  });

  it("serializes session creation fields using the Ark snake_case contract", async () => {
    const fetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        expect(JSON.parse(String(init?.body))).toEqual({
          agent: "agent-1",
          environment_id: "environment-1",
          resources: [
            {
              type: "file",
              file_id: "file-1",
              mount_path: "/input/file.txt",
            },
          ],
        });
        return Response.json({
          id: "session-1",
          type: "session",
          status: "idle",
          environment_id: "environment-1",
          agent: { id: "agent-1", version: 1, name: "Research" },
          created_at: "2026-09-07T00:00:00Z",
          updated_at: "2026-09-07T00:00:00Z",
          resources: [],
          vault_ids: null,
          environment: {},
        });
      },
    );
    const gateway = new HttpArkGateway({
      baseUrl: "https://ark.example.com",
      apiKey: "ark-secret-value",
      fetch,
    });

    await expect(
      gateway.createSession({
        agentId: "agent-1",
        agentVersion: 1,
        environmentId: "environment-1",
        resources: [{ fileId: "file-1", mountPath: "/input/file.txt" }],
      }),
    ).resolves.toEqual({
      id: "session-1",
      agentId: "agent-1",
      agentVersion: 1,
      environmentId: "environment-1",
      status: "idle",
    });
  });

  it("wraps user messages in the Ark events contract", async () => {
    const fetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        expect(JSON.parse(String(init?.body))).toEqual({
          events: [
            {
              type: "user.message",
              content: [{ type: "text", text: "hello" }],
            },
          ],
        });
        return Response.json({
          data: [
            {
              id: "event-1",
              type: "user.message",
              content: [{ type: "text", text: "hello" }],
            },
          ],
        });
      },
    );
    const gateway = new HttpArkGateway({
      baseUrl: "https://ark.example.com",
      apiKey: "ark-secret-value",
      fetch,
    });

    await expect(
      gateway.submitEvent("session-1", {
        type: "user.message",
        data: { content: "hello" },
      }),
    ).resolves.toMatchObject({
      id: "event-1",
      type: "user.message",
    });
  });

  it("deletes files through the typed Files API", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const gateway = new HttpArkGateway({
      baseUrl: "https://ark.example.com",
      apiKey: "secret",
      fetch,
      maxAttempts: 1,
    });

    await gateway.deleteFile("file/one", { correlationId: "cleanup-1" });

    expect(fetch).toHaveBeenCalledWith(
      "https://ark.example.com/api/v3/files/file%2Fone",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.any(Headers),
      }),
    );
    expect(
      new Headers(fetch.mock.calls[0]?.[1]?.headers).get("x-correlation-id"),
    ).toBe("cleanup-1");
  });

  it("maps the Files API envelope and keeps only this Session's exports", async () => {
    const envelope = {
      object: "file",
      data: [
        {
          object: "file",
          id: "file-export",
          purpose: "agent",
          filename: "康冠科技KTC演示稿.html",
          bytes: 11762,
          mime_type: "text/html; charset=UTF-8",
          created_at: 1789114336,
          expire_at: 1789719135,
          status: "active",
          tos: {
            bucket: "wj-ma-demo",
            object_key:
              "ark_ma/outputs/env-1/sesn-1/ark_processed/file-export/x.html",
          },
          scope: { type: "session", id: "sesn-1" },
        },
        {
          object: "file",
          id: "file-upload",
          purpose: "agent",
          filename: "brief.pdf",
          bytes: 549325,
          mime_type: "application/pdf",
          created_at: 1789110044,
          status: "active",
        },
        {
          object: "file",
          id: "file-other-session",
          purpose: "agent",
          filename: "elsewhere.txt",
          bytes: 1,
          mime_type: "text/plain",
          created_at: 1789110000,
          status: "active",
          scope: { type: "session", id: "sesn-2" },
        },
      ],
      first_id: "file-export",
      last_id: "file-other-session",
      has_more: false,
    };
    const fetch = vi.fn().mockResolvedValue(Response.json(envelope));
    const gateway = new HttpArkGateway({
      baseUrl: "https://ark.example.com",
      apiKey: "secret",
      fetch,
      maxAttempts: 1,
    });

    await expect(gateway.listArtifacts("sesn-1")).resolves.toEqual([
      {
        id: "file-export",
        sessionId: "sesn-1",
        name: "康冠科技KTC演示稿.html",
        contentType: "text/html; charset=UTF-8",
        size: 11762,
        createdAt: "2026-09-11T08:12:16.000Z",
        tos: {
          bucket: "wj-ma-demo",
          objectKey:
            "ark_ma/outputs/env-1/sesn-1/ark_processed/file-export/x.html",
        },
      },
    ]);
    // The query no longer sends `kind=artifact`, which Ark ignores.
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "https://ark.example.com/api/v3/files?scope_id=sesn-1&limit=100",
    );
  });

  it("treats a null data field as an empty file list", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        object: "file",
        data: null,
        first_id: null,
        last_id: null,
        has_more: false,
      }),
    );
    const gateway = new HttpArkGateway({
      baseUrl: "https://ark.example.com",
      apiKey: "secret",
      fetch,
      maxAttempts: 1,
    });

    await expect(gateway.listArtifacts("sesn-1")).resolves.toEqual([]);
  });

  it.each(unsafeJsonWrites)(
    "classifies a successful %s with an invalid response as an unknown write outcome",
    async (_operation, invoke) => {
      const fetch = vi.fn().mockResolvedValue(Response.json({ id: "partial" }));
      const gateway = new HttpArkGateway({
        baseUrl: "https://ark.example.com",
        apiKey: "secret",
        fetch,
        maxAttempts: 3,
      });

      await expect(invoke(gateway)).rejects.toMatchObject({
        category: "unknown_write_outcome",
        retryable: false,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["parse", () => new Response("{malformed")],
    [
      "consume",
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("body stream failed"));
            },
          }),
        ),
    ],
  ])(
    "classifies a successful write response body %s failure as an unknown outcome",
    async (_failure, response) => {
      const gateway = new HttpArkGateway({
        baseUrl: "https://ark.example.com",
        apiKey: "secret",
        fetch: vi.fn().mockResolvedValue(response()),
        maxAttempts: 1,
      });

      await expect(gateway.createAgent(agentInput)).rejects.toMatchObject({
        category: "unknown_write_outcome",
      });
    },
  );

  it.each([
    [
      "consumption",
      (caller: AbortController) =>
        new Response(
          new ReadableStream({
            pull(controller) {
              caller.abort(new Error("caller cancelled"));
              controller.error(new Error("body stream failed"));
            },
          }),
        ),
    ],
    [
      "validation",
      (caller: AbortController) => {
        const response = Response.json({ id: "partial" });
        vi.spyOn(response, "json").mockImplementation(async () => {
          caller.abort(new Error("caller cancelled"));
          return { id: "partial" };
        });
        return response;
      },
    ],
  ])(
    "preserves an unknown write outcome when caller abort races with 2xx body %s failure",
    async (_failure, response) => {
      const caller = new AbortController();
      const gateway = new HttpArkGateway({
        baseUrl: "https://ark.example.com",
        apiKey: "secret",
        fetch: vi.fn().mockResolvedValue(response(caller)),
        maxAttempts: 1,
      });

      await expect(
        gateway.createAgent(agentInput, { signal: caller.signal }),
      ).rejects.toMatchObject({
        category: "unknown_write_outcome",
      });
    },
  );

  it("keeps malformed successful safe reads classified as invalid responses", async () => {
    const gateway = new HttpArkGateway({
      baseUrl: "https://ark.example.com",
      apiKey: "secret",
      fetch: vi.fn().mockResolvedValue(new Response("{malformed")),
      maxAttempts: 1,
    });

    await expect(gateway.getAgent("agent-1")).rejects.toMatchObject({
      category: "invalid_response",
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

  it("keeps safe pre-response caller cancellation classified as cancelled", async () => {
    const caller = new AbortController();
    const fetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    const gateway = new HttpArkGateway({
      baseUrl: "https://ark.example.com",
      apiKey: "secret",
      fetch,
      maxAttempts: 1,
    });
    const request = gateway.getAgent("agent-1", { signal: caller.signal });

    caller.abort(new Error("caller cancelled"));

    await expect(request).rejects.toMatchObject({ category: "cancelled" });
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
    for await (const event of await gateway.streamEvents("session-1")) {
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

  it("preserves the Ark timestamp carried by an SSE event", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          'id: evt-usage\nevent: span.model_request_end\ndata: {"createdAt":"2026-08-31T23:59:59.999Z","model_usage":{"input_tokens":2,"output_tokens":3}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
    const gateway = new HttpArkGateway({
      baseUrl: "https://ark.example.com",
      apiKey: "secret",
      fetch,
      now: () => new Date("2030-01-01T00:00:00.000Z"),
    });

    const events = [];
    for await (const event of await gateway.streamEvents("session-1")) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        id: "evt-usage",
        type: "span.model_request_end",
        createdAt: "2026-08-31T23:59:59.999Z",
        data: { model_usage: { input_tokens: 2, output_tokens: 3 } },
      },
    ]);
  });

  it("strictly normalizes the persisted Ark SSE envelope", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          'data: {"id":"evt-real","type":"session.status_running","processed_at":"2026-09-01T08:00:00.123456789+08:00"}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
    const gateway = new HttpArkGateway({
      baseUrl: "https://ark.example.com",
      apiKey: "secret",
      fetch,
    });

    const events = [];
    for await (const event of await gateway.streamEvents("session-1")) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        id: "evt-real",
        type: "session.status_running",
        createdAt: "2026-09-01T00:00:00.123Z",
        data: {},
      },
    ]);
  });

  it("uses the persisted body type when Ark transports it as an SSE message", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          'id: evt-real\nevent: message\ndata: {"id":"evt-real","type":"session.status_running","processed_at":"2026-09-01T00:00:00.123Z","detail":"started"}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
    const gateway = new HttpArkGateway({
      baseUrl: "https://ark.example.com",
      apiKey: "secret",
      fetch,
    });

    const events = [];
    for await (const event of await gateway.streamEvents("session-1")) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        id: "evt-real",
        type: "session.status_running",
        createdAt: "2026-09-01T00:00:00.123Z",
        data: { detail: "started" },
      },
    ]);
  });

  it("normalizes paged Ark history for background reconciliation", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        data: [
          {
            id: "evt-history",
            type: "span.model_request_end",
            processed_at: "2026-09-01T08:00:00.123456789+08:00",
            model_usage: { input_tokens: 2, output_tokens: 3 },
            is_error: false,
            model_request_start_id: "evt-start",
          },
        ],
      }),
    );
    const gateway = new HttpArkGateway({
      baseUrl: "https://ark.example.com",
      apiKey: "secret",
      fetch,
    });

    await expect(gateway.listEvents("session-1")).resolves.toEqual([
      {
        id: "evt-history",
        type: "span.model_request_end",
        createdAt: "2026-09-01T00:00:00.123Z",
        data: {
          model_usage: { input_tokens: 2, output_tokens: 3 },
          is_error: false,
          model_request_start_id: "evt-start",
        },
      },
    ]);
  });

  it("normalizes Ark message content blocks for the UI", async () => {
    const gateway = new HttpArkGateway({
      baseUrl: "https://ark.example.com",
      apiKey: "secret",
      fetch: vi.fn().mockResolvedValue(
        Response.json({
          data: [
            {
              id: "evt-message",
              type: "agent.message",
              processed_at: "2026-09-01T08:00:00.123456789+08:00",
              content: [
                { type: "text", text: "hello " },
                { type: "text", text: "world" },
              ],
            },
          ],
        }),
      ),
    });

    await expect(gateway.listEvents("session-1")).resolves.toEqual([
      {
        id: "evt-message",
        type: "agent.message",
        createdAt: "2026-09-01T00:00:00.123Z",
        data: { content: "hello world" },
      },
    ]);
  });

  it("follows next_page and safely retries each Ark history page", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          data: [
            {
              id: "evt-page-1",
              type: "session.status_running",
              processed_at: "2026-09-01T00:00:00.000Z",
            },
          ],
          next_page: "cursor + /",
        }),
      )
      .mockResolvedValueOnce(Response.json({}, { status: 503 }))
      .mockResolvedValueOnce(
        Response.json({
          data: [
            {
              id: "evt-page-2",
              type: "session.status_idle",
              processed_at: "2026-09-01T00:00:01.000Z",
            },
          ],
          next_page: null,
        }),
      );
    const sleep = vi.fn().mockResolvedValue(undefined);
    const gateway = new HttpArkGateway({
      baseUrl: "https://ark.example.com",
      apiKey: "secret",
      fetch,
      sleep,
      maxAttempts: 2,
      random: () => 0,
    });

    await expect(gateway.listEvents("session-1")).resolves.toEqual([
      {
        id: "evt-page-1",
        type: "session.status_running",
        createdAt: "2026-09-01T00:00:00.000Z",
        data: {},
      },
      {
        id: "evt-page-2",
        type: "session.status_idle",
        createdAt: "2026-09-01T00:00:01.000Z",
        data: {},
      },
    ]);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://ark.example.com/api/v3/sessions/session-1/events",
      "https://ark.example.com/api/v3/sessions/session-1/events?page=cursor%20%2B%20%2F",
      "https://ark.example.com/api/v3/sessions/session-1/events?page=cursor%20%2B%20%2F",
    ]);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid Ark history next_page contract", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        data: [],
        next_page: 2,
      }),
    );
    const gateway = new HttpArkGateway({
      baseUrl: "https://ark.example.com",
      apiKey: "secret",
      fetch,
    });

    await expect(gateway.listEvents("session-1")).rejects.toMatchObject({
      category: "invalid_response",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("stops Ark history pagination when the caller cancels", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async () => {
      controller.abort();
      return Response.json({
        data: [
          {
            id: "evt-page-1",
            type: "session.status_running",
            processed_at: "2026-09-01T00:00:00.000Z",
          },
        ],
        next_page: "cursor-2",
      });
    });
    const gateway = new HttpArkGateway({
      baseUrl: "https://ark.example.com",
      apiKey: "secret",
      fetch,
    });

    await expect(
      gateway.listEvents("session-1", { signal: controller.signal }),
    ).rejects.toMatchObject({ category: "cancelled" });
    expect(fetch).toHaveBeenCalledTimes(1);
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
    const stream = (await gateway.streamEvents("session-1"))[
      Symbol.asyncIterator
    ]();

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
    const events = await gateway.streamEvents("session-1", {
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

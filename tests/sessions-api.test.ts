import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { connect as netConnect } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { ArkGatewayError } from "../packages/ark-client/src/index.js";
import {
  ResourceNotFoundError,
  SessionCreateVerificationError,
  SessionTerminatedError,
  type SessionRecord,
} from "../packages/domain/src/index.js";
import {
  AUTH_COOKIE_NAME,
  buildApp,
  type ApiAuthService,
  type SessionApiService,
} from "../apps/api/src/app.js";

const userId = "00000000-0000-4000-8000-000000000001";
const agentId = "00000000-0000-4000-8000-000000000002";
const sessionId = "00000000-0000-4000-8000-000000000003";
const timestamp = new Date("2026-09-06T00:00:00.000Z");

function auth(): ApiAuthService {
  return {
    async login() {
      return { token: "user-token", expiresAt: new Date(Date.now() + 60_000) };
    },
    async authenticate(token) {
      return token === "admin-token"
        ? { userId: "admin", authSubject: "managed:admin", role: "admin" }
        : { userId, authSubject: "managed:user", role: "user" };
    },
    async renew() {
      return { expiresAt: new Date(Date.now() + 60_000) };
    },
    async logout() {},
  };
}

const record: SessionRecord = {
  id: sessionId,
  ownerUserId: userId,
  arkSessionId: "ark-session-secret",
  agentKind: "personal",
  platformAgentId: null,
  personalAgentId: agentId,
  arkAgentId: "ark-agent-secret",
  agentName: "Snapshot Name",
  agentVersion: "7",
  environmentId: "environment-secret",
  createAttemptedAt: timestamp,
  modelId: "model-secret",
  configSnapshot: null,
  configSnapshotState: "verified",
  configSnapshotErrorCode: null,
  title: "Task",
  status: "idle",
  lastErrorCode: null,
  errorRecoverable: null,
  archivedAt: null,
  pinnedAt: null,
  deletionState: "none",
  lastEventAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const input = {
  id: "00000000-0000-4000-8000-000000000004",
  ownerUserId: userId,
  sessionId,
  arkFileId: "ark-file-secret",
  originalName: "brief.txt",
  mimeType: "text/plain",
  sizeBytes: 5,
  mountPath:
    "/mnt/session/inputs/00000000-0000-4000-8000-000000000004-brief.txt",
  status: "bound" as const,
  expiresAt: new Date("2026-09-07T00:00:00.000Z"),
  lastErrorCode: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};

function sessionService() {
  return {
    create: vi.fn(async () => record),
    list: vi.fn(async () => [record]),
    get: vi.fn(async () => ({ ...record, inputs: [input] })),
    archive: vi.fn(async () => ({ ...record, archivedAt: timestamp })),
    restore: vi.fn(async () => ({ ...record, archivedAt: null })),
    rename: vi.fn(async (_id: string, title: string) => ({
      ...record,
      title,
    })),
    setPinned: vi.fn(async (_id: string, pinned: boolean) => ({
      ...record,
      pinnedAt: pinned ? timestamp : null,
    })),
    requestDelete: vi.fn(async () => ({
      ...record,
      deletionState: "pending" as const,
    })),
    sendMessage: vi.fn(async () => ({
      eventId: "event-1",
      delivery: "queued" as const,
    })),
    interrupt: vi.fn(async () => ({
      eventId: "event-2",
      delivery: "accepted" as const,
    })),
    openEvents: vi.fn<SessionApiService["openEvents"]>(async () => ({
      session: record,
      events: {
        async *[Symbol.asyncIterator]() {
          yield {
            id: "event-3",
            sourceType: "agent.message",
            type: "message" as const,
            createdAt: timestamp.toISOString(),
            payload: { content: "Hello" },
          };
        },
      },
    })),
    transcriptEvents: vi.fn(async () => [
      {
        id: "event-3",
        sourceType: "agent.message",
        type: "message" as const,
        createdAt: timestamp.toISOString(),
        payload: { content: "Hello" },
      },
    ]),
  } satisfies SessionApiService;
}

function holdAuthInvalidWrite(app: ReturnType<typeof buildApp>) {
  let controlWrites = 0;
  let resolveAttempted!: () => void;
  const attempted = new Promise<void>((resolve) => {
    resolveAttempted = resolve;
  });

  app.server.prependListener("request", (_request, response) => {
    const write = response.write.bind(response) as (
      ...args: unknown[]
    ) => boolean;
    response.write = ((chunk: unknown, ...args: unknown[]) => {
      if (String(chunk).includes("event: auth_invalid")) {
        controlWrites += 1;
        resolveAttempted();
        const callbackIndex = args.findLastIndex(
          (argument) => typeof argument === "function",
        );
        if (callbackIndex >= 0) args[callbackIndex] = () => {};
      }
      return write(chunk, ...args);
    }) as typeof response.write;
  });

  return {
    attempted,
    controlWrites: () => controlWrites,
  };
}

describe("Session API", () => {
  it("archives, restores, and requires exact permanent-delete confirmation", async () => {
    const sessions = sessionService();
    const app = buildApp({ auth: auth(), sessions });
    const cookies = { [AUTH_COOKIE_NAME]: "user-token" };

    const archived = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/archive`,
      cookies,
      payload: {},
    });
    const restored = await app.inject({
      method: "DELETE",
      url: `/api/v1/sessions/${sessionId}/archive`,
      cookies,
    });
    const unconfirmed = await app.inject({
      method: "DELETE",
      url: `/api/v1/sessions/${sessionId}`,
      cookies,
      payload: { confirmation: "delete" },
    });
    const confirmed = await app.inject({
      method: "DELETE",
      url: `/api/v1/sessions/${sessionId}`,
      cookies,
      payload: { confirmation: "DELETE" },
    });

    expect(archived.statusCode).toBe(200);
    expect(archived.json().archivedAt).toBe(timestamp.toISOString());
    expect(restored.statusCode).toBe(200);
    expect(restored.json().archivedAt).toBeNull();
    expect(unconfirmed.statusCode).toBe(400);
    expect(confirmed.statusCode).toBe(202);
    expect(confirmed.json()).toEqual({
      id: sessionId,
      deletionState: "pending",
    });
    expect(sessions.archive).toHaveBeenCalledWith(sessionId, userId);
    expect(sessions.restore).toHaveBeenCalledWith(sessionId, userId);
    expect(sessions.requestDelete).toHaveBeenCalledOnce();
    expect(sessions.requestDelete).toHaveBeenCalledWith(sessionId, userId);
    await app.close();
  });

  it("renames and pins a Session, and rejects an empty rename", async () => {
    const sessions = sessionService();
    const app = buildApp({ auth: auth(), sessions });
    const cookies = { [AUTH_COOKIE_NAME]: "user-token" };

    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/v1/sessions/${sessionId}`,
      cookies,
      payload: { title: "Quarterly plan" },
    });
    const pinned = await app.inject({
      method: "PUT",
      url: `/api/v1/sessions/${sessionId}/pin`,
      cookies,
      payload: {},
    });
    const unpinned = await app.inject({
      method: "DELETE",
      url: `/api/v1/sessions/${sessionId}/pin`,
      cookies,
    });
    const blank = await app.inject({
      method: "PATCH",
      url: `/api/v1/sessions/${sessionId}`,
      cookies,
      payload: { title: "   " },
    });

    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().title).toBe("Quarterly plan");
    expect(pinned.statusCode).toBe(200);
    expect(pinned.json().pinnedAt).toBe(timestamp.toISOString());
    expect(unpinned.statusCode).toBe(200);
    expect(unpinned.json().pinnedAt).toBeNull();
    expect(blank.statusCode).toBe(400);
    expect(sessions.rename).toHaveBeenCalledWith(sessionId, "Quarterly plan", {
      userId,
      requestId: expect.any(String),
    });
    expect(sessions.setPinned).toHaveBeenCalledWith(sessionId, true, {
      userId,
      requestId: expect.any(String),
    });
    expect(sessions.setPinned).toHaveBeenCalledWith(sessionId, false, {
      userId,
      requestId: expect.any(String),
    });
    await app.close();
  });

  it("serves the projected transcript for export", async () => {
    const sessions = sessionService();
    const app = buildApp({ auth: auth(), sessions });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/transcript`,
      cookies: { [AUTH_COOKIE_NAME]: "user-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      events: [
        {
          id: "event-3",
          sourceType: "agent.message",
          type: "message",
          createdAt: timestamp.toISOString(),
          payload: { content: "Hello" },
        },
      ],
    });
    expect(sessions.transcriptEvents).toHaveBeenCalledWith(
      sessionId,
      { userId, requestId: expect.any(String) },
      expect.any(AbortSignal),
    );
    await app.close();
  });

  it("serves strict create/list/detail/message/interrupt routes with minimized output", async () => {
    const sessions = sessionService();
    const app = buildApp({ auth: auth(), sessions });
    const cookies = { [AUTH_COOKIE_NAME]: "user-token" };

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      cookies,
      payload: { agentId, title: " Task " },
    });
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/sessions?archived=true",
      cookies,
    });
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}`,
      cookies,
    });
    const message = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages`,
      cookies,
      payload: { content: " Follow up " },
    });
    const interrupt = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/interrupt`,
      cookies,
      payload: {},
    });

    expect([
      create.statusCode,
      list.statusCode,
      detail.statusCode,
      message.statusCode,
      interrupt.statusCode,
    ]).toEqual([201, 200, 200, 202, 202]);
    expect(create.json()).toMatchObject({
      id: sessionId,
      status: "idle",
      deletionState: "none",
      agent: {
        id: agentId,
        kind: "personal",
        name: "Snapshot Name",
        version: "7",
      },
    });
    expect(list.json()).toEqual({ sessions: [create.json()] });
    expect(detail.json()).toEqual({
      ...create.json(),
      inputs: [
        {
          id: input.id,
          name: "brief.txt",
          mimeType: "text/plain",
          sizeBytes: 5,
          mountPath: input.mountPath,
        },
      ],
    });
    expect(JSON.stringify(create.json())).not.toMatch(
      /ownerUserId|arkSessionId|arkAgentId|environmentId/,
    );
    expect(sessions.create).toHaveBeenCalledWith(
      { agentId, title: "Task" },
      expect.objectContaining({ userId }),
    );
    expect(sessions.list).toHaveBeenCalledWith(userId, true);
    expect(sessions.sendMessage).toHaveBeenCalledWith(
      sessionId,
      { content: "Follow up" },
      expect.objectContaining({ userId }),
    );
    expect(message.json()).toEqual({
      eventId: "event-1",
      delivery: "queued",
    });
    expect(interrupt.json()).toEqual({
      eventId: "event-2",
      delivery: "accepted",
    });
    await app.close();
  });

  it("defaults to active Sessions and rejects undeclared input", async () => {
    const sessions = sessionService();
    const app = buildApp({ auth: auth(), sessions });
    const cookies = { [AUTH_COOKIE_NAME]: "user-token" };

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/sessions",
      cookies,
    });
    expect(list.statusCode).toBe(200);
    expect(sessions.list).toHaveBeenCalledWith(userId, false);

    const invalidCreate = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      cookies,
      payload: { agentId, uploadIds: [], ownerUserId: "other" },
    });
    const invalidMessage = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages`,
      cookies,
      payload: { content: "Message", tenantId: "other" },
    });
    const invalidInterrupt = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/interrupt`,
      cookies,
      payload: { force: true },
    });
    const invalidFilter = await app.inject({
      method: "GET",
      url: "/api/v1/sessions?archived=all",
      cookies,
    });
    const blankTitle = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      cookies,
      payload: { agentId, title: "   " },
    });
    const blankMessage = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages`,
      cookies,
      payload: { content: "   " },
    });

    expect([
      invalidCreate.statusCode,
      invalidMessage.statusCode,
      invalidInterrupt.statusCode,
      invalidFilter.statusCode,
      blankTitle.statusCode,
      blankMessage.statusCode,
    ]).toEqual([400, 400, 400, 400, 400, 400]);
    expect(sessions.create).not.toHaveBeenCalled();
    expect(sessions.sendMessage).not.toHaveBeenCalled();
    expect(sessions.interrupt).not.toHaveBeenCalled();
    await app.close();
  });

  it("accepts only UUID upload IDs on Session create", async () => {
    const sessions = sessionService();
    const app = buildApp({ auth: auth(), sessions });
    const cookies = { [AUTH_COOKIE_NAME]: "user-token" };

    const accepted = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      cookies,
      payload: { agentId, uploadIds: [input.id] },
    });
    const rejected = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      cookies,
      payload: { agentId, uploadIds: ["not-a-uuid"] },
    });

    expect(accepted.statusCode).toBe(201);
    expect(rejected.statusCode).toBe(400);
    expect(sessions.create).toHaveBeenCalledWith(
      { agentId, uploadIds: [input.id] },
      expect.objectContaining({ userId }),
    );
    await app.close();
  });

  it("maps tenant, quota, busy, terminated, and Ark availability failures", async () => {
    const sessions = sessionService();
    sessions.get.mockRejectedValueOnce(new ResourceNotFoundError());
    sessions.create.mockRejectedValueOnce(
      Object.assign(new Error("Quota exceeded"), {
        name: "QuotaExceededError",
        dimension: "concurrent_sessions",
      }),
    );
    sessions.sendMessage.mockRejectedValueOnce(
      new ArkGatewayError("runtime_busy"),
    );
    sessions.sendMessage.mockRejectedValueOnce(new SessionTerminatedError());
    sessions.interrupt.mockRejectedValueOnce(
      new ArkGatewayError("unknown_write_outcome"),
    );
    const app = buildApp({ auth: auth(), sessions });
    const cookies = { [AUTH_COOKIE_NAME]: "user-token" };

    const missing = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}`,
      cookies,
    });
    const quota = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      cookies,
      payload: { agentId },
    });
    const busy = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages`,
      cookies,
      payload: { content: "One" },
    });
    const terminated = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages`,
      cookies,
      payload: { content: "Two" },
    });
    const unavailable = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/interrupt`,
      cookies,
      payload: {},
    });

    expect(missing.statusCode).toBe(404);
    expect(quota.json().error).toMatchObject({
      code: "CONCURRENCY_LIMITED",
      retryable: false,
    });
    expect(busy.json().error).toMatchObject({
      code: "SESSION_BUSY",
      retryable: true,
    });
    expect(terminated.json().error).toMatchObject({
      code: "SESSION_TERMINATED",
      retryable: false,
    });
    expect(unavailable.json().error).toMatchObject({
      code: "ARK_UNAVAILABLE",
      retryable: false,
    });
    await app.close();
  });

  it.each([
    [
      "ARK_SESSION_CREATE_OUTCOME_UNKNOWN",
      503,
      "ARK_UNAVAILABLE",
      "Ark service is unavailable",
    ],
    [
      "ARK_SESSION_AGENT_ID_MISMATCH",
      502,
      "ARK_INVALID_RESPONSE",
      "Ark rejected the request or returned an unexpected response",
    ],
    [
      "ARK_SESSION_CONFIG_SNAPSHOT_INCOMPLETE",
      502,
      "ARK_INVALID_RESPONSE",
      "Ark rejected the request or returned an unexpected response",
    ],
  ] as const)(
    "maps %s without exposing verification details",
    async (internalCode, status, publicCode, message) => {
      const sessions = sessionService();
      sessions.create.mockRejectedValueOnce(
        Object.assign(new SessionCreateVerificationError(internalCode), {
          modelId: "model-secret",
          agentId: "ark-agent-secret",
          environmentId: "environment-secret",
          configSnapshot: {
            modelId: "model-secret",
            internal: "snapshot-secret",
          },
        }),
      );
      const app = buildApp({ auth: auth(), sessions });

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/sessions",
        cookies: { [AUTH_COOKIE_NAME]: "user-token" },
        payload: { agentId },
      });

      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual({
        error: {
          code: publicCode,
          message,
          requestId: expect.any(String),
          retryable: false,
        },
      });
      expect(response.body).not.toMatch(
        /snapshot-secret|model-secret|ark-agent-secret|environment-secret|ARK_SESSION_/,
      );
      await app.close();
    },
  );

  it.each([
    ["pending", "DELETION_PENDING", "Session deletion is pending"],
    ["deletion_failed", "DELETION_FAILED", "Session deletion has failed"],
  ] as const)(
    "maps the %s deletion-state message conflict without exposing internals",
    async (deletionState, code, message) => {
      const sessions = sessionService();
      sessions.sendMessage.mockRejectedValueOnce(
        Object.assign(new Error(message), {
          name: "SessionDeletionConflictError",
          code,
          deletionState,
        }),
      );
      const app = buildApp({ auth: auth(), sessions });

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/sessions/${sessionId}/messages`,
        cookies: { [AUTH_COOKIE_NAME]: "user-token" },
        payload: { content: "Do not restart" },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: {
          code,
          message,
          requestId: expect.any(String),
          retryable: false,
        },
      });
      await app.close();
    },
  );

  it("requires user authentication for every Session route", async () => {
    const sessions = sessionService();
    const app = buildApp({ auth: auth(), sessions });
    const cookies = { [AUTH_COOKIE_NAME]: "admin-token" };
    const requests = [
      ["POST", "/api/v1/sessions", { agentId }],
      ["GET", "/api/v1/sessions", undefined],
      ["GET", `/api/v1/sessions/${sessionId}`, undefined],
      ["POST", `/api/v1/sessions/${sessionId}/archive`, {}],
      ["DELETE", `/api/v1/sessions/${sessionId}/archive`, undefined],
      ["DELETE", `/api/v1/sessions/${sessionId}`, { confirmation: "DELETE" }],
      ["GET", `/api/v1/sessions/${sessionId}/events`, undefined],
      [
        "POST",
        `/api/v1/sessions/${sessionId}/messages`,
        { content: "Message" },
      ],
      ["POST", `/api/v1/sessions/${sessionId}/interrupt`, {}],
    ] as const;

    for (const [method, url, payload] of requests) {
      const response = await app.inject({
        method,
        url,
        cookies,
        ...(payload ? { payload } : {}),
      });
      expect(response.statusCode).toBe(404);
    }
    expect(
      Object.values(sessions).every((call) => call.mock.calls.length === 0),
    ).toBe(true);
    await app.close();
  });

  it("streams an authoritative ready frame with normalized UI events after upstream readiness", async () => {
    const sessions = sessionService();
    const app = buildApp({ auth: auth(), sessions });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/events`,
      cookies: { [AUTH_COOKIE_NAME]: "user-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toBe(
      [
        "event: ready",
        `data: ${JSON.stringify({
          sessionId,
          status: "idle",
          agentName: "Snapshot Name",
          agentVersion: "7",
        })}`,
        "",
        "id: event-3",
        "event: agent.message",
        `data: ${JSON.stringify({
          id: "event-3",
          sourceType: "agent.message",
          type: "message",
          createdAt: timestamp.toISOString(),
          payload: { content: "Hello" },
        })}`,
        "",
        "",
      ].join("\n"),
    );
    // The ready frame is state, not a replayable event: no id line, and only the
    // whitelisted fields — never the Ark or environment identifiers.
    expect(response.body).not.toContain("ark-session-secret");
    expect(response.body).not.toContain("ark-agent-secret");
    expect(response.body).not.toContain("environment-secret");
    expect(sessions.openEvents).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({ userId }),
      expect.any(AbortSignal),
    );
    await app.close();
  });

  it("aborts an upstream open when the downstream disconnects before readiness", async () => {
    const sessions = sessionService();
    let started!: () => void;
    const opening = new Promise<void>((resolve) => {
      started = resolve;
    });
    let upstreamSignal: AbortSignal | undefined;
    sessions.openEvents.mockImplementationOnce(
      async (_id, _context, signal) => {
        upstreamSignal = signal;
        started();
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return {
          events: {
            async *[Symbol.asyncIterator]() {},
          },
        };
      },
    );
    const app = buildApp({ auth: auth(), sessions });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path: `/api/v1/sessions/${sessionId}/events`,
      headers: { cookie: `${AUTH_COOKIE_NAME}=user-token` },
    });
    request.on("error", () => {});
    request.end();

    await opening;
    request.destroy();
    await vi.waitFor(() => expect(upstreamSignal?.aborted).toBe(true));
    await app.close();
  });

  it("closes an established stream immediately when an admin disables the user", async () => {
    const sessions = sessionService();
    sessions.openEvents.mockImplementationOnce(async (_id, _ctx, signal) => ({
      session: record,
      events: {
        [Symbol.asyncIterator]() {
          // Mirrors the real upstream iterator: it observes the abort signal
          // and ends the stream when the server revokes the connection.
          return {
            next: () =>
              new Promise<IteratorResult<unknown>>((resolve) => {
                signal?.addEventListener(
                  "abort",
                  () => resolve({ value: undefined, done: true }),
                  { once: true },
                );
              }),
          };
        },
      },
    }));
    const admin = {
      setUserStatus: vi.fn(async () => ({
        from: "active",
        to: "disabled",
        revokedSessions: 1,
      })),
    };
    const app = buildApp({
      auth: auth(),
      sessions,
      // @ts-expect-error minimal admin service: only setUserStatus is reached
      admin,
      // A recheck interval far beyond the test window: only the in-process
      // stream registry can explain an immediate close.
      sseAuthRecheckIntervalMs: 600_000,
      sseAuthRecheckBudgetMs: 500,
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path: `/api/v1/sessions/${sessionId}/events`,
      headers: { cookie: `${AUTH_COOKIE_NAME}=user-token` },
    });
    request.on("error", () => {});
    const closed = new Promise<void>((resolve) => {
      request.on("response", (response) => {
        response.on("data", () => {});
        response.on("close", resolve);
      });
    });
    request.end();
    await vi.waitFor(() => {
      if (request.res?.statusCode !== 200) throw new Error("stream not open");
    });

    const disabled = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/users/${userId}/status`,
      cookies: { [AUTH_COOKIE_NAME]: "admin-token" },
      payload: { status: "disabled" },
    });
    expect(disabled.statusCode).toBe(200);
    expect(admin.setUserStatus).toHaveBeenCalled();

    // Same-process revocation closes the established stream at once, long
    // before any periodic recheck could fire.
    const closedWithinSecond = await Promise.race([
      closed.then(() => true),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), 1_000),
      ),
    ]);
    expect(closedWithinSecond).toBe(true);
    await app.close();
  });

  it("closes an established stream after the login session is revoked", async () => {
    const sessions = sessionService();
    let upstreamSignal: AbortSignal | undefined;
    sessions.openEvents.mockImplementation(async (_id, _context, signal) => {
      upstreamSignal ??= signal;
      return {
        session: record,
        events: {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                await new Promise<void>((resolve) => {
                  signal?.addEventListener("abort", () => resolve(), {
                    once: true,
                  });
                });
                return { done: true, value: undefined };
              },
            };
          },
        },
      };
    });
    let authenticateCalls = 0;
    const revocableAuth: ApiAuthService = {
      ...auth(),
      async authenticate() {
        authenticateCalls += 1;
        if (authenticateCalls === 2) {
          throw Object.assign(new Error(), { name: "AuthRequiredError" });
        }
        return { userId, authSubject: "managed:user", role: "user" };
      },
    };
    const app = buildApp({
      auth: revocableAuth,
      sessions,
      rateLimit: { max: 1, windowMs: 1 },
      sseAuthRecheckIntervalMs: 10,
      sseAuthRecheckBudgetMs: 500,
    });
    const control = holdAuthInvalidWrite(app);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path: `/api/v1/sessions/${sessionId}/events`,
      headers: { cookie: `${AUTH_COOKIE_NAME}=user-token` },
    });
    const chunks: string[] = [];
    request.on("error", () => {});
    request.on("response", (response) => {
      response.on("data", (chunk) => chunks.push(chunk.toString()));
    });
    request.end();

    await vi.waitFor(() => expect(chunks.join("")).toContain("event: ready"));
    await control.attempted;
    const abortedAtControlWrite = upstreamSignal?.aborted;
    const secondStatus = await new Promise<number | undefined>(
      (resolve, reject) => {
        const second = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path: `/api/v1/sessions/${sessionId}/events`,
            headers: { cookie: `${AUTH_COOKIE_NAME}=user-token` },
          },
          (response) => {
            resolve(response.statusCode);
            response.destroy();
          },
        );
        second.once("error", reject);
        second.end();
      },
    );
    request.destroy();
    await app.close();

    expect(abortedAtControlWrite).toBe(true);
    expect(secondStatus).toBe(200);
    expect(control.controlWrites()).toBe(1);
  });

  it("does not recheck or write another control frame after a timed-out check rejects late", async () => {
    const sessions = sessionService();
    sessions.openEvents.mockImplementationOnce(
      async (_id, _context, signal) => ({
        session: record,
        events: {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                await new Promise<void>((resolve) => {
                  signal?.addEventListener("abort", () => resolve(), {
                    once: true,
                  });
                });
                return { done: true, value: undefined };
              },
            };
          },
        },
      }),
    );
    let authenticateCalls = 0;
    let rejectLateCheck!: (error: Error) => void;
    const lateCheck = new Promise<never>((_resolve, reject) => {
      rejectLateCheck = reject;
    });
    const slowAuth: ApiAuthService = {
      ...auth(),
      authenticate(token) {
        authenticateCalls += 1;
        if (token === "admin-token") {
          return Promise.reject(
            Object.assign(new Error(), { name: "AuthRequiredError" }),
          );
        }
        if (authenticateCalls === 1) {
          return Promise.resolve({
            userId,
            authSubject: "managed:user",
            role: "user" as const,
          });
        }
        return lateCheck;
      },
    };
    const app = buildApp({
      auth: slowAuth,
      sessions,
      sseAuthRecheckIntervalMs: 10,
      sseAuthRecheckBudgetMs: 30,
    });
    const control = holdAuthInvalidWrite(app);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path: `/api/v1/sessions/${sessionId}/events`,
      headers: { cookie: `${AUTH_COOKIE_NAME}=user-token` },
    });
    const chunks: string[] = [];
    request.on("error", () => {});
    request.on("response", (response) => {
      response.on("data", (chunk) => chunks.push(chunk.toString()));
    });
    request.end();

    await vi.waitFor(() => expect(chunks.join("")).toContain("event: ready"));
    await control.attempted;
    rejectLateCheck(Object.assign(new Error(), { name: "AuthRequiredError" }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    const finalAuthenticateCalls = authenticateCalls;
    const finalControlWrites = control.controlWrites();
    request.destroy();
    await app.close();

    expect(finalAuthenticateCalls).toBe(2);
    expect(finalControlWrites).toBe(1);
  });

  it("backpressures a slow SSE client and cancels the blocked stream", async () => {
    const sessions = sessionService();
    const payload = "x".repeat(256 * 1024);
    const eventCount = 200;
    let yielded = 0;
    let released = false;
    let started!: () => void;
    const streaming = new Promise<void>((resolve) => {
      started = resolve;
    });
    sessions.openEvents.mockImplementationOnce(async () => ({
      session: record,
      events: {
        async *[Symbol.asyncIterator]() {
          try {
            for (let index = 1; index <= eventCount; index += 1) {
              yielded += 1;
              if (index === 1) started();
              yield {
                id: `event-${index}`,
                sourceType: "agent.message",
                type: "message" as const,
                createdAt: timestamp.toISOString(),
                payload: { content: payload },
              };
            }
          } finally {
            released = true;
          }
        },
      },
    }));
    const app = buildApp({ auth: auth(), sessions });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const socket = netConnect({ host: "127.0.0.1", port });
    socket.on("error", () => {});
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(
      [
        `GET /api/v1/sessions/${sessionId}/events HTTP/1.1`,
        "Host: 127.0.0.1",
        `Cookie: ${AUTH_COOKIE_NAME}=user-token`,
        "Connection: close",
        "",
        "",
      ].join("\r\n"),
    );

    await streaming;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const yieldedBeforeClose = yielded;
    socket.destroy();
    await vi.waitFor(() => expect(released).toBe(true));
    await app.close();

    expect(yieldedBeforeClose).toBeLessThan(eventCount);
  });
});

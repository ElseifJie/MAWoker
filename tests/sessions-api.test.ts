import { describe, expect, it, vi } from "vitest";
import { ArkGatewayError } from "../packages/ark-client/src/index.js";
import {
  ResourceNotFoundError,
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
    async requestEmailCode() {},
    async verifyEmailCode() {
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
  title: "Task",
  status: "idle",
  archivedAt: null,
  deletionState: "none",
  lastEventAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};

function sessionService() {
  return {
    create: vi.fn(async () => record),
    list: vi.fn(async () => [record]),
    get: vi.fn(async () => record),
    sendMessage: vi.fn(async () => ({
      eventId: "event-1",
      delivery: "queued" as const,
    })),
    interrupt: vi.fn(async () => ({
      eventId: "event-2",
      delivery: "accepted" as const,
    })),
  } satisfies SessionApiService;
}

describe("Session API", () => {
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
    expect(detail.json()).toEqual(create.json());
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

  it("requires user authentication for every Session route", async () => {
    const sessions = sessionService();
    const app = buildApp({ auth: auth(), sessions });
    const cookies = { [AUTH_COOKIE_NAME]: "admin-token" };
    const requests = [
      ["POST", "/api/v1/sessions", { agentId }],
      ["GET", "/api/v1/sessions", undefined],
      ["GET", `/api/v1/sessions/${sessionId}`, undefined],
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
      expect(response.statusCode).toBe(403);
    }
    expect(
      Object.values(sessions).every((call) => call.mock.calls.length === 0),
    ).toBe(true);
    await app.close();
  });
});

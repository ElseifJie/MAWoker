import { describe, expect, it, vi } from "vitest";
import { AUTH_COOKIE_NAME, buildApp } from "../apps/api/src/app.js";
import {
  InvalidChannelUrlError,
  NotificationChannelNameConflictError,
} from "../packages/domain/src/index.js";

const userId = "00000000-0000-4000-8000-000000000001";
const channel = {
  id: "00000000-0000-4000-8000-000000000010",
  name: "Feishu",
  type: "webhook" as const,
  url: "https://open.feishu.cn/open-apis/bot/v2/hook/secret-token",
  enabled: true,
  lastErrorCode: null,
};

function auth() {
  return {
    login: vi.fn(),
    authenticate: vi.fn(async () => ({
      userId,
      sessionId: "session-1",
      authSubject: "subject-user",
      email: "user@example.com",
      role: "user" as const,
    })),
    renew: vi.fn(async () => ({
      expiresAt: new Date("2026-09-07T00:00:00.000Z"),
    })),
    logout: vi.fn(),
  };
}

function channels() {
  return {
    list: vi.fn(async () => [channel]),
    create: vi.fn(async () => channel),
    setEnabled: vi.fn(async () => ({ ...channel, enabled: false })),
    delete: vi.fn(async () => undefined),
  };
}

describe("notification channel API", () => {
  it("masks URLs on list/create and supports disable/delete", async () => {
    const service = channels();
    const app = buildApp({ auth: auth(), notificationChannels: service });
    const cookies = { [AUTH_COOKIE_NAME]: "token" };

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/notification-channels",
      cookies,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().channels[0].url).toBe("https://open.feishu.cn/…oken");
    expect(listed.body).not.toContain("secret-token");

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/notification-channels",
      cookies,
      payload: { name: "Feishu", url: channel.url },
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain("secret-token");

    const disabled = await app.inject({
      method: "PATCH",
      url: `/api/v1/notification-channels/${channel.id}`,
      cookies,
      payload: { enabled: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().channel.enabled).toBe(false);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/notification-channels/${channel.id}`,
      cookies,
    });
    expect(deleted.statusCode).toBe(204);
    await app.close();
  });

  it("maps unsafe URLs and duplicate names", async () => {
    const unsafe = channels();
    unsafe.create.mockRejectedValueOnce(
      new InvalidChannelUrlError("private host"),
    );
    const unsafeApp = buildApp({ auth: auth(), notificationChannels: unsafe });
    const unsafeResponse = await unsafeApp.inject({
      method: "POST",
      url: "/api/v1/notification-channels",
      cookies: { [AUTH_COOKIE_NAME]: "token" },
      payload: { name: "bad", url: "https://127.0.0.1/hook" },
    });
    expect(unsafeResponse.statusCode).toBe(400);
    expect(unsafeResponse.json()).toMatchObject({
      error: { code: "CHANNEL_URL_UNSAFE" },
    });
    await unsafeApp.close();

    const conflict = channels();
    conflict.create.mockRejectedValueOnce(
      new NotificationChannelNameConflictError(),
    );
    const conflictApp = buildApp({
      auth: auth(),
      notificationChannels: conflict,
    });
    const conflictResponse = await conflictApp.inject({
      method: "POST",
      url: "/api/v1/notification-channels",
      cookies: { [AUTH_COOKIE_NAME]: "token" },
      payload: { name: "Feishu", url: channel.url },
    });
    expect(conflictResponse.statusCode).toBe(409);
    await conflictApp.close();
  });
});

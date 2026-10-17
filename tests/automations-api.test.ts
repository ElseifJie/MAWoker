import { describe, expect, it, vi } from "vitest";
import { AUTH_COOKIE_NAME, buildApp } from "../apps/api/src/app.js";
import { InvalidAutomationScheduleError } from "../packages/domain/src/index.js";

const userId = "00000000-0000-4000-8000-000000000001";
const automation = {
  id: "00000000-0000-4000-8000-000000000010",
  ownerUserId: userId,
  title: "喝水",
  kind: "reminder" as const,
  schedule: { type: "daily", time: "09:00" },
  timezone: "Asia/Shanghai",
  nextRunAt: new Date("2026-10-17T01:00:00.000Z"),
  enabled: true,
  scheduleVersion: 1,
  revision: 1,
  createdAt: new Date("2026-10-17T00:00:00.000Z"),
  updatedAt: new Date("2026-10-17T00:00:00.000Z"),
};

function auth() {
  return {
    login: vi.fn(),
    authenticate: vi.fn(async () => ({
      userId,
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

function automations() {
  return {
    list: vi.fn(async () => [automation]),
    create: vi.fn(async () => automation),
    setEnabled: vi.fn(async () => ({ ...automation, enabled: false })),
    delete: vi.fn(async () => undefined),
  };
}

describe("automation API", () => {
  it("lists, creates, pauses, and deletes reminders", async () => {
    const service = automations();
    const app = buildApp({ auth: auth(), automations: service });
    const cookies = { [AUTH_COOKIE_NAME]: "token" };

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/automations",
      cookies,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().automations[0]).toMatchObject({
      id: automation.id,
      title: "喝水",
      nextRunAt: "2026-10-17T01:00:00.000Z",
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/automations",
      cookies,
      payload: {
        title: "喝水",
        schedule: { type: "daily", time: "09:00" },
        timezone: "Asia/Shanghai",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(service.create).toHaveBeenCalledWith(userId, {
      title: "喝水",
      schedule: { type: "daily", time: "09:00" },
      timezone: "Asia/Shanghai",
    });

    const paused = await app.inject({
      method: "PATCH",
      url: `/api/v1/automations/${automation.id}`,
      cookies,
      payload: { enabled: false },
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.json().automation.enabled).toBe(false);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/automations/${automation.id}`,
      cookies,
    });
    expect(deleted.statusCode).toBe(204);
    expect(service.delete).toHaveBeenCalledWith(userId, automation.id);
    await app.close();
  });

  it("maps an invalid schedule to VALIDATION_FAILED", async () => {
    const service = automations();
    service.create.mockRejectedValueOnce(
      new InvalidAutomationScheduleError("Time must be HH:mm"),
    );
    const app = buildApp({ auth: auth(), automations: service });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/automations",
      cookies: { [AUTH_COOKIE_NAME]: "token" },
      payload: {
        title: "坏规则",
        schedule: { type: "daily", time: "25:00" },
        timezone: "Asia/Shanghai",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });
    await app.close();
  });
});

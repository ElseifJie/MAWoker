import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../apps/api/src/app.js";
import { apiErrorSchema } from "../packages/contracts/src/index.js";

const owner = "00000000-0000-4000-8000-000000000001";
const session = "00000000-0000-4000-8000-000000000002";
const turnId = "00000000-0000-4000-8000-000000000003";

function fixture() {
  const delivery = {
    listTurns: vi.fn(async () => [
      {
        id: turnId,
        ownerUserId: owner,
        sessionId: session,
        boundaryEventId: "boundary",
        inputEventId: "input",
        outcome: "completed",
        summary: "token: hidden",
        expectedNames: [],
        artifactState: "synced",
        artifactIds: [],
        usageState: "pending",
        errorCode: null,
        startedAt: new Date(),
        endedAt: new Date(),
        retryUntil: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]),
    requestSyncRetry: vi.fn(async () => true),
    listNotifications: vi.fn(async () => [
      {
        id: turnId,
        ownerUserId: owner,
        sessionId: session,
        turnId,
        kind: "completed",
        readAt: null,
        createdAt: new Date(),
      },
    ]),
    markNotificationRead: vi.fn(async () => true),
  };
  const app = buildApp({
    auth: {
      login: vi.fn(),
      renew: async () => ({ expiresAt: new Date(Date.now() + 60_000) }),
      logout: vi.fn(),
      authenticate: async (token) => ({
        userId: owner,
        authSubject: "subject",
        role: token === "admin" ? "admin" : "user",
      }),
    },
    delivery,
  });
  return { app, delivery };
}

describe("owned delivery records and notifications", () => {
  it("returns safe round state and durable unread notifications for the owner", async () => {
    const { app, delivery } = fixture();
    try {
      const result = await app.inject({
        url: `/api/v1/sessions/${session}/turns`,
        headers: { cookie: "pwa_session=user" },
      });
      expect(result.statusCode).toBe(200);
      expect(result.json().turns[0]).toMatchObject({
        artifactState: "synced",
        usageState: "pending",
        boundaryEventId: "boundary",
        inputEventId: "input",
        startedAt: expect.any(String),
      });
      expect(result.body).not.toContain("hidden");
      expect(result.body).not.toContain("ownerUserId");
      expect(delivery.listTurns).toHaveBeenCalledWith(owner, session);
      const notices = await app.inject({
        url: "/api/v1/notifications",
        headers: { cookie: "pwa_session=user" },
      });
      expect(notices.statusCode).toBe(200);
      expect(notices.json().notifications[0].readAt).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("serves administrators the same owner-scoped delivery routes", async () => {
    const { app, delivery } = fixture();
    try {
      for (const request of [
        { method: "GET" as const, url: `/api/v1/sessions/${session}/turns` },
        {
          method: "POST" as const,
          url: `/api/v1/sessions/${session}/turns/${turnId}/retry`,
        },
        { method: "GET" as const, url: "/api/v1/notifications" },
        {
          method: "POST" as const,
          url: `/api/v1/notifications/${turnId}/read`,
        },
      ]) {
        const response = await app.inject({
          ...request,
          headers: { cookie: "pwa_session=admin" },
        });
        expect(response.statusCode).toBeLessThan(400);
      }
      expect(delivery.listTurns).toHaveBeenCalledWith(owner, session);
      expect(delivery.requestSyncRetry).toHaveBeenCalled();
      expect(delivery.listNotifications).toHaveBeenCalled();
      expect(delivery.markNotificationRead).toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("binds recovery to both the requested session and owned round", async () => {
    const { app, delivery } = fixture();
    try {
      const result = await app.inject({
        method: "POST",
        url: `/api/v1/sessions/${session}/turns/${turnId}/retry`,
        headers: { cookie: "pwa_session=user" },
      });
      expect(result.statusCode).toBe(202);
      expect(delivery.requestSyncRetry).toHaveBeenCalledWith(
        owner,
        turnId,
        expect.any(Date),
        300_000,
        session,
      );
      delivery.requestSyncRetry.mockResolvedValueOnce(false);
      const unavailable = await app.inject({
        method: "POST",
        url: `/api/v1/sessions/${session}/turns/${turnId}/retry`,
        headers: { cookie: "pwa_session=user" },
      });
      expect(unavailable.statusCode).toBe(409);
      expect(apiErrorSchema.safeParse(unavailable.json()).success).toBe(true);
    } finally {
      await app.close();
    }
  });
});

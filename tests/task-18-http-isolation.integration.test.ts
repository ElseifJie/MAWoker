import { describe, expect, it } from "vitest";
import {
  comparableError,
  createTask18HttpHarness,
} from "./support/task-18-http.js";

describe("Task 18 production HTTP tenant matrix", () => {
  it("returns one 404 envelope for foreign and admin Agent, Session, and artifact access", async () => {
    const harness = await createTask18HttpHarness();
    try {
      const resources = [
        {
          name: "Agent",
          path: `/api/v1/agents/${harness.first.personalAgentId}`,
          owner: "first" as const,
        },
        {
          name: "Session",
          path: `/api/v1/sessions/${harness.first.sessionId}`,
          owner: "first" as const,
        },
        {
          name: "artifact",
          path: `/api/v1/artifacts/${harness.first.artifactId}/download`,
          owner: "first" as const,
        },
        {
          name: "Agent",
          path: `/api/v1/agents/${harness.second.personalAgentId}`,
          owner: "second" as const,
        },
        {
          name: "Session",
          path: `/api/v1/sessions/${harness.second.sessionId}`,
          owner: "second" as const,
        },
        {
          name: "artifact",
          path: `/api/v1/artifacts/${harness.second.artifactId}/download`,
          owner: "second" as const,
        },
      ];

      for (const resource of resources) {
        const owner = await harness.app.inject({
          method: "GET",
          url: resource.path,
          cookies: harness.cookies(resource.owner),
        });
        expect(owner.statusCode, `${resource.name} owner`).toBe(200);

        for (const actor of [
          resource.owner === "first" ? "second" : "first",
          "admin",
        ] as const) {
          harness.resetExternalCalls();
          const denied = await harness.app.inject({
            method: "GET",
            url: resource.path,
            cookies: harness.cookies(actor),
          });
          expect(denied.statusCode, `${resource.name} ${actor}`).toBe(404);
          expect(comparableError(denied.json())).toEqual({
            code: "RESOURCE_NOT_FOUND",
            message: "Resource not found",
            retryable: false,
          });
          expect(harness.externalCalls()).toEqual({ ark: 0, tos: 0 });
        }
      }
    } finally {
      await harness.close();
    }
  });

  it("rejects a foreign upload before creating an Ark Session", async () => {
    const harness = await createTask18HttpHarness();
    try {
      harness.resetExternalCalls();
      const response = await harness.app.inject({
        method: "POST",
        url: "/api/v1/sessions",
        cookies: harness.cookies("second"),
        payload: {
          agentId: harness.second.personalAgentId,
          title: "Cross-tenant upload",
          uploadIds: [harness.first.uploadId],
        },
      });

      expect(response.statusCode).toBe(404);
      expect(comparableError(response.json())).toEqual({
        code: "RESOURCE_NOT_FOUND",
        message: "Resource not found",
        retryable: false,
      });
      expect(harness.externalCalls()).toEqual({ ark: 0, tos: 0 });
    } finally {
      await harness.close();
    }
  });

  it("scopes usage to each user and hides the user endpoint from admins", async () => {
    const harness = await createTask18HttpHarness();
    try {
      const first = await harness.app.inject({
        method: "GET",
        url: "/api/v1/usage",
        cookies: harness.cookies("first"),
      });
      const second = await harness.app.inject({
        method: "GET",
        url: "/api/v1/usage",
        cookies: harness.cookies("second"),
      });
      const admin = await harness.app.inject({
        method: "GET",
        url: "/api/v1/usage",
        cookies: harness.cookies("admin"),
      });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(first.json().usage.tokens).toBe(100);
      expect(second.json().usage.tokens).toBe(1);
      expect(admin.statusCode).toBe(404);
      expect(comparableError(admin.json())).toEqual({
        code: "RESOURCE_NOT_FOUND",
        message: "Resource not found",
        retryable: false,
      });
      expect(harness.externalCalls()).toEqual({ ark: 0, tos: 0 });
    } finally {
      await harness.close();
    }
  });
});

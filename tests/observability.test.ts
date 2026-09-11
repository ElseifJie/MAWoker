import { ArkGatewayError } from "@pwa/ark-client";
import { describe, expect, it } from "vitest";
import {
  AUTH_COOKIE_NAME,
  buildApp,
  type ApiAuthService,
  type SessionApiService,
} from "../apps/api/src/app.js";

const userId = "00000000-0000-4000-8000-000000000001";
const sessionId = "00000000-0000-4000-8000-000000000099";

function authService(): ApiAuthService {
  return {
    async login() {
      return {
        token: "issued-session-secret",
        expiresAt: new Date("2026-09-08T00:00:00.000Z"),
      };
    },
    async authenticate(token) {
      if (token !== "cookie-session-secret") throw new Error("invalid token");
      return {
        userId,
        authSubject: "managed:user@example.com",
        role: "user",
      };
    },
    async renew() {
      return { expiresAt: new Date("2026-09-08T00:00:00.000Z") };
    },
    async logout() {},
  };
}

function captureLogs() {
  let output = "";
  return {
    stream: {
      write(message: string) {
        output += message;
      },
    },
    records() {
      return output
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
    text() {
      return output;
    },
  };
}

describe("structured application logging", () => {
  it("redacts credentials, tokens, prompts, messages, filenames, and content", async () => {
    const logs = captureLogs();
    const app = buildApp({ logStream: logs.stream });
    app.get("/logging-redaction-probe", async (request) => {
      request.log.info({
        authorization: "Bearer authorization-secret",
        cookie: "pwa_session=cookie-secret",
        token: "token-secret",
        apiKey: "ark-api-secret",
        clientSecret: "oidc-client-secret",
        accessKeySecret: "tos-access-secret",
        stsToken: "tos-sts-secret",
        systemPrompt: "system-prompt-secret",
        prompt: "prompt-secret",
        message: "message-body-secret",
        content: "file-content-secret",
        filename: "private-filename.txt",
      });
      return { ok: true };
    });

    await app.inject({
      method: "GET",
      url: "/logging-redaction-probe",
      headers: {
        authorization: "Bearer header-secret",
        cookie: "pwa_session=header-cookie-secret",
      },
    });

    const output = logs.text();
    for (const secret of [
      "authorization-secret",
      "cookie-secret",
      "token-secret",
      "ark-api-secret",
      "oidc-client-secret",
      "tos-access-secret",
      "tos-sts-secret",
      "system-prompt-secret",
      "prompt-secret",
      "message-body-secret",
      "file-content-secret",
      "private-filename.txt",
      "header-secret",
      "header-cookie-secret",
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain("[REDACTED]");
    await app.close();
  });

  it("logs safe request, user, resource, result, and Ark request context", async () => {
    const logs = captureLogs();
    const sessions = {
      async sendMessage() {
        throw new ArkGatewayError("rate_limited", {
          arkRequestId: "ark-request-123",
        });
      },
    } as unknown as SessionApiService;
    const app = buildApp({
      auth: authService(),
      sessions,
      logStream: logs.stream,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages`,
      cookies: { [AUTH_COOKIE_NAME]: "cookie-session-secret" },
      payload: { content: "private-user-message" },
    });

    expect(response.statusCode).toBe(429);
    expect(logs.text()).not.toContain("private-user-message");
    expect(logs.text()).not.toContain("cookie-session-secret");
    expect(logs.records()).toContainEqual(
      expect.objectContaining({
        event: "request.completed",
        request_id: expect.any(String),
        user_id: userId,
        resource_type: "session",
        resource_id: sessionId,
        result: "error",
        status_code: 429,
        ark_request_id: "ark-request-123",
      }),
    );
    await app.close();
  });

  it("normalizes unhandled errors without logging their messages", async () => {
    const logs = captureLogs();
    const app = buildApp({ logStream: logs.stream });
    app.get("/logging-error-probe", async () => {
      throw new Error("provider-secret-in-error-message");
    });

    const response = await app.inject({
      method: "GET",
      url: "/logging-error-probe",
    });

    expect(response.statusCode).toBe(500);
    expect(logs.text()).not.toContain("provider-secret-in-error-message");
    expect(logs.records()).toContainEqual(
      expect.objectContaining({
        event: "request.failed",
        request_id: expect.any(String),
        result: "error",
        error_code: "INTERNAL_ERROR",
      }),
    );
    await app.close();
  });
});

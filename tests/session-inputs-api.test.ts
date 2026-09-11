import { describe, expect, it, vi } from "vitest";
import {
  AUTH_COOKIE_NAME,
  buildApp,
  type ApiAuthService,
  type SessionInputApiService,
} from "../apps/api/src/app.js";

const userId = "00000000-0000-4000-8000-000000000001";
const uploadId = "00000000-0000-4000-8000-000000000002";

function auth(): ApiAuthService {
  return {
    async login() {
      return { token: "token", expiresAt: new Date(Date.now() + 60_000) };
    },
    async authenticate(token) {
      if (!token)
        throw Object.assign(new Error(), { name: "AuthRequiredError" });
      return { userId, authSubject: "managed:user", role: "user" };
    },
    async renew() {
      return { expiresAt: new Date(Date.now() + 60_000) };
    },
    async logout() {},
  };
}

function multipart(
  parts: Array<
    | { kind: "file"; name: string; contentType: string; content: string }
    | { kind: "field"; name: string; value: string }
  >,
) {
  const boundary = "task-10-boundary";
  const lines: string[] = [];
  for (const part of parts) {
    lines.push(`--${boundary}`);
    if (part.kind === "file") {
      lines.push(
        `Content-Disposition: form-data; name="file"; filename="${part.name}"`,
        `Content-Type: ${part.contentType}`,
        "",
        part.content,
      );
    } else {
      lines.push(
        `Content-Disposition: form-data; name="${part.name}"`,
        "",
        part.value,
      );
    }
  }
  lines.push(`--${boundary}--`, "");
  return {
    payload: lines.join("\r\n"),
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
  };
}

describe("Session input API", () => {
  it("accepts one authenticated multipart file and minimizes output", async () => {
    const inputs = {
      upload: vi.fn<SessionInputApiService["upload"]>(async () => ({
        id: uploadId,
        ownerUserId: userId,
        sessionId: null,
        arkFileId: "ark-file-secret",
        originalName: "brief.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
        mountPath: `/mnt/session/inputs/${uploadId}-brief.txt`,
        status: "uploaded",
        expiresAt: new Date("2026-09-07T00:00:00.000Z"),
        lastErrorCode: null,
        createdAt: new Date("2026-09-06T00:00:00.000Z"),
        updatedAt: new Date("2026-09-06T00:00:00.000Z"),
      })),
    };
    const app = buildApp({ auth: auth(), inputs });
    const body = multipart([
      {
        kind: "file",
        name: "brief.txt",
        contentType: "text/plain",
        content: "hello",
      },
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/uploads",
      cookies: { [AUTH_COOKIE_NAME]: "token" },
      ...body,
    });

    expect(response.statusCode).toBe(201);
    expect(inputs.upload).toHaveBeenCalledWith(
      {
        name: "brief.txt",
        contentType: "text/plain",
        bytes: new TextEncoder().encode("hello"),
      },
      expect.objectContaining({ userId }),
    );
    expect(response.json()).toEqual({
      id: uploadId,
      name: "brief.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      mountPath: `/mnt/session/inputs/${uploadId}-brief.txt`,
      status: "uploaded",
      expiresAt: "2026-09-07T00:00:00.000Z",
    });
    expect(response.body).not.toMatch(/ownerUserId|arkFileId/);
    await app.close();
  });

  it("rejects absent, multiple, or field-bearing multipart bodies", async () => {
    const inputs = {
      upload: vi.fn<SessionInputApiService["upload"]>(),
    };
    const app = buildApp({ auth: auth(), inputs });
    const cases = [
      multipart([]),
      multipart([
        {
          kind: "file",
          name: "one.txt",
          contentType: "text/plain",
          content: "one",
        },
        {
          kind: "file",
          name: "two.txt",
          contentType: "text/plain",
          content: "two",
        },
      ]),
      multipart([
        { kind: "field", name: "ownerId", value: "other" },
        {
          kind: "file",
          name: "one.txt",
          contentType: "text/plain",
          content: "one",
        },
      ]),
    ];

    for (const body of cases) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/uploads",
        cookies: { [AUTH_COOKIE_NAME]: "token" },
        ...body,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(inputs.upload).not.toHaveBeenCalled();
    await app.close();
  });

  it("requires an authenticated user before processing multipart data", async () => {
    const inputs = {
      upload: vi.fn<SessionInputApiService["upload"]>(),
    };
    const app = buildApp({ auth: auth(), inputs });
    const body = multipart([
      {
        kind: "file",
        name: "brief.txt",
        contentType: "text/plain",
        content: "hello",
      },
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/uploads",
      ...body,
    });

    expect(response.statusCode).toBe(401);
    expect(inputs.upload).not.toHaveBeenCalled();
    await app.close();
  });
});

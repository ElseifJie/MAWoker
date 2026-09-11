import { once } from "node:events";
import { get, type IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  AUTH_COOKIE_NAME,
  buildApp,
  type ApiAuthService,
  type ArtifactApiService,
} from "../apps/api/src/app.js";

const userId = "00000000-0000-4000-8000-000000000001";
const sessionId = "00000000-0000-4000-8000-000000000002";
const artifactId = "00000000-0000-4000-8000-000000000003";
const generatedAt = new Date("2026-09-06T00:00:00.000Z");

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

function service() {
  const record = {
    id: artifactId,
    ownerUserId: userId,
    sessionId,
    arkFileId: "ark-file-private",
    tosObjectKey: "private/object/key",
    name: "report.txt",
    mimeType: "text/plain",
    sizeBytes: 5,
    generatedAt,
    deletionState: "none" as const,
    lastErrorCode: null,
    createdAt: generatedAt,
    updatedAt: generatedAt,
  };
  return {
    syncSession: vi.fn(async () => [record]),
    list: vi.fn(async () => [record]),
    download: vi.fn<ArtifactApiService["download"]>(async () => ({
      name: record.name,
      mimeType: record.mimeType,
      sizeBytes: record.sizeBytes,
      stream: Readable.from([Buffer.from("hello")]),
    })),
    requestDelete: vi.fn(async () => ({
      ...record,
      deletionState: "pending" as const,
    })),
  } satisfies ArtifactApiService;
}

describe("Artifact API", () => {
  it("syncs and lists minimized artifacts with an optional Session filter", async () => {
    const artifacts = service();
    const app = buildApp({ auth: auth(), artifacts });
    const cookies = { [AUTH_COOKIE_NAME]: "token" };

    const sync = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/artifacts/sync`,
      cookies,
      payload: {},
    });
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/artifacts?sessionId=${sessionId}`,
      cookies,
    });

    expect(sync.statusCode).toBe(200);
    expect(artifacts.syncSession).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({ userId }),
    );
    expect(artifacts.list).toHaveBeenCalledWith(userId, sessionId);
    expect(list.json()).toEqual({
      artifacts: [
        {
          id: artifactId,
          sessionId,
          name: "report.txt",
          mimeType: "text/plain",
          sizeBytes: 5,
          generatedAt: generatedAt.toISOString(),
          deletionState: "none",
          error: null,
        },
      ],
    });
    expect(`${sync.body}${list.body}`).not.toMatch(
      /ownerUserId|arkFileId|tosObjectKey|private\/object/,
    );
    await app.close();
  });

  it("streams a private artifact with safe response headers", async () => {
    const artifacts = service();
    const app = buildApp({ auth: auth(), artifacts });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/artifacts/${artifactId}/download`,
      cookies: { [AUTH_COOKIE_NAME]: "token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("hello");
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="report.txt"',
    );
    expect(response.headers.location).toBeUndefined();
    expect(artifacts.download).toHaveBeenCalledWith(
      artifactId,
      userId,
      expect.any(AbortSignal),
    );
    await app.close();
  });

  it("uses an ASCII fallback and RFC 5987 encoding for Unicode filenames", async () => {
    const artifacts = service();
    artifacts.download.mockResolvedValueOnce({
      name: '季度 "报告".txt',
      mimeType: "text/plain",
      sizeBytes: 5,
      stream: Readable.from([Buffer.from("hello")]),
    });
    const app = buildApp({ auth: auth(), artifacts });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/artifacts/${artifactId}/download`,
      cookies: { [AUTH_COOKIE_NAME]: "token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-disposition"]).toBe(
      "attachment; filename=\"__ ____.txt\"; filename*=UTF-8''%E5%AD%A3%E5%BA%A6%20%22%E6%8A%A5%E5%91%8A%22.txt",
    );
    await app.close();
  });

  it("streams a large slow artifact without changing content metadata", async () => {
    const artifacts = service();
    const chunk = Buffer.alloc(64 * 1024, 7);
    const chunkCount = 128;
    artifacts.download.mockResolvedValueOnce({
      name: "large.bin",
      mimeType: "application/octet-stream",
      sizeBytes: chunk.length * chunkCount,
      stream: Readable.from(
        (async function* () {
          for (let index = 0; index < chunkCount; index += 1) {
            await new Promise((resolve) => setTimeout(resolve, 1));
            yield chunk;
          }
        })(),
      ),
    });
    const app = buildApp({ auth: auth(), artifacts });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/artifacts/${artifactId}/download`,
      cookies: { [AUTH_COOKIE_NAME]: "token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toHaveLength(chunk.length * chunkCount);
    expect(response.headers["content-length"]).toBe(
      String(chunk.length * chunkCount),
    );
    expect(response.headers["content-type"]).toContain(
      "application/octet-stream",
    );
    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="large.bin"',
    );
    await app.close();
  });

  it("cancels and destroys a slow source when the client disconnects", async () => {
    const artifacts = service();
    let signal: AbortSignal | undefined;
    let destroyed = false;
    const source = new Readable({
      read() {
        setTimeout(() => {
          if (!this.destroyed) this.push(Buffer.alloc(64 * 1024));
        }, 5);
      },
      destroy(error, callback) {
        destroyed = true;
        callback(error);
      },
    });
    artifacts.download.mockImplementationOnce(async (_id, _userId, input) => {
      signal = input;
      return {
        name: "slow.bin",
        mimeType: "application/octet-stream",
        sizeBytes: 64 * 1024 * 1024,
        stream: source,
      };
    });
    const app = buildApp({ auth: auth(), artifacts });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected an Internet socket");
    }

    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = get(
        {
          host: "127.0.0.1",
          port: address.port,
          path: `/api/v1/artifacts/${artifactId}/download`,
          headers: { cookie: `${AUTH_COOKIE_NAME}=token` },
        },
        resolve,
      );
      request.once("error", reject);
    });
    await once(response, "data");
    response.destroy();
    await once(source, "close");

    expect(signal?.aborted).toBe(true);
    expect(destroyed).toBe(true);
    await app.close();
  });

  it("applies downstream backpressure to a large source stream", async () => {
    const artifacts = service();
    const chunkSize = 64 * 1024;
    const chunkCount = 1_024;
    let produced = 0;
    const source = new Readable({
      read() {
        if (produced === chunkCount) {
          this.push(null);
          return;
        }
        produced += 1;
        this.push(Buffer.alloc(chunkSize));
      },
    });
    artifacts.download.mockResolvedValueOnce({
      name: "large.bin",
      mimeType: "application/octet-stream",
      sizeBytes: chunkSize * chunkCount,
      stream: source,
    });
    const app = buildApp({ auth: auth(), artifacts });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected an Internet socket");
    }

    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = get(
        {
          host: "127.0.0.1",
          port: address.port,
          path: `/api/v1/artifacts/${artifactId}/download`,
          headers: { cookie: `${AUTH_COOKIE_NAME}=token` },
        },
        resolve,
      );
      request.once("error", reject);
    });
    response.pause();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(produced).toBeGreaterThan(0);
    expect(produced).toBeLessThan(chunkCount);
    response.destroy();
    if (!source.destroyed) await once(source, "close");
    await app.close();
  });

  it("returns pending deletion state without exposing storage details", async () => {
    const artifacts = service();
    const app = buildApp({ auth: auth(), artifacts });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/v1/artifacts/${artifactId}`,
      cookies: { [AUTH_COOKIE_NAME]: "token" },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      id: artifactId,
      deletionState: "pending",
    });
    expect(response.body).not.toMatch(/tosObjectKey|arkFileId/);
    await app.close();
  });

  it("normalizes cross-tenant artifact access to 404", async () => {
    const artifacts = service();
    artifacts.download.mockRejectedValueOnce(
      Object.assign(new Error("missing"), { name: "ResourceNotFoundError" }),
    );
    const app = buildApp({ auth: auth(), artifacts });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/artifacts/${artifactId}/download`,
      cookies: { [AUTH_COOKIE_NAME]: "token" },
    });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it.each([
    {
      route: `/api/v1/sessions/${sessionId}/artifacts/sync`,
      method: "POST" as const,
      invoke: (artifacts: ReturnType<typeof service>) =>
        artifacts.syncSession.mockRejectedValueOnce(
          Object.assign(
            new Error(
              "provider denied private/tenant/session/secret-object-key",
            ),
            {
              name: "StorageProviderError",
              code: "STORAGE_UNAVAILABLE",
              operation: "write",
            },
          ),
        ),
      code: "ARTIFACT_STORAGE_UNAVAILABLE",
    },
    {
      route: `/api/v1/artifacts/${artifactId}/download`,
      method: "GET" as const,
      invoke: (artifacts: ReturnType<typeof service>) =>
        artifacts.download.mockRejectedValueOnce(
          Object.assign(new Error("Ark says secret provider detail"), {
            name: "ArkGatewayError",
            category: "invalid_response",
          }),
        ),
      code: "ARTIFACT_SOURCE_UNAVAILABLE",
    },
  ])(
    "maps artifact provider failures to sanitized API errors",
    async ({ route, method, invoke, code }) => {
      const artifacts = service();
      invoke(artifacts);
      let logs = "";
      const app = buildApp({
        auth: auth(),
        artifacts,
        logStream: {
          write(message) {
            logs += message;
          },
        },
      });

      const response = await app.inject({
        method,
        url: route,
        cookies: { [AUTH_COOKIE_NAME]: "token" },
        ...(method === "POST" ? { payload: {} } : {}),
      });

      expect(response.statusCode).toBe(503);
      expect(response.json().error).toMatchObject({
        code,
        retryable: true,
      });
      expect(response.body).not.toMatch(
        /secret|object-key|provider denied|Ark says/,
      );
      expect(logs).toContain(code);
      expect(logs).not.toMatch(/secret|object-key|provider denied|Ark says/);
      await app.close();
    },
  );
});

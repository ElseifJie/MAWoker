import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { AUTH_COOKIE_NAME, buildApp } from "../apps/api/src/app.js";

describe("material preparation disconnect", () => {
  it.each(["reuse", "upload"] as const)(
    "aborts %s after the request body was received",
    async (operation) => {
      let signal: AbortSignal | undefined;
      const prepare = async (...args: unknown[]): Promise<never> => {
        signal = (args[1] as { signal: AbortSignal }).signal;
        await new Promise<void>((resolve) =>
          signal!.addEventListener("abort", () => resolve(), { once: true }),
        );
        throw signal.reason;
      };
      const app = buildApp({
        auth: {
          renew: async () => ({ expiresAt: new Date(Date.now() + 60_000) }),
          authenticate: async () => ({
            userId: "00000000-0000-4000-8000-000000000001",
            authSubject: "managed:user",
            role: "user",
          }),
        } as never,
        inputs: { upload: prepare } as never,
        fileReuse: { prepare },
      });
      await app.listen({ host: "127.0.0.1", port: 0 });
      const port = (app.server.address() as AddressInfo).port;
      const payload =
        '--material\r\nContent-Disposition: form-data; name="file"; filename="report.txt"\r\nContent-Type: text/plain\r\n\r\nabc\r\n--material--\r\n';
      const request = httpRequest({
        host: "127.0.0.1",
        port,
        method: "POST",
        path:
          operation === "reuse"
            ? "/api/v1/artifacts/00000000-0000-4000-8000-000000000002/reuse"
            : "/api/v1/uploads",
        headers: {
          cookie: `${AUTH_COOKIE_NAME}=test`,
          ...(operation === "upload"
            ? {
                "content-type": "multipart/form-data; boundary=material",
                "content-length": Buffer.byteLength(payload),
              }
            : {}),
        },
      });
      request.on("error", () => {});
      try {
        request.end(operation === "upload" ? payload : undefined);
        await vi.waitFor(() => expect(signal).toBeDefined());
        expect(signal!.aborted).toBe(false);
        request.destroy();
        await vi.waitFor(() => expect(signal!.aborted).toBe(true));
      } finally {
        request.destroy();
        await app.close();
      }
    },
  );
});

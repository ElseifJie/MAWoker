import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { startWorkerLivenessServer } from "../apps/worker/src/health.js";

describe("worker liveness", () => {
  it("serves an independent liveness endpoint", async () => {
    const health = startWorkerLivenessServer({
      host: "127.0.0.1",
      port: 0,
    });
    await once(health.server, "listening");

    try {
      const address = health.server.address();
      if (!address || typeof address === "string") {
        throw new Error("worker health server did not bind a TCP port");
      }
      const response = await fetch(
        `http://127.0.0.1:${address.port}/health/live`,
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "live" });
    } finally {
      await health.close();
    }
  });
});

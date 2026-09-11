import { ArkGatewayError } from "@pwa/ark-client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createWorkerLogger,
  logWorkerFailure,
} from "../apps/worker/src/logger.js";

describe("worker structured logging", () => {
  it("logs stable error context without serializing secrets or messages", () => {
    let output = "";
    const logger = createWorkerLogger({
      write(message: string) {
        output += message;
      },
    });
    const error = new ArkGatewayError("unavailable", {
      arkRequestId: "ark-worker-request-123",
    });
    Object.defineProperty(error, "message", {
      value: "worker-provider-secret",
    });

    logWorkerFailure(logger, "worker.poll.failed", error);

    expect(output).not.toContain("worker-provider-secret");
    expect(JSON.parse(output)).toMatchObject({
      event: "worker.poll.failed",
      result: "error",
      error_code: "unavailable",
      ark_request_id: "ark-worker-request-123",
    });
  });

  it("injects the safe logger into usage reconciliation", () => {
    const entrypoint = readFileSync(
      resolve(import.meta.dirname, "../apps/worker/src/index.ts"),
      "utf8",
    );

    expect(entrypoint).toMatch(
      /new UsageReconciliationProcessor\(\{[\s\S]*?reportError: reportWorkerError,[\s\S]*?\}\)/,
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  isPublicSessionEvent,
  projectArkEvent,
} from "../packages/domain/src/index.js";

describe("Ark usage projection", () => {
  it("strictly projects model tokens at the Ark event timestamp", () => {
    const projected = projectArkEvent({
      id: "event-usage",
      type: "span.model_request_end",
      createdAt: "2026-08-31T23:59:59.999Z",
      data: {
        model_usage: {
          input_tokens: 11,
          output_tokens: 7,
          cache_read_input_tokens: 3,
        },
      },
    });

    expect(projected).toEqual({
      eventId: "event-usage",
      observedAt: new Date("2026-08-31T23:59:59.999Z"),
      metrics: [
        { metricType: "input_tokens", quantity: 11 },
        { metricType: "output_tokens", quantity: 7 },
      ],
    });
  });

  it.each([
    { input_tokens: "11", output_tokens: 7 },
    { input_tokens: -1, output_tokens: 7 },
    { input_tokens: 11.5, output_tokens: 7 },
    { input_tokens: 11 },
    { inputTokens: 11, outputTokens: 7 },
  ])("rejects malformed or aliased model usage %#", (modelUsage) => {
    expect(
      projectArkEvent({
        id: "event-invalid-usage",
        type: "span.model_request_end",
        createdAt: "2026-09-01T00:00:00.000Z",
        data: { model_usage: modelUsage },
      }).metrics,
    ).toEqual([]);
  });

  it.each(["agent.tool_use", "agent.mcp_tool_use", "agent.custom_tool_use"])(
    "counts the exact Ark tool-use event %s",
    (type) => {
      const call = projectArkEvent({
        id: "event-tool-call",
        type,
        createdAt: "2026-09-01T00:00:00.000Z",
        data: { name: "search" },
      });
      const result = projectArkEvent({
        id: "event-tool-result",
        type: "agent.tool_result",
        createdAt: "2026-09-01T00:00:01.000Z",
        data: { name: "search" },
      });

      expect(call.metrics).toEqual([{ metricType: "tool_calls", quantity: 1 }]);
      expect(result.metrics).toEqual([]);
    },
  );

  it.each([
    ["session.status_running", "running"],
    ["session.status_rescheduled", "rescheduled"],
    ["session.status_idle", "idle"],
    ["session.status_terminated", "terminated"],
  ] as const)("maps the exact Ark status event %s", (type, status) => {
    expect(
      projectArkEvent({
        id: "event-status",
        type,
        createdAt: "2026-09-01T00:00:00.000Z",
        data: {},
      }),
    ).toMatchObject({ status });
  });

  it("rejects status aliases and keeps internal spans private", () => {
    expect(
      projectArkEvent({
        id: "event-invalid-status",
        type: "session.status",
        createdAt: "2026-09-01T00:00:00.000Z",
        data: { status: "RUNNING" },
      }),
    ).not.toHaveProperty("status");
    expect(isPublicSessionEvent("span.model_request_end")).toBe(false);
    expect(isPublicSessionEvent("span.model_request_start")).toBe(false);
    expect(isPublicSessionEvent("session.usage")).toBe(false);
    expect(isPublicSessionEvent("agent.message")).toBe(true);
  });

  it.each([
    ["retrying", "rescheduled", true],
    ["terminal", "terminated", false],
    ["exhausted", "terminated", false],
  ] as const)(
    "strictly maps nested Ark error retry status %s",
    (retryStatus, status, recoverable) => {
      expect(
        projectArkEvent({
          id: `event-error-${retryStatus}`,
          type: "session.error",
          createdAt: "2026-09-01T00:00:00.000Z",
          data: {
            error: {
              type: "model_rate_limited_error",
              message: "internal provider detail",
              retry_status: { type: retryStatus },
            },
          },
        }),
      ).toMatchObject({
        status,
        errorCode: "model_rate_limited_error",
        errorRecoverable: recoverable,
      });
    },
  );
});

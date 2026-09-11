import { describe, expect, it } from "vitest";
import {
  apiErrorSchema,
  createAgentSchema,
  normalizeArkEvent,
} from "../packages/contracts/src/index.js";

describe("shared contracts", () => {
  it.each(["owner_id", "tenant_id", "role"])(
    "rejects the authority field %s and undeclared input",
    (field) => {
      const result = createAgentSchema.safeParse({
        name: "Research",
        description: "",
        modelId: "allowed-model",
        systemPrompt: "Be precise.",
        [field]: "untrusted",
      });

      expect(result.success).toBe(false);
    },
  );

  it("never carries reasoning text into UI events", () => {
    expect(
      normalizeArkEvent({
        id: "evt-thinking",
        type: "agent.thinking",
        createdAt: "2026-09-06T00:00:00.000Z",
        data: { content: "private reasoning", status: "thinking" },
      }),
    ).toEqual({
      id: "evt-thinking",
      sourceType: "agent.thinking",
      type: "thinking",
      createdAt: "2026-09-06T00:00:00.000Z",
      payload: {},
    });
  });

  it("summarizes tool calls instead of forwarding raw arguments", () => {
    const search = normalizeArkEvent({
      id: "call_search_1",
      type: "agent.tool_use",
      createdAt: "2026-09-06T00:00:00.000Z",
      data: {
        name: "web_search",
        input: {
          search_request_list: [{ query: "doubao pricing" }],
          max_results: 5,
        },
        evaluated_permission: "allow",
      },
    });
    expect(search.type).toBe("tool_use");
    expect(search.payload).toEqual({
      callId: "call_search_1",
      name: "web_search",
      argsSummary: "doubao pricing",
    });

    const shell = normalizeArkEvent({
      id: "call_bash_1",
      type: "agent.tool_use",
      createdAt: "2026-09-06T00:00:00.000Z",
      data: {
        name: "bash",
        input: {
          command: "curl -H 'Authorization: Bearer sk-live-abcdefghijklmnop'",
          description: "下载价格快照",
        },
      },
    });
    expect(shell.payload).toEqual({
      callId: "call_bash_1",
      name: "bash",
      argsSummary: "下载价格快照",
    });
    expect(JSON.stringify(shell)).not.toContain("sk-live");
  });

  it("pairs tool results by call id and reports failure from is_error", () => {
    const succeeded = normalizeArkEvent({
      id: "evt-result-ok",
      type: "agent.tool_result",
      createdAt: "2026-09-06T00:00:00.000Z",
      data: {
        tool_use_id: "call_read_1",
        content: [{ type: "text", text: "first line" }],
        is_error: false,
      },
    });
    expect(succeeded.type).toBe("tool_result");
    expect(succeeded.payload).toMatchObject({
      callId: "call_read_1",
      status: "ok",
      preview: "first line",
    });

    const failed = normalizeArkEvent({
      id: "evt-result-failed",
      type: "agent.tool_result",
      createdAt: "2026-09-06T00:00:00.000Z",
      data: {
        tool_use_id: "call_read_2",
        is_error: true,
        content:
          '{"is_error":true,"error":{"tool":"read","code":"not_found","message":"missing /mnt/skills/pdf/extract.md"}}',
      },
    });
    expect(failed.payload).toMatchObject({
      callId: "call_read_2",
      status: "failed",
      errorCode: "not_found",
      errorMessage: "missing [redacted-path]",
    });
    expect(JSON.stringify(failed)).not.toContain("/mnt/skills/");
  });

  it("reads the MCP tool result call id from its own key", () => {
    const mcp = normalizeArkEvent({
      id: "evt-mcp-result",
      type: "agent.mcp_tool_result",
      createdAt: "2026-09-06T00:00:00.000Z",
      data: { mcp_tool_use_id: "call_mcp_1", content: "42", is_error: false },
    });
    expect(mcp.payload).toMatchObject({ callId: "call_mcp_1", status: "ok" });
  });

  it("carries only the status and stop reason from lifecycle events", () => {
    expect(
      normalizeArkEvent({
        id: "evt-idle",
        type: "session.status_idle",
        createdAt: "2026-09-06T00:00:00.000Z",
        data: {
          stop_reason: { type: "end_turn" },
          session_thread_id: "thread-secret",
          agent_name: "internal-name",
        },
      }).payload,
    ).toEqual({ status: "idle", stopReason: "end_turn" });
  });

  it.each([
    "span.model_request_end",
    "session.thread_status_idle",
    "session.deleted",
    "session.usage",
    "some.future.ark.event",
  ])("yields an empty payload for the unwhitelisted type %s", (type) => {
    const event = normalizeArkEvent({
      id: "evt-unlisted",
      type,
      createdAt: "2026-09-06T00:00:00.000Z",
      data: {
        agent_name: "internal-name",
        session_thread_id: "thread-secret",
        model_usage: { input_tokens: 10 },
      },
    });
    expect(event.payload).toEqual({});
    expect(JSON.stringify(event)).not.toContain("internal-name");
    expect(JSON.stringify(event)).not.toContain("thread-secret");
  });

  it("defines a stable API error envelope", () => {
    expect(
      apiErrorSchema.parse({
        error: {
          code: "RESOURCE_NOT_FOUND",
          message: "Not found",
          requestId: "req-1",
          retryable: false,
        },
      }),
    ).toBeTruthy();
  });

  it("rejects undeclared fields in error and event envelopes", () => {
    expect(
      apiErrorSchema.safeParse({
        error: {
          code: "RESOURCE_NOT_FOUND",
          message: "Not found",
          requestId: "req-1",
          retryable: false,
        },
        tenant_id: "untrusted",
      }).success,
    ).toBe(false);

    expect(() =>
      normalizeArkEvent({
        id: "evt-1",
        type: "agent.message",
        createdAt: "2026-09-06T00:00:00.000Z",
        data: {},
        role: "admin",
      } as never),
    ).toThrow();
  });
});

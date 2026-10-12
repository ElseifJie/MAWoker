import { describe, expect, it } from "vitest";
import {
  apiErrorSchema,
  createAgentSchema,
  normalizeArkEvent,
  projectUiEvent,
  uiEventType,
  type UiEvent,
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

  it.each([
    ["agent.tool_use", "stale-call-id"],
    ["agent.mcp_tool_use", 42],
    ["agent.custom_tool_use", null],
    ["tool.call", undefined],
  ])(
    "derives the %s call ID from the event ID instead of stored payload %j",
    (sourceType, storedCallId) => {
      const id = `canonical-${sourceType}`;
      const projected = projectUiEvent({
        id,
        sourceType,
        type: "tool_use",
        createdAt: "2026-09-06T00:00:00.000Z",
        payload: {
          callId: storedCallId,
          name: "read",
        },
      } as unknown as UiEvent);
      const live = normalizeArkEvent({
        id,
        type: sourceType,
        createdAt: "2026-09-06T00:00:00.000Z",
        data: { name: "read" },
      });

      expect(projected.payload.callId).toBe(id);
      expect(projected).toEqual(live);
      expect(projectUiEvent(projected)).toEqual(projected);
    },
  );

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
    ["session.status_running", "running", "terminated"],
    ["session.status_rescheduled", "rescheduled", 42],
    ["session.status_idle", "idle", "failed"],
    ["session.status_terminated", "terminated", null],
  ])(
    "derives %s legacy status as %s instead of trusting payload %j",
    (sourceType, status, storedStatus) => {
      const projected = projectUiEvent({
        id: `evt-${status}`,
        sourceType,
        type: "status",
        createdAt: "2026-09-06T00:00:00.000Z",
        payload: {
          status: storedStatus,
          stopReason: "end_turn",
        },
      } as unknown as UiEvent);

      expect(projected.payload).toEqual({
        status,
        stopReason: "end_turn",
      });
      expect(projectUiEvent(projected)).toEqual(projected);
    },
  );

  it.each([
    "idle",
    "running",
    "rescheduled",
    "initializing",
    "upgrading",
    "failed",
    "terminated",
  ])("retains the valid generic session status %s", (status) => {
    expect(
      projectUiEvent({
        id: `evt-${status}`,
        sourceType: "session.status",
        type: "status",
        createdAt: "2026-09-06T00:00:00.000Z",
        payload: { status, stopReason: "status_update" },
      }).payload,
    ).toEqual({ status, stopReason: "status_update" });
  });

  it.each(["paused", 42, null, { state: "idle" }])(
    "drops the invalid generic session status %j",
    (status) => {
      expect(
        projectUiEvent({
          id: "evt-invalid-status",
          sourceType: "session.status",
          type: "status",
          createdAt: "2026-09-06T00:00:00.000Z",
          payload: { status, stopReason: "status_update" },
        } as unknown as UiEvent).payload,
      ).toEqual({ stopReason: "status_update" });
    },
  );

  it("keeps specialized legacy status projection in parity with live normalization", () => {
    const live = normalizeArkEvent({
      id: "evt-status-parity",
      type: "session.status_idle",
      createdAt: "2026-09-06T00:00:00.000Z",
      data: {
        status: "terminated",
        stop_reason: { type: "end_turn" },
      },
    });
    const legacy = projectUiEvent({
      id: "evt-status-parity",
      sourceType: "session.status_idle",
      type: "status",
      createdAt: "2026-09-06T00:00:00.000Z",
      payload: {
        status: "terminated",
        stopReason: "end_turn",
      },
    });

    expect(legacy).toEqual(live);
    expect(projectUiEvent(legacy)).toEqual(legacy);
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

  it("rebuilds already-public event payloads from per-type allowlists", () => {
    const cases: Array<[UiEvent, Record<string, unknown>]> = [
      [
        {
          id: "message-1",
          sourceType: "agent.message",
          type: "unknown",
          createdAt: "2026-09-06T00:00:00.000Z",
          payload: {
            content: "hello",
            internal: "drop-message-internal",
          },
        },
        { content: "hello" },
      ],
      [
        {
          id: "tool-1",
          sourceType: "agent.tool_use",
          type: "unknown",
          createdAt: "2026-09-06T00:00:01.000Z",
          payload: {
            callId: "tool-1",
            name: "todo_write",
            serverName: "tasks",
            argsSummary: "update plan",
            todos: [{ content: "ship fix", status: "in_progress" }],
            input: { token: "drop-tool-input" },
          },
        },
        {
          callId: "tool-1",
          name: "todo_write",
          serverName: "tasks",
          argsSummary: "update plan",
          todos: [{ content: "ship fix", status: "in_progress" }],
        },
      ],
      [
        {
          id: "result-1",
          sourceType: "agent.tool_result",
          type: "message",
          createdAt: "2026-09-06T00:00:02.000Z",
          payload: {
            callId: "tool-1",
            status: "failed",
            preview: "failed output",
            errorCode: "not_found",
            errorMessage: "missing file",
            raw: "drop-result-raw",
          },
        },
        {
          callId: "tool-1",
          status: "failed",
          preview: "failed output",
          errorCode: "not_found",
          errorMessage: "missing file",
        },
      ],
      [
        {
          id: "status-1",
          sourceType: "session.status_idle",
          type: "error",
          createdAt: "2026-09-06T00:00:03.000Z",
          payload: {
            status: "idle",
            stopReason: "end_turn",
            threadId: "drop-thread-id",
          },
        },
        { status: "idle", stopReason: "end_turn" },
      ],
      [
        {
          id: "error-1",
          sourceType: "session.error",
          type: "status",
          createdAt: "2026-09-06T00:00:04.000Z",
          payload: {
            code: "TEMPORARY",
            message: "retrying",
            recoverable: true,
            stack: "drop-error-stack",
          },
        },
        { code: "TEMPORARY", message: "retrying", recoverable: true },
      ],
    ];

    for (const [input, payload] of cases) {
      expect(projectUiEvent(input)).toEqual({
        ...input,
        type: uiEventType(input.sourceType),
        payload,
      });
    }
  });

  it("drops malformed projected values without coercing them", () => {
    expect(
      projectUiEvent({
        id: "tool-malformed",
        sourceType: "agent.tool_use",
        type: "tool_use",
        createdAt: "2026-09-06T00:00:00.000Z",
        payload: {
          callId: 42,
          name: ["bash"],
          serverName: null,
          argsSummary: { command: "echo secret" },
          todos: [
            { content: "valid", status: "pending" },
            { content: 123, status: "completed" },
            { content: "invalid status", status: "blocked" },
          ],
        },
      } as unknown as UiEvent),
    ).toEqual({
      id: "tool-malformed",
      sourceType: "agent.tool_use",
      type: "tool_use",
      createdAt: "2026-09-06T00:00:00.000Z",
      payload: {
        callId: "tool-malformed",
        todos: [{ content: "valid", status: "pending" }],
      },
    });
  });

  it.each(["agent.thinking", "some.internal.future_event"])(
    "exposes no projected payload fields for %s",
    (sourceType) => {
      expect(
        projectUiEvent({
          id: "private-1",
          sourceType,
          type: "message",
          createdAt: "2026-09-06T00:00:00.000Z",
          payload: {
            content: "private",
            token: "legacy-secret",
            internal: { trace: true },
          },
        }),
      ).toEqual({
        id: "private-1",
        sourceType,
        type: uiEventType(sourceType),
        createdAt: "2026-09-06T00:00:00.000Z",
        payload: {},
      });
    },
  );

  it("is pure and idempotent for already-projected events", () => {
    const input: UiEvent = {
      id: "result-idempotent",
      sourceType: "agent.tool_result",
      type: "tool_result",
      createdAt: "2026-09-06T00:00:00.000Z",
      payload: {
        callId: "tool-1",
        status: "ok",
        preview: "read /workspace/result.txt",
      },
    };
    const before = structuredClone(input);
    const once = projectUiEvent(input);

    expect(input).toEqual(before);
    expect(projectUiEvent(once)).toEqual(once);
    expect(once).not.toBe(input);
    expect(once.payload).not.toBe(input.payload);
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

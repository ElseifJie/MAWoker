import { describe, expect, it } from "vitest";
import {
  normalizeArkEvent,
  extractTodos,
  redactCredentials,
  redactPreview,
  redactText,
  summarizeToolArgs,
  summarizeToolResult,
  TOOL_ARGS_LIMIT,
  TOOL_PREVIEW_LIMIT,
} from "../packages/contracts/src/index.js";
import {
  arkFixtures,
  loadArkFixture,
  type ArkFixtureName,
} from "./support/ark-fixtures.js";

// Synthetic credential-shaped bait deliberately present in the committed
// fixtures so these assertions have something to catch. The values are fake;
// removing the bait entirely would make the sweep vacuous.
const FORBIDDEN = [
  "/mnt/skills/",
  "X-Tos-Signature",
  "X-Tos-Credential",
  "X-Tos-Algorithm",
  "x-signature",
  "lk3s=fixturesynthetic",
  "AKLTSYNTHETICFIXTUREKEY",
  "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  "SYNTHETICXSIGNATURE0000000000000000",
];

const FORBIDDEN_PATTERNS = [
  /\b(?:sk|ark|ak)-[A-Za-z0-9_-]{16,}\b/i,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\b(?:authorization|cookie|x-api-key|api[_-]?key|password|secret|token)\b\s*[:=]\s*\S+/i,
];

describe("tool payload redaction", () => {
  it("strips the signature and expiry from a signed URL", () => {
    expect(
      redactText(
        "fetched https://cdn.example.com/a.jpeg?lk3s=fixturesynthetic&x-expires=1794040668&x-signature=SYNTHETICXSIGNATURE0000000000000000%3D done",
      ),
    ).toBe("fetched https://cdn.example.com/a.jpeg done");
  });

  it("strips a signed URL glued onto preceding message text", () => {
    expect(
      redactCredentials(
        "请将附件制作成12页的ppthttps://bucket.tos-cn-beijing.volces.com/Document/1.pdf?X-Tos-Credential=AKLTSYNTHETICFIXTUREKEY&X-Tos-Signature=deadbeefdeadbeef",
      ),
    ).toBe(
      "请将附件制作成12页的ppthttps://bucket.tos-cn-beijing.volces.com/Document/1.pdf",
    );
  });

  it("does not redact ordinary hyphenated words that merely resemble a key", () => {
    expect(redactCredentials("see task-1234567890123456 and disk-abcdef")).toBe(
      "see task-1234567890123456 and disk-abcdef",
    );
  });

  it("erases a bearer token without swallowing the rest of the sentence", () => {
    expect(
      redactCredentials(
        "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig expired, retry the call",
      ),
    ).toBe("Authorization: [redacted] expired, retry the call");
  });

  it("erases object-store keys and credential-shaped strings", () => {
    const redacted = redactText(
      [
        "tos-cn-beijing/b4d2e4e9c1a3f5b7d9e1c3a5f7b9d1e3c5a7f9b1d3e5c7a9b1d3e5f7/Document/1.pdf",
        "sk-live-abcdefghijklmnopqrst",
        "AKIAIOSFODNN7EXAMPLE",
        "Authorization: Bearer abc.def.ghi",
        "Cookie: session=9f8e7d6c5b4a",
      ].join("\n"),
    );

    expect(redacted).toContain("[redacted-object-key]");
    expect(redacted).not.toMatch(FORBIDDEN_PATTERNS[0]!);
    expect(redacted).not.toMatch(FORBIDDEN_PATTERNS[1]!);
    expect(redacted).not.toContain("abc.def.ghi");
    expect(redacted).not.toContain("9f8e7d6c5b4a");
  });

  it("erases platform Skill paths but keeps the Agent workspace and session mount", () => {
    const redacted = redactText(
      [
        "/mnt/skills/ppt-master/workflows/routing.md",
        "/workspace/report.md",
        "/mnt/session/outputs/deck.pptx",
        "/mnt/session/storage/input/brief.pdf",
        "/etc/passwd",
      ].join("\n"),
    );

    expect(redacted).not.toContain("/mnt/skills/");
    expect(redacted).toContain("[redacted-path]");
    expect(redacted).toContain("/workspace/report.md");
    expect(redacted).toContain("/mnt/session/outputs/deck.pptx");
    expect(redacted).toContain("/mnt/session/storage/input/brief.pdf");
    expect(redacted).not.toContain("/etc/");
    expect(redacted).toContain("passwd");
  });

  it("bounds the preview length", () => {
    const preview = redactPreview("x".repeat(TOOL_PREVIEW_LIMIT * 4));
    expect(preview.length).toBeLessThanOrEqual(TOOL_PREVIEW_LIMIT + 1);
    expect(preview.endsWith("…")).toBe(true);
  });

  it("prefers the model-written description over the raw shell command", () => {
    expect(
      summarizeToolArgs("bash", {
        command: "curl -s https://api.example.com/v1/prices | jq .",
        description: "下载价格快照并校验JSON",
        run_in_background: false,
      }),
    ).toBe("下载价格快照并校验JSON");
  });

  it("reads the nested web_search query list", () => {
    expect(
      summarizeToolArgs("web_search", {
        search_request_list: [{ query: "豆包价格" }, { query: "ark pricing" }],
        max_results: 5,
      }),
    ).toBe("豆包价格 · ark pricing");
  });

  it("drops credential keys and nested values from unknown tool schemas", () => {
    const summary = summarizeToolArgs("list_models", {
      page_size: 10,
      api_key: "AKLTabcdefghijklmnop",
      filter: { nested: "value" },
    });

    expect(summary).toBe("page_size=10");
  });

  it("bounds an argument summary drawn from an unbounded command", () => {
    const summary = summarizeToolArgs("bash", {
      command: "echo ".concat("x".repeat(5000)),
    })!;
    expect(summary.length).toBeLessThanOrEqual(TOOL_ARGS_LIMIT * 2 + 1);
  });

  it("extracts a bounded, status-validated task list", () => {
    const todos = extractTodos({
      todos: [
        { content: "抓取价格", status: "completed" },
        { content: "生成对比表", status: "in_progress" },
        { content: "写出报告", status: "pending" },
        { content: "ignored", status: "blocked" },
        { status: "pending" },
        "not-an-object",
      ],
    });

    expect(todos).toEqual([
      { content: "抓取价格", status: "completed" },
      { content: "生成对比表", status: "in_progress" },
      { content: "写出报告", status: "pending" },
    ]);
    expect(extractTodos({ todos: [] })).toBeUndefined();
    expect(extractTodos({})).toBeUndefined();
  });

  it("drives result status from is_error, not from an absent status string", () => {
    expect(summarizeToolResult("ok", false).status).toBe("ok");
    expect(summarizeToolResult("ok", undefined).status).toBe("ok");
    expect(summarizeToolResult("boom", true).status).toBe("failed");

    const failed = summarizeToolResult(
      JSON.stringify({
        is_error: true,
        error: {
          tool: "read",
          code: "not_found",
          message: "no such file /mnt/skills/pdf/extract.md",
        },
      }),
      true,
    );
    expect(failed).toMatchObject({
      status: "failed",
      errorCode: "not_found",
      errorMessage: "no such file [redacted-path]",
    });
  });

  it("joins text blocks and ignores non-text content", () => {
    expect(
      summarizeToolResult(
        [
          { type: "text", text: "line one\n" },
          { type: "image", source: "data" },
          { type: "text", text: "line two" },
        ],
        false,
      ).preview,
    ).toBe("line one\nline two");
  });

  it("leaves malformed error envelopes as an ordinary preview", () => {
    const result = summarizeToolResult('{"error": ', true);
    expect(result).toMatchObject({ status: "failed", preview: '{"error": ' });
    expect(result.errorCode).toBeUndefined();
  });
});

describe("redaction over captured Ark traffic", () => {
  const names = Object.keys(arkFixtures) as ArkFixtureName[];
  const events = names.flatMap((name) => loadArkFixture(name));
  const uiEvents = events.map((event) => normalizeArkEvent(event));
  const serialized = uiEvents.map((event) => JSON.stringify(event));

  it("covers a meaningful amount of real traffic", () => {
    expect(events.length).toBeGreaterThan(200);
    expect(
      uiEvents.filter((event) => event.type === "tool_use").length,
    ).toBeGreaterThan(30);
  });

  it.each(FORBIDDEN)("never emits %s", (needle) => {
    for (const [index, payload] of serialized.entries()) {
      if (payload.includes(needle)) {
        throw new Error(
          `${needle} leaked from ${uiEvents[index]!.sourceType} (${uiEvents[index]!.id})`,
        );
      }
    }
  });

  it("never emits a credential-shaped string", () => {
    for (const [index, payload] of serialized.entries()) {
      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(
          payload.match(pattern),
          `${pattern} matched in ${uiEvents[index]!.sourceType}`,
        ).toBeNull();
      }
    }
  });

  it("never emits reasoning text", () => {
    for (const event of uiEvents) {
      if (event.type === "thinking") expect(event.payload).toEqual({});
    }
    expect(
      uiEvents.filter((event) => event.type === "thinking").length,
    ).toBeGreaterThan(20);
  });

  it("bounds every preview it emits", () => {
    let previews = 0;
    for (const event of uiEvents) {
      const preview = event.payload.preview;
      if (typeof preview !== "string") continue;
      previews += 1;
      expect(preview.length).toBeLessThanOrEqual(TOOL_PREVIEW_LIMIT + 1);
    }
    expect(previews).toBeGreaterThan(30);
  });

  it("erases presigned attachment URLs from message bodies but keeps their paths", () => {
    const event = normalizeArkEvent({
      id: "sevt-1",
      type: "user.message",
      createdAt: "2026-09-06T00:00:00.000Z",
      data: {
        content:
          "请把 /workspace/brief.md 转成 12 页 ppt https://bucket.tos-cn-beijing.volces.com/Document/1.pdf?X-Tos-Algorithm=TOS4-HMAC-SHA256&X-Tos-Credential=AKLTSYNTHETICFIXTUREKEY%2F20260904%2Fcn-beijing%2Ftos%2Frequest&X-Tos-Expires=2592000&X-Tos-Signature=deadbeefdeadbeef",
      },
    });

    const wire = JSON.stringify(event);
    expect(wire).not.toContain("X-Tos-Credential");
    expect(wire).not.toContain("AKLTSYNTHETICFIXTUREKEY");
    expect(wire).not.toContain("deadbeefdeadbeef");
    expect(event.payload).toEqual({
      content:
        "请把 /workspace/brief.md 转成 12 页 ppt https://bucket.tos-cn-beijing.volces.com/Document/1.pdf",
    });
  });

  it("keeps the Agent workspace paths that identify artifacts", () => {
    expect(serialized.some((payload) => payload.includes("/workspace/"))).toBe(
      true,
    );
  });

  it("surfaces the real task list and at least one failed call", () => {
    expect(
      uiEvents.some(
        (event) =>
          Array.isArray(event.payload.todos) && event.payload.todos.length > 0,
      ),
    ).toBe(true);
    expect(
      uiEvents.some(
        (event) =>
          event.type === "tool_result" && event.payload.status === "failed",
      ),
    ).toBe(true);
  });

  it("pairs every tool call with a result carrying the same call id", () => {
    const uses = uiEvents.filter((event) => event.type === "tool_use");
    const results = new Map(
      uiEvents
        .filter((event) => event.type === "tool_result")
        .map((event) => [event.payload.callId, event]),
    );

    let paired = 0;
    for (const use of uses) {
      if (!results.has(use.payload.callId)) continue;
      paired += 1;
    }
    // Captured runs contain in-flight calls with no result yet, so require
    // near-complete pairing rather than exact equality.
    expect(paired).toBeGreaterThan(uses.length * 0.9);
  });
});

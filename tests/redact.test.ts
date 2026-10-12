import { describe, expect, it } from "vitest";
import {
  detectSensitiveAssignments,
  normalizeArkEvent,
  extractTodos,
  projectUiEvent,
  redactCredentials,
  redactPreview,
  redactText,
  summarizeToolArgs,
  summarizeToolResult,
  TODO_CONTENT_LIMIT,
  TOOL_ARGS_LIMIT,
  TOOL_PREVIEW_LIMIT,
  type UiEvent,
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
  /(?:^|[^A-Za-z0-9_-])(?:\\*")?(?:authorization|cookie|x-api-key|api[_-]?key|secret[_-]?access[_-]?key|access[_-]?key|secret[_-]?key|password|secret|token|credential|credentials|auth|session)(?:\\*")?(?![A-Za-z0-9_-])\s*[:=]\s*(?:\\*")?(?:bearer|basic)?\s*\S+/i,
];

const SECRET_ACCESS_ASSIGNMENT_KEYS = [
  "secretAccessKey",
  "secret_access_key",
  "secret-access-key",
] as const;

const SERIALIZED_ORACLE_ASSIGNMENT_KEYS = [
  "accessKey",
  "access_key",
  "access-key",
  "secretKey",
  "secret_key",
  "secret-key",
  ...SECRET_ACCESS_ASSIGNMENT_KEYS,
] as const;

const SENSITIVE_ASSIGNMENTS = [
  ["credential=plain-credential-value", "plain-credential-value"],
  ['{"credential": "json-credential-value"}', "json-credential-value"],
  ["credentials=plain-credentials-value", "plain-credentials-value"],
  ['{"credentials": "json-credentials-value"}', "json-credentials-value"],
  ["auth=plain-auth-value", "plain-auth-value"],
  ['{"auth": "json-auth-value"}', "json-auth-value"],
  ["session=plain-session-value", "plain-session-value"],
  ['{"session": "json-session-value"}', "json-session-value"],
] as const;

const NON_SENSITIVE_ASSIGNMENTS = [
  "session_count=42",
  '{"session_count": 42}',
  "auth_method=oauth",
  '{"auth_method": "oauth"}',
  "credential_policy=rotate",
  '{"credential_policy": "rotate"}',
  "credentials_required=false",
  '{"credentials_required": false}',
] as const;

const ROUND_ONE_SENSITIVE_ASSIGNMENTS = [
  [
    'payload="{\\"auth\\":\\"escaped-secret\\"}"',
    'payload="{\\"auth\\":\\"[redacted]\\"}"',
  ],
  ['credential="two word secret"', "credential: [redacted]"],
  ['{"session": 123456}', '{"session": [redacted]}'],
] as const;

const ROUND_ONE_LONGER_IDENTIFIERS = [
  "pre-auth=visible",
  "x-credential=visible",
  "auth_suffix=visible",
  "auth-suffix=visible",
  "session_suffix=visible",
  "session-suffix=visible",
] as const;

const ROUND_TWO_SECRET_ACCESS_ASSIGNMENTS = [
  ["secretAccessKey=camel-secret", "secretAccessKey: [redacted]"],
  [
    '{"secret_access_key": "snake-secret"}',
    '{"secret_access_key": "[redacted]"}',
  ],
  [
    'payload="{\\"secret-access-key\\":\\"kebab-secret\\"}"',
    'payload="{\\"secret-access-key\\":\\"[redacted]\\"}"',
  ],
] as const;

const ROUND_TWO_LONGER_IDENTIFIERS = [
  "secretAccessKeyId=visible",
  "secret_access_key_id=visible",
  "secret-access-key-id=visible",
  "pre-secretAccessKey=visible",
] as const;

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

  it("drops quoted and spaced spellings of denied keys from unknown tools", () => {
    const summary = summarizeToolArgs("upload_object", {
      bucket: "demo",
      access_key: "AKLTaccesskeyvalue0001",
      "Access Key": "AKLTspacedkeyvalue00002",
      region: "cn-beijing",
    });

    expect(summary).toBe("bucket=demo, region=cn-beijing");
    expect(summary).not.toContain("AKLT");
  });

  it("redacts JSON-quoted credential values in free text", () => {
    const redacted = redactCredentials(
      'request failed with {"token": "ghp_16digitsabcd1234"} and retry later',
    );

    expect(redacted).not.toContain("ghp_16digitsabcd1234");
    expect(redacted).toContain('"[redacted]"');
  });

  it("redacts JSON-quoted api_key and access_key spellings", () => {
    const redacted = redactCredentials(
      '{"api_key": "eyJhbGciOiJIUzI1NiJ9.payload.sig", "access_key": "PLAINSECRET123"}',
    );

    expect(redacted).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(redacted).not.toContain("PLAINSECRET123");
  });

  it("redacts bare access_key assignments in free text", () => {
    const redacted = redactCredentials("access_key=AKLTplainvalue00001; ok");

    expect(redacted).not.toContain("AKLTplainvalue00001");
    expect(redacted).toContain("access_key: [redacted]");
  });

  it("keeps ordinary JSON strings that only resemble credentials", () => {
    const redacted = redactCredentials('{"token_count": 42}');

    expect(redacted).toContain("42");
  });

  it.each(SENSITIVE_ASSIGNMENTS)(
    "redacts the exact sensitive assignment in %s",
    (input, value) => {
      const redacted = redactCredentials(input);

      expect(redacted).not.toContain(value);
      expect(redacted).toContain("[redacted]");
    },
  );

  it.each(NON_SENSITIVE_ASSIGNMENTS)(
    "preserves the longer identifier in %s",
    (input) => {
      expect(redactCredentials(input)).toBe(input);
    },
  );

  it.each(ROUND_ONE_SENSITIVE_ASSIGNMENTS)(
    "fully redacts the round-one sensitive assignment in %s",
    (input, expected) => {
      expect(redactCredentials(input)).toBe(expected);
    },
  );

  it.each(ROUND_ONE_LONGER_IDENTIFIERS)(
    "preserves the round-one longer identifier in %s",
    (input) => {
      expect(redactCredentials(input)).toBe(input);
    },
  );

  it.each(ROUND_TWO_SECRET_ACCESS_ASSIGNMENTS)(
    "fully redacts the secret-access assignment in %s",
    (input, expected) => {
      expect(redactCredentials(input)).toBe(expected);
    },
  );

  it.each(ROUND_TWO_LONGER_IDENTIFIERS)(
    "preserves the longer secret-access identifier in %s",
    (input) => {
      expect(redactCredentials(input)).toBe(input);
    },
  );

  it("exports the shared sensitive-assignment detector", () => {
    expect(detectSensitiveAssignments("auth=secret")).toHaveLength(1);
  });

  it.each(SECRET_ACCESS_ASSIGNMENT_KEYS)(
    "detects the exact %s assignment in the shared detector",
    (key) => {
      expect(detectSensitiveAssignments(`${key}=hidden`)).toHaveLength(1);
    },
  );

  it.each(["credential", "credentials", "auth", "session"])(
    "drops the exact %s key from unknown-tool arguments",
    (key) => {
      expect(
        summarizeToolArgs("custom_tool", {
          visible: "kept",
          [key]: "hidden",
        }),
      ).toBe("visible=kept");
    },
  );

  it.each(SECRET_ACCESS_ASSIGNMENT_KEYS)(
    "drops the exact %s key from unknown-tool arguments",
    (key) => {
      expect(
        summarizeToolArgs("custom_tool", {
          visible: "kept",
          [key]: "hidden",
        }),
      ).toBe("visible=kept");
    },
  );

  it.each([
    "secretAccessKeyId",
    "secret_access_key_id",
    "secret-access-key-id",
  ])("keeps the longer %s key in unknown-tool arguments", (key) => {
    expect(summarizeToolArgs("custom_tool", { [key]: "kept" })).toBe(
      `${key}=kept`,
    );
  });

  it.each([
    "session_count",
    "auth_method",
    "credential_policy",
    "credentials_required",
  ])("keeps the longer %s key in unknown-tool arguments", (key) => {
    expect(summarizeToolArgs("custom_tool", { [key]: "kept" })).toBe(
      `${key}=kept`,
    );
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

  it("reapplies current redaction and bounds to legacy public payloads", () => {
    const credential = "Authorization: Bearer legacy.token.value";
    const events: UiEvent[] = [
      {
        id: "message-legacy",
        sourceType: "agent.message",
        type: "message",
        createdAt: "2026-09-06T00:00:00.000Z",
        payload: {
          content: `message ${credential}`,
          rawToken: "must-drop",
        },
      },
      {
        id: "tool-legacy",
        sourceType: "agent.tool_use",
        type: "tool_use",
        createdAt: "2026-09-06T00:00:01.000Z",
        payload: {
          callId: "tool-legacy",
          name: "bash",
          argsSummary: `${credential} ${"x".repeat(1_000)}`,
          todos: [
            {
              content: `${credential} ${"y".repeat(1_000)}`,
              status: "pending",
            },
          ],
          input: { password: "must-drop" },
        },
      },
      {
        id: "result-legacy",
        sourceType: "agent.tool_result",
        type: "tool_result",
        createdAt: "2026-09-06T00:00:02.000Z",
        payload: {
          callId: "tool-legacy",
          status: "failed",
          preview: `${credential} ${"z".repeat(1_000)}`,
          errorCode: "failed",
          errorMessage: `${credential} ${"e".repeat(1_000)}`,
          content: "must-drop",
        },
      },
      {
        id: "error-legacy",
        sourceType: "session.error",
        type: "error",
        createdAt: "2026-09-06T00:00:03.000Z",
        payload: {
          code: "TEMPORARY",
          message: `${credential} /mnt/skills/internal.md`,
          recoverable: true,
          details: "must-drop",
        },
      },
    ];

    const projected = events.map(projectUiEvent);
    const wire = JSON.stringify(projected);
    expect(wire).not.toContain("legacy.token.value");
    expect(wire).not.toContain("must-drop");
    expect(wire).not.toContain("/mnt/skills/");
    expect(projected[1]!.payload.argsSummary).toHaveLength(
      TOOL_ARGS_LIMIT * 2 + 1,
    );
    expect(
      (projected[1]!.payload.todos as Array<{ content: string }>)[0]!.content,
    ).toHaveLength(TODO_CONTENT_LIMIT + 1);
    expect(projected[2]!.payload.preview).toHaveLength(TOOL_PREVIEW_LIMIT + 1);
    expect(projected[2]!.payload.errorMessage).toHaveLength(
      TOOL_ARGS_LIMIT * 2 + 1,
    );
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

  it.each(SERIALIZED_ORACLE_ASSIGNMENT_KEYS)(
    "scans serialized %s assignments in actual JSON.stringify output",
    (key) => {
      const secret = `oracle-${key}-secret`;
      const wire = JSON.stringify({
        content: JSON.stringify({ [key]: secret }),
      });

      expect(wire).toContain(`\\"${key}\\":\\"${secret}\\"`);
      expect(FORBIDDEN_PATTERNS.some((pattern) => pattern.test(wire))).toBe(
        true,
      );
    },
  );

  it("scans escaped assignments in actual JSON.stringify output", () => {
    const wire = JSON.stringify({
      content: '{"auth":"oracle-regression-secret"}',
    });

    expect(wire).toContain('\\"auth\\":\\"oracle-regression-secret\\"');
    expect(FORBIDDEN_PATTERNS.some((pattern) => pattern.test(wire))).toBe(true);
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

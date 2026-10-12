import { describe, expect, it } from "vitest";
import {
  capacity,
  cleanPlan,
  compactPlan,
  hashMemory,
  mergePlan,
  stableStringify,
  validateMemory,
} from "../packages/domain/src/memory-policy.js";

const entry = (path: string, content: string) => ({ id: path, path, content });

const SENSITIVE_ASSIGNMENTS = [
  "credential=plain-credential-value",
  '{"credential": "json-credential-value"}',
  "credentials=plain-credentials-value",
  '{"credentials": "json-credentials-value"}',
  "auth=plain-auth-value",
  '{"auth": "json-auth-value"}',
  "session=plain-session-value",
  '{"session": "json-session-value"}',
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
  'payload="{\\"auth\\":\\"escaped-secret\\"}"',
  'credential="two word secret"',
  '{"session": 123456}',
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
  "secretAccessKey=camel-secret",
  '{"secret_access_key": "snake-secret"}',
  'payload="{\\"secret-access-key\\":\\"kebab-secret\\"}"',
] as const;

const ROUND_TWO_LONGER_IDENTIFIERS = [
  "secretAccessKeyId=visible",
  "secret_access_key_id=visible",
  "secret-access-key-id=visible",
  "pre-secretAccessKey=visible",
] as const;

describe("personal memory policy", () => {
  it("measures UTF-8 limits and rejects traversal and credentials", () => {
    for (const path of [
      "/memories/no-extension",
      "/memories/a%.md",
      "/memories/a?.md",
      "/memories/a\n.md",
      `/memories/${"中".repeat(400)}.md`,
    ])
      expect(() => validateMemory(path, "safe")).toThrow();
    expect(() => validateMemory("/memories/a.md", "\ud800")).toThrow();
    expect(() =>
      validateMemory("/memories/profile.md", "中".repeat(34134)),
    ).toThrow();
    expect(() => validateMemory("/memories/../secret", "hi")).toThrow();
    expect(() => validateMemory("/sessions/legacy.md", "hi")).toThrow();
    expect(() =>
      validateMemory("/procedures/conventions.md", "hi"),
    ).not.toThrow();
    expect(() => validateMemory("/episodes/handoff.md", "hi")).not.toThrow();
    expect(() =>
      validateMemory("/memories/profile.md", "ARK_API_KEY=secret"),
    ).toThrow();
    // JSON-quoted and spaced spellings must fail the same way the event
    // redaction rules treat them: the write path and display path agree.
    expect(() =>
      validateMemory(
        "/memories/profile.md",
        'note {"token": "ghp_16digitsabcd1234"} done',
      ),
    ).toThrow();
    expect(() =>
      validateMemory(
        "/memories/profile.md",
        '{"access_key": "AKLTaccesskeyvalue0001"}',
      ),
    ).toThrow();
    expect(() =>
      validateMemory("/memories/profile.md", "Authorization: Bearer eyJhbGci"),
    ).toThrow();
    expect(() =>
      validateMemory("/memories/profile.md", "token_count reached 42"),
    ).not.toThrow();
    expect(() => validateMemory("/memories/profile.md", "中文")).not.toThrow();
  });
  it.each(SENSITIVE_ASSIGNMENTS)(
    "rejects the exact sensitive assignment in %s",
    (content) => {
      expect(() =>
        validateMemory("/memories/profile.md", content),
      ).toThrowError("凭证和临时签名链接不能保存为长期记忆");
    },
  );
  it.each(NON_SENSITIVE_ASSIGNMENTS)(
    "preserves the longer identifier in %s",
    (content) => {
      expect(() =>
        validateMemory("/memories/profile.md", content),
      ).not.toThrow();
    },
  );
  it.each(ROUND_ONE_SENSITIVE_ASSIGNMENTS)(
    "rejects the round-one sensitive assignment in %s",
    (content) => {
      expect(() =>
        validateMemory("/memories/profile.md", content),
      ).toThrowError("凭证和临时签名链接不能保存为长期记忆");
    },
  );
  it.each(ROUND_ONE_LONGER_IDENTIFIERS)(
    "preserves the round-one longer identifier in %s",
    (content) => {
      expect(() =>
        validateMemory("/memories/profile.md", content),
      ).not.toThrow();
    },
  );
  it.each(ROUND_TWO_SECRET_ACCESS_ASSIGNMENTS)(
    "rejects the secret-access assignment in %s",
    (content) => {
      expect(() =>
        validateMemory("/memories/profile.md", content),
      ).toThrowError("凭证和临时签名链接不能保存为长期记忆");
    },
  );
  it.each(ROUND_TWO_LONGER_IDENTIFIERS)(
    "preserves the longer secret-access identifier in %s",
    (content) => {
      expect(() =>
        validateMemory("/memories/profile.md", content),
      ).not.toThrow();
    },
  );
  it("has independent watermarks without inventing a total byte limit", () => {
    expect(
      capacity(
        Array.from({ length: 1600 }, (_, i) => entry(`/memories/${i}.md`, "x")),
      ).level,
    ).toBe("high");
    expect(capacity([entry("/memories/a.md", "x".repeat(81920))]).level).toBe(
      "high",
    );
    expect(capacity([entry("/memories/a.md", "x")]).byteRatio).toBeNull();
    expect(capacity([entry("/memories/a.md", "x".repeat(80))], 100).level).toBe(
      "high",
    );
  });
  it("preserves live changes, deletions and candidate omissions", () => {
    const base = [
      entry("/memories/a.md", "old"),
      entry("/memories/b.md", "keep"),
      entry("/memories/c.md", "deleted"),
    ];
    const candidate = [
      entry("/memories/a.md", "dream"),
      entry("/memories/c.md", "restore"),
      entry("/memories/d.md", "new"),
    ];
    const live = [
      entry("/memories/a.md", "user correction"),
      entry("/memories/b.md", "keep"),
      entry("/memories/e.md", "live addition"),
    ];
    expect(mergePlan(base, candidate, live, [], []).map((s) => s.path)).toEqual(
      ["/memories/d.md"],
    );
  });
  it("does not trust protected or revoked candidate paths", () => {
    const base = [entry("/memories/a.md", "protected")];
    expect(
      mergePlan(
        base,
        [
          entry("/memories/a.md", "short"),
          entry("/memories/deleted.md", "restore"),
        ],
        base,
        ["/memories/a.md"],
        ["/memories/deleted.md"],
      ),
    ).toEqual([]);
  });
  it("only removes exact duplicates and empty entries, preserving protected paths", () => {
    const entries = [
      entry("/memories/a.md", "same"),
      entry("/memories/b.md", "same"),
      entry("/memories/c.md", ""),
      entry("/memories/d.md", ""),
    ];
    expect(cleanPlan(entries, ["/memories/d.md"]).map((s) => s.path)).toEqual([
      "/memories/b.md",
      "/memories/c.md",
    ]);
  });
  it("never writes a plan whose peak exceeds the entry limit", () => {
    const full = Array.from({ length: 2000 }, (_, i) =>
      entry(`/memories/${i}.md`, `${i}`),
    );
    expect(() =>
      mergePlan(
        full,
        [...full, entry("/memories/new.md", "new")],
        full,
        [],
        [],
      ),
    ).toThrow();
  });
  it("packs related events by updating a survivor before deleting sources, even at full capacity", () => {
    const entries = Array.from({ length: 2000 }, (_, i) =>
      entry(`/episodes/digest/2026/10/${i}.md`, `factId: ${i}\n决定 ${i}`),
    );
    const outside = entry("/memories/profile.md", "fact");
    const plan = compactPlan([...entries, outside], [entries[0]!.path]);
    expect(plan[0]?.kind).toBe("put");
    const summary = plan[0]!.content!;
    expect(summary).toContain("factId: 1");
    expect(plan[1]?.kind).toBe("delete");
    expect(plan.some((s) => s.path === entries[0]!.path)).toBe(false);
    expect(plan.some((s) => s.path === outside.path)).toBe(false);
    expect(plan.filter((s) => s.kind === "delete").length).toBeGreaterThan(800);
    expect(
      plan
        .filter((s) => s.kind === "put")
        .every((s) => Buffer.byteLength(s.content!, "utf8") <= 61440),
    ).toBe(true);
  });
  it("fingerprints semantically identical payloads despite serializer key order", () => {
    // The upstream events API re-serializes tool-call input maps per request:
    // the same logical event arrives with its object keys in a different
    // order. The fingerprint must not move.
    const first = {
      id: "call_1",
      type: "agent.tool_use",
      data: {
        input: { description: "Check current date", command: "date '+%Y'" },
        tool_permission: "allow",
      },
    };
    const second = {
      data: {
        tool_permission: "allow",
        input: { command: "date '+%Y'", description: "Check current date" },
      },
      type: "agent.tool_use",
      id: "call_1",
    };
    expect(stableStringify(first)).toBe(stableStringify(second));
    expect(hashMemory(stableStringify(first))).toBe(
      hashMemory(stableStringify(second)),
    );
    // Array order stays significant, and primitives pass through JSON.
    expect(stableStringify([1, "a", null])).toBe(
      JSON.stringify([1, "a", null]),
    );
    expect(stableStringify({ list: ["b", "a"] })).not.toBe(
      stableStringify({ list: ["a", "b"] }),
    );
  });
});

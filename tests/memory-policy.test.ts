import { describe, expect, it } from "vitest";
import {
  capacity,
  cleanPlan,
  compactPlan,
  mergePlan,
  validateMemory,
} from "../packages/domain/src/memory-policy.js";

const entry = (path: string, content: string) => ({ id: path, path, content });

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
    expect(() => validateMemory("/memories/profile.md", "中文")).not.toThrow();
  });
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
});

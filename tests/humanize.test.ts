import { describe, expect, it } from "vitest";
import { normalizeArkEvent } from "../packages/contracts/src/index.js";
import { foldEvents } from "../apps/web/src/timeline/fold.js";
import { humanizeActivity, humanizeTool } from "../apps/web/src/humanize.js";
import type { ToolItem } from "../apps/web/src/timeline/items.js";
import {
  arkFixtures,
  loadArkFixture,
  type ArkFixtureName,
} from "./support/ark-fixtures.js";

function tool(partial: Partial<ToolItem> & { name?: string }): ToolItem {
  return {
    kind: "tool",
    id: partial.id ?? "call_1",
    ts: "2026-09-07T08:00:00.000Z",
    status: partial.status ?? "ok",
    ...partial,
  };
}

function line(item: ToolItem): string {
  const { pre, obj, post } = humanizeTool(item);
  return [pre, obj, post].filter((part) => part !== undefined).join(" ");
}

describe("humanizeTool", () => {
  it("reads a file by its basename rather than its sandbox path", () => {
    expect(
      line(tool({ name: "read", argsSummary: "/workspace/reports/q3.md" })),
    ).toBe("Read q3.md");
  });

  it("keeps the present tense while the call is in flight", () => {
    expect(
      line(
        tool({
          name: "read",
          status: "running",
          argsSummary: "/workspace/a.md",
        }),
      ),
    ).toBe("Reading a.md");
  });

  it("reports a failure as a failure", () => {
    expect(
      line(
        tool({
          name: "read",
          status: "failed",
          argsSummary: "/workspace/a.md",
        }),
      ),
    ).toBe("Could not read a.md");
  });

  it.each([
    ["bash", "Ran a command 下载价格快照并校验JSON"],
    ["write", "Wrote report.md"],
    ["edit", "Edited report.md"],
    ["glob", "Found files matching **/*.ts"],
    ["grep", "Searched for TODO"],
  ])("phrases %s from the real argument shape", (name, expected) => {
    const argsSummary =
      name === "bash"
        ? "下载价格快照并校验JSON"
        : name === "glob"
          ? "**/*.ts"
          : name === "grep"
            ? "TODO"
            : "/workspace/report.md";
    expect(line(tool({ name, argsSummary }))).toBe(expected);
  });

  it("reduces a fetched URL to its host", () => {
    expect(
      line(
        tool({
          name: "web_fetch",
          argsSummary: "https://ark.example.com/v3/models?x=1",
        }),
      ),
    ).toBe("Fetched ark.example.com");
  });

  it("falls back to the whole string when a URL does not parse", () => {
    expect(line(tool({ name: "web_fetch", argsSummary: "not a url" }))).toBe(
      "Fetched not a url",
    );
  });

  it("leads with the first web search query and counts the rest", () => {
    expect(
      line(tool({ name: "web_search", argsSummary: "doubao pricing" })),
    ).toBe("Searched the web for doubao pricing");
    expect(
      line(
        tool({
          name: "web_search",
          argsSummary: "doubao pricing · ark pricing · volcengine pricing",
        }),
      ),
    ).toBe("Searched the web for doubao pricing +2 more");
  });

  it("summarises the task list by progress and current step", () => {
    expect(
      line(
        tool({
          name: "todo_write",
          todos: [
            { content: "Fetch prices", status: "completed" },
            { content: "Write the comparison", status: "in_progress" },
            { content: "Review", status: "pending" },
          ],
        }),
      ),
    ).toBe("Updated the task list 1/3 done · Write the comparison");
  });

  it("still reads correctly when a tool reports no arguments", () => {
    expect(line(tool({ name: "read" }))).toBe("Read");
    expect(line(tool({ name: "todo_write" }))).toBe("Updated the task list");
  });

  it("names an MCP or custom tool instead of inventing a verb for it", () => {
    expect(
      line(tool({ name: "list_models", argsSummary: "page_size=10" })),
    ).toBe("Used list_models page_size=10");
    expect(
      line(
        tool({
          name: "list_models",
          status: "running",
          argsSummary: "page_size=10",
        }),
      ),
    ).toBe("Using list_models page_size=10");
    expect(
      line(
        tool({
          name: "list_models",
          status: "failed",
          argsSummary: "page_size=10",
        }),
      ),
    ).toBe("Failed using list_models page_size=10");
  });

  it("degrades to a bare activity line when the name is missing", () => {
    expect(line(tool({ name: undefined, status: "running" }))).toBe("Working");
    expect(line(tool({ name: undefined }))).toBe("Worked");
  });

  it("describes the latest call in a collapsed turn", () => {
    const items = [
      tool({ id: "a", name: "read", argsSummary: "/workspace/one.md" }),
      tool({
        id: "b",
        name: "web_search",
        status: "running",
        argsSummary: "pricing",
      }),
    ];

    expect(humanizeActivity(items)).toBe("Searching the web for pricing");
    expect(humanizeActivity([])).toBeUndefined();
  });
});

describe("humanizeTool over captured Ark traffic", () => {
  const fixtureNames = Object.keys(arkFixtures) as ArkFixtureName[];
  const state = fixtureNames
    .flatMap((name) => loadArkFixture(name))
    .map((event) => normalizeArkEvent(event))
    .reduce((current, event) => foldEvents([event], current), foldEvents([]));
  const toolItems = state.items.filter(
    (item): item is ToolItem => item.kind === "tool",
  );

  it("produces a non-empty line for every real tool call", () => {
    expect(toolItems.length).toBeGreaterThan(40);
    for (const item of toolItems) {
      const rendered = line(item);
      expect(rendered.length, rendered).toBeGreaterThan(0);
      expect(rendered).not.toContain("undefined");
    }
  });

  it("never widens what the browser is allowed to see", () => {
    const rendered = toolItems.map((item) => line(item)).join("\n");

    expect(rendered).not.toContain("/mnt/skills/");
    expect(rendered).not.toMatch(/\b(?:sk|ark|ak)-[A-Za-z0-9_-]{16,}\b/i);
    expect(rendered).not.toContain("X-Tos-Signature");
  });
});

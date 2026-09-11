import { describe, expect, it } from "vitest";
import { buildBlocks } from "../apps/web/src/timeline/blocks.js";
import type { Item } from "../apps/web/src/timeline/items.js";
import { messageRoles } from "../apps/web/src/timeline/messageRole.js";
import type { SessionStatus } from "../apps/web/src/api.js";

function user(id: string, text = "do it"): Item {
  return { kind: "user", id, ts: "2026-09-07T08:00:00.000Z", text };
}

function assistant(id: string, text: string): Item {
  return { kind: "assistant", id, ts: "2026-09-07T08:00:00.000Z", text };
}

function tool(id: string, status: "running" | "ok" | "failed" = "ok"): Item {
  return {
    kind: "tool",
    id,
    ts: "2026-09-07T08:00:00.000Z",
    name: "read",
    status,
  };
}

function thinking(id: string): Item {
  return { kind: "thinking", id, ts: "2026-09-07T08:00:00.000Z" };
}

function notice(id: string, tone: "info" | "warn" | "danger" = "warn"): Item {
  return {
    kind: "notice",
    id,
    ts: "2026-09-07T08:00:00.000Z",
    tone,
    text: "something happened",
    retriable: tone === "warn",
  };
}

function blocksFor(
  items: readonly Item[],
  status: SessionStatus | undefined = "idle",
) {
  return buildBlocks(items, messageRoles(items, status), status);
}

describe("buildBlocks", () => {
  it("keeps user messages and notices as standalone blocks", () => {
    const blocks = blocksFor([user("u1"), notice("n1", "danger")]);

    expect(blocks.map((block) => block.kind)).toEqual(["user", "notice"]);
    expect(blocks[0]?.kind === "user" && blocks[0].item.id).toBe("u1");
    expect(blocks[1]?.kind === "notice" && blocks[1].item.tone).toBe("danger");
  });

  it("lifts a settled turn's trailing message out as the answer", () => {
    const blocks = blocksFor([
      user("u1"),
      thinking("t1"),
      tool("c1"),
      assistant("a1", "Here is the result"),
    ]);

    expect(blocks).toHaveLength(2);
    const turn = blocks[1];
    expect(turn?.kind).toBe("turn");
    if (turn?.kind !== "turn") throw new Error("unreachable");
    expect(turn.answer?.id).toBe("a1");
    expect(turn.items.map((item) => item.id)).toEqual(["t1", "c1"]);
    expect(turn.stepCount).toBe(1);
    expect(turn.live).toBe(false);
  });

  it("keeps an in-flight turn's trailing message inside the group", () => {
    const blocks = blocksFor(
      [user("u1"), tool("c1"), assistant("a1", "Checking")],
      "running",
    );
    const turn = blocks[1];
    if (turn?.kind !== "turn") throw new Error("unreachable");

    expect(turn.answer).toBeUndefined();
    expect(turn.items.map((item) => item.id)).toEqual(["c1", "a1"]);
    expect(turn.live).toBe(true);
  });

  it("marks only the trailing turn of a running Session as live", () => {
    const blocks = blocksFor(
      [
        user("u1"),
        assistant("a1", "First answer"),
        user("u2"),
        tool("c1", "running"),
      ],
      "running",
    );
    const turns = blocks.filter((block) => block.kind === "turn");

    expect(turns).toHaveLength(2);
    expect(turns[0]?.kind === "turn" && turns[0].live).toBe(false);
    expect(turns[1]?.kind === "turn" && turns[1].live).toBe(true);
  });

  it("starts a new turn after a notice", () => {
    const blocks = blocksFor([
      user("u1"),
      assistant("a1", "Working"),
      notice("n1"),
      assistant("a2", "Resumed"),
    ]);

    expect(blocks.map((block) => block.kind)).toEqual([
      "user",
      "turn",
      "notice",
      "turn",
    ]);
  });

  it("counts only tool calls as steps", () => {
    const blocks = blocksFor([
      user("u1"),
      thinking("t1"),
      tool("c1"),
      tool("c2"),
      assistant("a1", "one"),
      tool("c3"),
      assistant("a2", "done"),
    ]);
    const turn = blocks[1];
    if (turn?.kind !== "turn") throw new Error("unreachable");

    // The answer is lifted out, so it is not counted as a step.
    expect(turn.stepCount).toBe(3);
    expect(turn.answer?.id).toBe("a2");
  });

  it("produces no blocks for an empty timeline", () => {
    expect(blocksFor([])).toEqual([]);
  });

  it("gives every block a stable key", () => {
    const blocks = blocksFor([user("u1"), tool("c1"), assistant("a1", "x")]);
    const ids = blocks.map((block) => block.id);

    expect(new Set(ids).size).toBe(ids.length);
  });
});

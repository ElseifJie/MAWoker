import { describe, expect, it } from "vitest";
import { normalizeArkEvent } from "../packages/contracts/src/index.js";
import { foldEvents } from "../apps/web/src/timeline/fold.js";
import type { Item } from "../apps/web/src/timeline/items.js";
import {
  ANSWER_MIN_WEIGHT,
  messageRoles,
  textWeight,
} from "../apps/web/src/timeline/messageRole.js";
import { loadArkFixture } from "./support/ark-fixtures.js";
import type { SessionStatus } from "../apps/web/src/api.js";

function assistant(id: string, text: string): Item {
  return { kind: "assistant", id, ts: "2026-09-07T08:00:00.000Z", text };
}

function tool(id: string): Item {
  return {
    kind: "tool",
    id,
    ts: "2026-09-07T08:00:00.000Z",
    name: "read",
    status: "ok",
  };
}

function thinking(id: string): Item {
  return { kind: "thinking", id, ts: "2026-09-07T08:00:00.000Z" };
}

function user(id: string, text = "do it"): Item {
  return { kind: "user", id, ts: "2026-09-07T08:00:00.000Z", text };
}

function notice(id: string): Item {
  return {
    kind: "notice",
    id,
    ts: "2026-09-07T08:00:00.000Z",
    tone: "warn",
    text: "something happened",
  };
}

function rolesFor(
  items: readonly Item[],
  status: SessionStatus | undefined,
): Record<string, string> {
  const roles = messageRoles(items, status);
  return Object.fromEntries(
    items
      .filter((item) => item.kind === "assistant")
      .map((item) => [item.id, roles.get(item.id)]),
  );
}

const longAnswer = "结论".repeat(ANSWER_MIN_WEIGHT);

describe("text weight", () => {
  it("counts CJK per character and Latin per word", () => {
    expect(textWeight("这是一段中文回答")).toBe(8);
    expect(textWeight("hello world foo")).toBe(3);
    expect(textWeight("混合 mixed 文本 text")).toBe(6);
    expect(textWeight("")).toBe(0);
  });

  it("does not file a substantial Chinese answer as narration", () => {
    expect(textWeight(longAnswer)).toBeGreaterThanOrEqual(ANSWER_MIN_WEIGHT);
  });
});

describe("message role classification", () => {
  it("treats a lone message in a closed turn as the answer", () => {
    expect(rolesFor([user("u1"), assistant("a1", "Done")], "idle")).toEqual({
      a1: "answer",
    });
  });

  it("treats a message followed by tool activity as narration", () => {
    expect(
      rolesFor(
        [
          user("u1"),
          assistant("a1", "Let me look"),
          tool("t1"),
          assistant("a2", "Found it"),
        ],
        "idle",
      ),
    ).toEqual({ a1: "narration", a2: "answer" });
  });

  it("files every message but the turn's last as narration", () => {
    const items: Item[] = [
      user("u1"),
      assistant("a1", "one"),
      thinking("th1"),
      assistant("a2", "two"),
      tool("t1"),
      assistant("a3", "three"),
    ];

    expect(rolesFor(items, "idle")).toEqual({
      a1: "narration",
      a2: "narration",
      a3: "answer",
    });
  });

  it("classifies the captured twelve-message turn as eleven narrations and one answer", () => {
    const events = loadArkFixture("multiMessageTurn").map((event) =>
      normalizeArkEvent(event),
    );
    const state = foldEvents(events);
    const assistants = state.items.filter((item) => item.kind === "assistant");
    const roles = messageRoles(state.items, state.status);

    expect(assistants).toHaveLength(12);
    expect(
      assistants.filter((item) => roles.get(item.id) === "answer"),
    ).toHaveLength(1);
    expect(
      assistants.filter((item) => roles.get(item.id) === "narration"),
    ).toHaveLength(11);
    // The answer is the turn's last message.
    expect(roles.get(assistants[assistants.length - 1]!.id)).toBe("answer");
  });

  it("gives every assistant message a role", () => {
    const items: Item[] = [
      user("u1"),
      assistant("a1", "one"),
      notice("n1"),
      assistant("a2", "two"),
      assistant("a3", "three"),
    ];
    const roles = messageRoles(items, "running");

    for (const item of items) {
      if (item.kind !== "assistant") continue;
      expect(roles.has(item.id), item.id).toBe(true);
    }
  });

  it("closes a run at a notice so the message before it settles", () => {
    expect(
      rolesFor(
        [assistant("a1", "short"), notice("n1"), assistant("a2", "short")],
        "running",
      ),
    ).toEqual({ a1: "answer", a2: "narration" });
  });

  it("holds a short trailing message as narration only while the turn is in flight", () => {
    const items = [user("u1"), tool("t1"), assistant("a1", "Checking now")];

    expect(rolesFor(items, "running")).toEqual({ a1: "narration" });
    expect(rolesFor(items, "rescheduled")).toEqual({ a1: "narration" });
    expect(rolesFor(items, "idle")).toEqual({ a1: "answer" });
    expect(rolesFor(items, "terminated")).toEqual({ a1: "answer" });
    expect(rolesFor(items, undefined)).toEqual({ a1: "answer" });
  });

  it("promotes a substantial trailing message even mid-turn", () => {
    const items = [user("u1"), assistant("a1", longAnswer)];

    expect(rolesFor(items, "running")).toEqual({ a1: "answer" });
  });

  it("never swallows text: narration converges to answer as the turn closes", () => {
    const items = [user("u1"), assistant("a1", "Checking now")];
    const whileRunning = messageRoles(items, "running");
    const onceIdle = messageRoles(items, "idle");

    expect(whileRunning.get("a1")).toBe("narration");
    expect(onceIdle.get("a1")).toBe("answer");
    // The message is present in both classifications — only its placement moves.
    expect(whileRunning.has("a1")).toBe(true);
    expect(onceIdle.has("a1")).toBe(true);
  });

  it("keeps a turn with no trailing message entirely narration", () => {
    expect(
      rolesFor([user("u1"), assistant("a1", "Working"), tool("t1")], "running"),
    ).toEqual({ a1: "narration" });
  });
});

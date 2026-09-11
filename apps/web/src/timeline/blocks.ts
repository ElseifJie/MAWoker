import type { SessionStatus } from "../api.js";
import type { AssistantItem, Item, NoticeItem, UserItem } from "./items.js";
import { turnSegments, type MessageRole } from "./messageRole.js";

export type TranscriptBlock =
  | { kind: "user"; id: string; item: UserItem }
  | { kind: "notice"; id: string; item: NoticeItem }
  | {
      kind: "turn";
      id: string;
      /** Narration, tool calls and thinking — what the collapsed group shows. */
      items: Item[];
      answer?: AssistantItem;
      /** The trailing turn of a Session that is still working. */
      live: boolean;
      stepCount: number;
    };

function breakpointBlock(item: Item): TranscriptBlock | undefined {
  if (item.kind === "user") return { kind: "user", id: item.id, item };
  if (item.kind === "notice") return { kind: "notice", id: item.id, item };
  return undefined;
}

/**
 * Groups folded items into what the transcript renders: standalone user
 * messages and notices, plus one collapsible turn per run of Agent activity.
 *
 * The turn's trailing message is lifted out as the answer so it reads as a
 * reply rather than as another step, and only when `messageRoles` has settled it
 * as an answer — while the Session is still working it stays inside the group.
 */
export function buildBlocks(
  items: readonly Item[],
  roles: ReadonlyMap<string, MessageRole>,
  status: SessionStatus | undefined,
): TranscriptBlock[] {
  const inFlight = status === "running" || status === "rescheduled";
  const blocks: TranscriptBlock[] = [];
  let cursor = 0;

  const flushBreakpoints = (until: number) => {
    while (cursor < until) {
      const item = items[cursor];
      const block = item ? breakpointBlock(item) : undefined;
      if (item && block) blocks.push(block);
      cursor += 1;
    }
  };

  for (const { start, end } of turnSegments(items)) {
    flushBreakpoints(start);
    const segment = items.slice(start, end);
    const trailing = segment.at(-1);
    const answer =
      trailing &&
      trailing.kind === "assistant" &&
      roles.get(trailing.id) === "answer"
        ? trailing
        : undefined;
    const body = answer ? segment.slice(0, -1) : segment;
    blocks.push({
      kind: "turn",
      id: `turn-${start}`,
      items: body,
      ...(answer === undefined ? {} : { answer }),
      live: end === items.length && inFlight,
      stepCount: body.filter((item) => item.kind === "tool").length,
    });
    cursor = end;
  }
  flushBreakpoints(items.length);

  return blocks;
}

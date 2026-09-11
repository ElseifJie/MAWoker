import type { SessionStatus } from "../api.js";
import type { Item } from "./items.js";

export type MessageRole = "answer" | "narration";

/**
 * Below this weight an in-flight trailing message is provisionally narration.
 * Ark sends whole messages rather than token deltas, so there is nothing to
 * gate: this only decides placement, and it converges as later events arrive.
 */
export const ANSWER_MIN_WEIGHT = 40;

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;

/**
 * Counts CJK characters plus whitespace-separated Latin words. A plain word
 * count would score a 200-character Chinese answer as one word and file it as
 * narration, so CJK is counted per character.
 */
export function textWeight(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0;
  const latin = text
    .replace(CJK, " ")
    .split(/\s+/)
    .filter((token) => token.length > 0).length;
  return cjk + latin;
}

function isBreakpoint(item: Item): boolean {
  return item.kind === "user" || item.kind === "notice";
}

/**
 * A turn is the maximal run of assistant/tool/thinking items between two
 * breakpoints (a user message or a notice). Only the final segment can still be
 * in flight; a breakpoint after a segment settles it.
 */
export function turnSegments(
  items: readonly Item[],
): { start: number; end: number }[] {
  const segments: { start: number; end: number }[] = [];
  let start = -1;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item) continue;
    if (isBreakpoint(item)) {
      if (start >= 0) segments.push({ start, end: index });
      start = -1;
      continue;
    }
    if (start < 0) start = index;
  }
  if (start >= 0) segments.push({ start, end: items.length });
  return segments;
}

/**
 * Classifies every assistant message as its turn's answer or as narration.
 *
 * Within a closed turn the trailing assistant message is the answer and
 * everything before it is narration — Ark emits several `agent.message` events
 * per turn (one captured turn had twelve), so this cannot be judged from a
 * single message.
 *
 * The final message of the trailing turn is settled by turn state: once the
 * Session stops running the turn is closed and that message is the answer. While
 * it is still in flight the message is judged by weight and re-classified as
 * later events arrive. Narration is never dropped — the transcript renders it in
 * the turn header — so text is not swallowed while the Session converges.
 */
export function messageRoles(
  items: readonly Item[],
  status: SessionStatus | undefined,
): Map<string, MessageRole> {
  const roles = new Map<string, MessageRole>();
  const inFlight = status === "running" || status === "rescheduled";

  for (const { start, end } of turnSegments(items)) {
    const closed = end < items.length || !inFlight;
    for (let cursor = start; cursor < end; cursor += 1) {
      const item = items[cursor];
      if (item?.kind !== "assistant") continue;
      if (cursor !== end - 1) {
        roles.set(item.id, "narration");
        continue;
      }
      const settled = closed || textWeight(item.text) >= ANSWER_MIN_WEIGHT;
      roles.set(item.id, settled ? "answer" : "narration");
    }
  }

  return roles;
}

export function isNarration(
  roles: ReadonlyMap<string, MessageRole>,
  id: string,
): boolean {
  return roles.get(id) === "narration";
}

import type { SessionTurn } from "./api.js";
import type { TranscriptBlock } from "./timeline/blocks.js";
import type { Item } from "./timeline/items.js";

/** A timestamp or repeated answer text alone cannot identify a saved round. */
export function hasSavedTurnAnswer(
  turn: SessionTurn,
  blocks: readonly TranscriptBlock[],
  items: readonly Item[],
): boolean {
  if (!turn.inputEventId) return false;
  const inputIndex = items.findIndex(
    (item) => item.kind === "user" && item.id === turn.inputEventId,
  );
  if (inputIndex < 0) return false;
  const started = Date.parse(turn.startedAt ?? items[inputIndex]!.ts);
  const ended = Date.parse(turn.endedAt);
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return false;
  const boundaryIndex = turn.boundaryEventId
    ? items.findIndex((item) => item.id === turn.boundaryEventId)
    : -1;
  let inputId: string | undefined;
  for (const block of blocks) {
    if (block.kind === "user") inputId = block.item.id;
    if (block.kind !== "turn" || inputId !== turn.inputEventId || !block.answer)
      continue;
    const answer = block.answer;
    const answerIndex = items.findIndex((item) => item.id === answer.id);
    const answered = Date.parse(answer.ts);
    if (
      answerIndex <= inputIndex ||
      answered < started ||
      answered > ended ||
      !Number.isFinite(answered) ||
      (boundaryIndex >= 0 && answerIndex > boundaryIndex)
    )
      continue;
    // The service stores at most 4,000 characters of the final message.
    if (
      turn.summary.trim() &&
      answer.text.trim().slice(0, 4000).trim() === turn.summary.trim()
    )
      return true;
  }
  return false;
}

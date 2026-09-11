import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { humanizeActivity } from "../humanize.js";
import type { Item, ToolItem } from "../timeline/items.js";
import { Markdown } from "./Markdown.js";
import { ThinkingBlock } from "./ThinkingBlock.js";
import { ToolRow } from "./ToolRow.js";

function pluralize(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/**
 * One turn of Agent activity. The summary is the live surface: while the Session
 * is working it names what is happening now, so progress is visible without the
 * user opening anything. Ark sends whole events rather than token deltas, so
 * nothing here animates text into existence — that would misrepresent how the
 * output arrived.
 */
export function TurnGroup({
  items,
  live,
  stepCount,
}: {
  items: readonly Item[];
  live: boolean;
  stepCount: number;
}) {
  // A running turn is open so the work can be watched, and collapses once it
  // settles. The state is owned here rather than bound straight to `live`, so
  // the user can still collapse a running turn or reopen a settled one.
  const [open, setOpen] = useState(live);
  useEffect(() => {
    if (!live) setOpen(false);
  }, [live]);

  if (items.length === 0) return null;

  // While the turn is in flight the classification of its trailing message is
  // provisional, so it is surfaced here rather than folded away inside a
  // collapsed body. It is lifted out of the body so it is not rendered twice.
  const trailing = items.at(-1);
  const narration =
    live && trailing?.kind === "assistant" ? trailing : undefined;
  const body = narration ? items.slice(0, -1) : items;

  const tools = body.filter((item): item is ToolItem => item.kind === "tool");
  const headline =
    narration?.text ?? (live ? humanizeActivity(tools) : undefined);
  const label =
    stepCount > 0
      ? live
        ? `Running · ${pluralize(stepCount, "step")}`
        : pluralize(stepCount, "step")
      : live
        ? "Running"
        : "Agent activity";

  return (
    <details
      className="turn-group"
      data-live={live || undefined}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <ChevronRight
          size={14}
          aria-hidden="true"
          className="turn-group__chevron"
        />
        <span className="turn-group__label">{label}</span>
        {headline ? <span className="turn-group__live">{headline}</span> : null}
      </summary>
      <div className="turn-group__body">
        {body.map((item, index) => {
          if (item.kind === "thinking") {
            // Collapse a run of thinking events into one indicator.
            const previous = body[index - 1];
            if (previous?.kind === "thinking") return null;
            let count = 1;
            for (
              let cursor = index + 1;
              cursor < body.length && body[cursor]?.kind === "thinking";
              cursor += 1
            ) {
              count += 1;
            }
            return (
              <ThinkingBlock key={item.id} eventId={item.id} count={count} />
            );
          }
          if (item.kind === "tool") {
            return <ToolRow key={item.id} item={item} />;
          }
          if (item.kind === "assistant") {
            return (
              <div
                key={item.id}
                className="turn-group__narration"
                data-event-id={item.id}
              >
                <Markdown artifactLinks>{item.text}</Markdown>
              </div>
            );
          }
          return null;
        })}
      </div>
    </details>
  );
}

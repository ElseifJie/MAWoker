import { AlertCircle, Bot, Info, UserRound } from "lucide-react";
import type { TranscriptBlock } from "../timeline/blocks.js";
import { Markdown } from "./Markdown.js";
import { TurnGroup } from "./TurnGroup.js";

const noticeLabels = {
  info: "已安排重试",
  warn: "可恢复的异常",
  danger: "任务已停止",
} as const;

export function UserMessage({ text }: { text: string }) {
  return (
    <>
      <UserRound size={17} aria-hidden="true" />
      <div className="transcript__bubble">
        <Markdown artifactLinks>{text}</Markdown>
      </div>
    </>
  );
}

/**
 * Renders the folded timeline as turns rather than as a flat event list.
 *
 * Every row keeps its originating `event.id`, so reconnection behaviour — no
 * event lost, none duplicated — stays observable in the DOM even though a tool
 * call and its result now share one row.
 */
export function Transcript({
  blocks,
  showEmptyState = true,
}: {
  blocks: readonly TranscriptBlock[];
  showEmptyState?: boolean;
}) {
  if (blocks.length === 0) {
    if (!showEmptyState) return null;
    return (
      <div className="timeline-empty">
        <Bot size={20} aria-hidden="true" />
        <p>等待任务开始…</p>
      </div>
    );
  }

  return (
    <ol className="transcript">
      {blocks.map((block) => {
        if (block.kind === "user") {
          return (
            <li
              key={block.id}
              className="transcript__row transcript__row--user"
              data-event-id={block.item.id}
            >
              <UserMessage text={block.item.text} />
            </li>
          );
        }

        if (block.kind === "notice") {
          const notice = block.item;
          return (
            <li
              key={block.id}
              className={`transcript__row transcript__row--notice notice--${notice.tone}${
                notice.retriable ? " is-retriable" : ""
              }`}
              data-event-id={notice.id}
            >
              {notice.tone === "info" ? (
                <Info size={17} aria-hidden="true" />
              ) : (
                <AlertCircle size={17} aria-hidden="true" />
              )}
              <div>
                <strong>{noticeLabels[notice.tone]}</strong>
                <p>{notice.text}</p>
              </div>
            </li>
          );
        }

        return (
          <li key={block.id} className="transcript__row transcript__row--turn">
            <TurnGroup
              items={block.items}
              live={block.live}
              stepCount={block.stepCount}
            />
            {block.answer ? (
              <div
                className="transcript__answer"
                data-event-id={block.answer.id}
              >
                <Bot size={17} aria-hidden="true" />
                <div className="transcript__bubble">
                  <Markdown artifactLinks>{block.answer.text}</Markdown>
                </div>
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

import { CircleAlert, CircleCheck, Loader2 } from "lucide-react";
import { humanizeTool } from "../humanize.js";
import type { ToolItem } from "../timeline/items.js";

export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
}

const statusIcons = {
  running: Loader2,
  ok: CircleCheck,
  failed: CircleAlert,
} as const;

/**
 * One row per tool call. The summary carries the humanized line and, once the
 * call settles, the elapsed time derived from the paired event timestamps. The
 * disclosure shows what the server already whitelisted and redacted — this
 * component never sees raw arguments or full output.
 */
export function ToolRow({ item }: { item: ToolItem }) {
  const { pre, obj, post } = humanizeTool(item);
  const Icon = statusIcons[item.status];

  return (
    <details
      className={`tool-row tool-row--${item.status}`}
      data-event-id={item.id}
    >
      <summary>
        <Icon
          size={14}
          aria-hidden="true"
          className={item.status === "running" ? "spin" : undefined}
        />
        <span className="tool-row__line">
          {pre}
          {obj ? (
            <>
              {" "}
              <strong>{obj}</strong>
            </>
          ) : null}
          {post ? <span className="tool-row__post"> {post}</span> : null}
        </span>
        {item.durationMs !== undefined ? (
          <span className="tool-row__duration">
            {formatDuration(item.durationMs)}
          </span>
        ) : null}
      </summary>
      <dl className="tool-row__raw">
        {item.name ? (
          <div>
            <dt>Tool</dt>
            <dd>{item.name}</dd>
          </div>
        ) : null}
        {item.argsSummary ? (
          <div>
            <dt>Arguments</dt>
            <dd>{item.argsSummary}</dd>
          </div>
        ) : null}
        {item.preview ? (
          <div>
            <dt>Result</dt>
            <dd>{item.preview}</dd>
          </div>
        ) : null}
        {item.errorMessage ? (
          <div>
            <dt>Error</dt>
            <dd>{item.errorMessage}</dd>
          </div>
        ) : null}
      </dl>
    </details>
  );
}

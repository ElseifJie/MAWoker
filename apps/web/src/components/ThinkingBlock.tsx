/**
 * Reasoning text never reaches the browser, so there is nothing to disclose:
 * this is a status indicator, not an expandable block. An empty disclosure would
 * invite the user to open something that cannot contain anything.
 *
 * Consecutive thinking events collapse into a single row that carries the id of
 * the first one, so the transcript's event ordering stays observable.
 */
export function ThinkingBlock({
  eventId,
  count,
}: {
  eventId: string;
  count: number;
}) {
  return (
    <div className="thinking-block" role="status" data-event-id={eventId}>
      <span className="thinking-block__pulse" aria-hidden="true" />
      <span>{count > 1 ? `Thinking… ${count} steps` : "Thinking…"}</span>
    </div>
  );
}

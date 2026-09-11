import { Send } from "lucide-react";
import { useState, type SyntheticEvent } from "react";
import { Alert, Button, IconButton, Spinner, Textarea } from "../ui/index.js";

export type FirstMessageDelivery = {
  sessionId: string;
  content: string;
  status: "waiting" | "sending" | "failed" | "sent";
};

export type SessionFeedback = {
  kind: "success" | "info" | "error";
  message: string;
};

export interface SessionComposerProps {
  /** A terminated Session or one mid-deletion cannot accept messages. */
  disabled: boolean;
  pendingAction: string | null;
  delivery?: FirstMessageDelivery;
  feedback: SessionFeedback | null;
  /** Resolves true when the message was accepted, so the draft can be cleared. */
  onSend: (content: string) => Promise<boolean>;
  onRetryFirstMessage: (sessionId: string, content: string) => void;
}

/**
 * The follow-up message form. The slot above the send button carries whatever
 * currently blocks or explains delivery — first-message progress, a quota or
 * transport error, or ordinary action feedback — rather than a separate banner
 * that would push the input area around.
 */
export function SessionComposer({
  disabled,
  pendingAction,
  delivery,
  feedback,
  onSend,
  onRetryFirstMessage,
}: SessionComposerProps) {
  const [message, setMessage] = useState("");
  const busy = pendingAction !== null;

  async function submit(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault();
    const content = message.trim();
    if (content.length === 0 || disabled || busy) return;
    if (await onSend(content)) setMessage("");
  }

  return (
    <form className="session-composer" onSubmit={submit}>
      <label className="sr-only" htmlFor="session-message">
        Message
      </label>
      <Textarea
        id="session-message"
        rows={2}
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        placeholder={
          disabled
            ? "This Session cannot accept messages."
            : "Continue this Session…"
        }
        disabled={disabled || busy}
      />
      <div className="session-composer-footer">
        <div className="session-composer-feedback" aria-live="polite">
          {delivery?.status === "waiting" ? (
            <span className="muted">
              <Spinner size={14} aria-hidden="true" />
              Connecting before first message…
            </span>
          ) : delivery?.status === "sending" ? (
            <span className="muted">
              <Spinner size={14} aria-hidden="true" />
              Sending first message…
            </span>
          ) : delivery?.status === "failed" ? (
            <Alert tone="danger">
              The first message could not be sent. Retry from this Session.
            </Alert>
          ) : feedback?.kind === "error" ? (
            <Alert tone="danger">{feedback.message}</Alert>
          ) : (
            <span className="muted">{feedback?.message ?? "\u00a0"}</span>
          )}
        </div>
        {delivery?.status === "failed" ? (
          <Button
            variant="secondary"
            size="compact"
            onClick={() =>
              onRetryFirstMessage(delivery.sessionId, delivery.content)
            }
          >
            Retry first message
          </Button>
        ) : null}
        <IconButton
          label="Send message"
          type="submit"
          className="send-button"
          aria-busy={pendingAction === "message" ? true : undefined}
          disabled={disabled || busy || message.trim().length === 0}
        >
          {pendingAction === "message" ? (
            <Spinner size={17} aria-hidden="true" />
          ) : (
            <Send size={17} aria-hidden="true" />
          )}
        </IconButton>
      </div>
    </form>
  );
}

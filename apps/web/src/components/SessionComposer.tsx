import { clearDraft, readDraft, writeDraft } from "../submission-drafts.js";
import { Send } from "lucide-react";
import { useState, type SyntheticEvent } from "react";
import { Alert, IconButton, Spinner, Textarea } from "../ui/index.js";

export type SessionFeedback = {
  kind: "success" | "info" | "error";
  message: string;
};

export interface SessionComposerProps {
  draftKey?: string;
  /** A terminated Session or one mid-deletion cannot accept messages. */
  disabled: boolean;
  pendingAction: string | null;
  feedback: SessionFeedback | null;
  /** Resolves true when the message was accepted, so the draft can be cleared. */
  onSend: (content: string, submissionId: string) => Promise<boolean>;
}

/**
 * The follow-up message form. The slot above the send button carries whatever
 * currently blocks or explains delivery — a quota or
 * transport error, or ordinary action feedback — rather than a separate banner
 * that would push the input area around.
 */
export function SessionComposer({
  draftKey = "session",
  disabled,
  pendingAction,
  feedback,
  onSend,
}: SessionComposerProps) {
  const [draft] = useState(() => readDraft(draftKey));
  const [submissionId, setSubmissionId] = useState(draft.submissionId);
  const [message, setMessage] = useState(draft.content);
  const busy = pendingAction !== null;

  async function submit(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault();
    const content = message.trim();
    if (content.length === 0 || disabled || busy) return;
    if (await onSend(content, submissionId)) {
      setMessage("");
      setSubmissionId(crypto.randomUUID());
      clearDraft(draftKey);
    }
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
        onChange={(event) => {
          const id = crypto.randomUUID();
          setSubmissionId(id);
          setMessage(event.target.value);
          writeDraft(draftKey, event.target.value, id);
        }}
        placeholder={
          disabled
            ? "This Session cannot accept messages."
            : "Continue this Session…"
        }
        disabled={disabled || busy}
      />
      <div className="session-composer-footer">
        <div className="session-composer-feedback" aria-live="polite">
          {feedback?.kind === "error" ? (
            <Alert tone="danger">{feedback.message}</Alert>
          ) : (
            <span className="muted">{feedback?.message ?? ""}</span>
          )}
        </div>
        <IconButton
          label="Send message"
          type="submit"
          className="send-button"
          size="small"
          aria-busy={pendingAction === "message" ? true : undefined}
          disabled={disabled || busy || message.trim().length === 0}
        >
          {pendingAction === "message" ? (
            <Spinner size={15} aria-hidden="true" />
          ) : (
            <Send size={15} aria-hidden="true" />
          )}
        </IconButton>
      </div>
    </form>
  );
}

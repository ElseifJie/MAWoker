import { clearDraft, readDraft, writeDraft } from "../submission-drafts.js";
import { Paperclip, Send } from "lucide-react";
import { useEffect, useRef, useState, type SyntheticEvent } from "react";
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
  onAttach?: () => void;
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
  onAttach,
}: SessionComposerProps) {
  const [draft] = useState(() => readDraft(draftKey));
  const [submissionId, setSubmissionId] = useState(draft.submissionId);
  const [message, setMessage] = useState(draft.content);
  const busy = pendingAction !== null;
  const composing = useRef(false);
  const sending = useRef(false);
  const mounted = useRef(true);
  const currentSubmissionId = useRef(submissionId);
  currentSubmissionId.current = submissionId;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function submit(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault();
    const content = message.trim();
    if (
      content.length === 0 ||
      disabled ||
      busy ||
      composing.current ||
      sending.current
    )
      return;
    const submittedId = submissionId;
    sending.current = true;
    try {
      if (await onSend(content, submittedId)) {
        if (readDraft(draftKey).submissionId === submittedId)
          clearDraft(draftKey);
        if (mounted.current && currentSubmissionId.current === submittedId) {
          const nextId = crypto.randomUUID();
          currentSubmissionId.current = nextId;
          setMessage("");
          setSubmissionId(nextId);
        }
      }
    } finally {
      sending.current = false;
    }
  }

  return (
    <form className="session-composer" onSubmit={submit}>
      <label className="sr-only" htmlFor="session-message">
        补充要求
      </label>
      <Textarea
        id="session-message"
        rows={2}
        value={message}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onChange={(event) => {
          const id = crypto.randomUUID();
          currentSubmissionId.current = id;
          setSubmissionId(id);
          setMessage(event.target.value);
          writeDraft(draftKey, event.target.value, id);
        }}
        placeholder={
          disabled ? "此任务无法继续发送消息。" : "继续补充任务要求..."
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
        <div className="session-header-actions">
          {onAttach ? (
            <IconButton
              label="添加材料，创建后续任务"
              disabled={disabled || busy}
              onClick={onAttach}
            >
              <Paperclip size={15} aria-hidden="true" />
            </IconButton>
          ) : null}
          <IconButton
            label="发送消息"
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
      </div>
    </form>
  );
}

import {
  AlertCircle,
  Archive,
  Bot,
  ChevronDown,
  MoreHorizontal,
  Paperclip,
  RotateCcw,
  Send,
  Square,
  Trash2,
  UserRound,
  Wrench,
} from "lucide-react";
import {
  type SyntheticEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useParams } from "react-router-dom";
import {
  ApiClientError,
  apiClient,
  type SessionDetail,
  type SessionStatus,
  type SessionSummary,
  type UiEvent,
} from "./api.js";
import {
  Alert,
  Badge,
  type BadgeTone,
  Button,
  Dialog,
  Field,
  IconButton,
  Input,
  Spinner,
  Textarea,
} from "./ui/index.js";

type FirstMessageDelivery = {
  sessionId: string;
  content: string;
  status: "waiting" | "sending" | "failed" | "sent";
};

type SessionFeedback = {
  kind: "success" | "info" | "error";
  message: string;
};

const eventNames = [
  "user.message",
  "agent.message",
  "agent.thinking",
  "tool.call",
  "tool.result",
  "agent.tool_use",
  "agent.tool_result",
  "agent.mcp_tool_use",
  "agent.mcp_tool_result",
  "agent.custom_tool_use",
  "session.status",
  "session.status_running",
  "session.status_rescheduled",
  "session.status_idle",
  "session.status_terminated",
  "session.error",
] as const;

const statusLabels: Record<SessionStatus, string> = {
  idle: "Idle",
  running: "Running",
  rescheduled: "Rescheduled",
  terminated: "Terminated",
};

const statusTones: Record<SessionStatus, BadgeTone> = {
  idle: "neutral",
  running: "success",
  rescheduled: "warning",
  terminated: "danger",
};

function payloadString(event: UiEvent, field: string): string | undefined {
  return typeof event.payload[field] === "string"
    ? event.payload[field]
    : undefined;
}

function isSessionStatus(value: unknown): value is SessionStatus {
  return (
    value === "idle" ||
    value === "running" ||
    value === "rescheduled" ||
    value === "terminated"
  );
}

function sessionErrorFeedback(
  error: unknown,
  operation: string,
): SessionFeedback {
  let message: string;
  if (error instanceof ApiClientError) {
    if (error.code === "SESSION_TERMINATED") {
      message = "This Session is terminated and cannot accept new messages.";
    } else if (error.code === "SESSION_BUSY") {
      message =
        "The Session is busy. Your message was not accepted; try again.";
    } else if (error.code === "DELETION_FAILED") {
      message =
        "Permanent deletion failed and will be retried in the background.";
    } else if (error.retryable) {
      message = `${operation} could not be completed. Try again.`;
    } else {
      message = `${operation} could not be completed.`;
    }
  } else {
    message = `${operation} could not be completed.`;
  }
  return { kind: "error", message };
}

function TimelineEvent({ event }: { event: UiEvent }) {
  const content = payloadString(event, "content");
  if (event.sourceType === "user.message") {
    return (
      <li className="timeline-event user-event" data-event-id={event.id}>
        <UserRound size={17} aria-hidden="true" />
        <div>
          <strong>You</strong>
          <p>{content ?? "Message sent"}</p>
        </div>
      </li>
    );
  }
  if (event.type === "message") {
    return (
      <li className="timeline-event agent-event" data-event-id={event.id}>
        <Bot size={17} aria-hidden="true" />
        <div>
          <strong>Agent</strong>
          <p>{content ?? "Response received"}</p>
        </div>
      </li>
    );
  }
  if (event.type === "thinking") {
    return (
      <li className="timeline-event activity-event" data-event-id={event.id}>
        <Spinner size={16} aria-hidden="true" />
        <span>Agent is thinking…</span>
      </li>
    );
  }
  if (event.type === "tool") {
    const name = payloadString(event, "name") ?? "Tool";
    const status = payloadString(event, "status") ?? "updated";
    const readableStatus =
      status.length === 0
        ? "Updated"
        : `${status.charAt(0).toUpperCase()}${status.slice(1)}`;
    return (
      <li className="timeline-event tool-event" data-event-id={event.id}>
        <details>
          <summary>
            <Wrench size={15} aria-hidden="true" />
            {name} · {readableStatus}
            <ChevronDown size={15} aria-hidden="true" />
          </summary>
          <p>Tool activity status: {readableStatus}.</p>
        </details>
      </li>
    );
  }
  if (event.type === "error") {
    const recoverable = event.payload.recoverable === true;
    return (
      <li
        className={`timeline-event error-event${recoverable ? " recoverable" : ""}`}
        data-event-id={event.id}
      >
        <AlertCircle size={17} aria-hidden="true" />
        <div>
          <strong>
            {recoverable ? "Recoverable error" : "Session stopped"}
          </strong>
          <p>
            {payloadString(event, "message") ??
              (recoverable
                ? "The Agent is retrying automatically."
                : "The Session could not continue.")}
          </p>
        </div>
      </li>
    );
  }
  if (event.type === "status") {
    const status = payloadString(event, "status");
    const knownStatus = isSessionStatus(status) ? status : undefined;
    return (
      <li className="timeline-event status-event" data-event-id={event.id}>
        <span>Session status changed to</span>
        <Badge tone={knownStatus ? statusTones[knownStatus] : "neutral"}>
          {knownStatus ? statusLabels[knownStatus] : "Updated"}
        </Badge>
      </li>
    );
  }
  return (
    <li className="timeline-event status-event" data-event-id={event.id}>
      Activity received.
    </li>
  );
}

interface SessionPageProps {
  deliveries: Record<string, FirstMessageDelivery>;
  onRetryFirstMessage: (sessionId: string, content: string) => void;
  onStreamReady: (sessionId: string) => void;
  onSessionChanged: (session: SessionSummary) => void;
  onAuthRequired: () => void;
}

export function SessionPage(props: SessionPageProps) {
  const { sessionId } = useParams();
  if (!sessionId) return null;
  return (
    <SessionPageContent key={sessionId} {...props} sessionId={sessionId} />
  );
}

function SessionPageContent({
  deliveries,
  onRetryFirstMessage,
  onStreamReady,
  onSessionChanged,
  onAuthRequired,
  sessionId,
}: SessionPageProps & { sessionId: string }) {
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [events, setEvents] = useState<UiEvent[]>([]);
  const [connection, setConnection] = useState<
    "connecting" | "live" | "reconnecting" | "ended"
  >("connecting");
  const [message, setMessage] = useState("");
  const [feedback, setFeedback] = useState<SessionFeedback | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const pageHeadingRef = useRef<HTMLHeadingElement>(null);
  const actionTriggerRef = useRef<HTMLButtonElement>(null);
  const actionMenuRef = useRef<HTMLDivElement>(null);
  const deleteInitialFocusRef = useRef<HTMLInputElement>(null);
  function closeDeleteDialog() {
    setDeleteOpen(false);
    setDeleteConfirmation("");
  }
  const delivery = deliveries[sessionId];
  const sessionLoaded = session !== null;

  useEffect(() => {
    actionTriggerRef.current =
      actionMenuRef.current?.querySelector<HTMLButtonElement>("button") ?? null;
  }, [actionsOpen, session?.archivedAt, session?.deletionState]);

  useEffect(() => {
    let active = true;
    setLoadError(false);
    void apiClient
      .getSession(sessionId)
      .then((detail) => {
        if (active) setSession(detail);
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof ApiClientError && error.isAuthRequired) {
          onAuthRequired();
        } else {
          setLoadError(true);
        }
      });
    return () => {
      active = false;
    };
  }, [onAuthRequired, reloadKey, sessionId]);

  const projectEvent = useCallback((event: UiEvent) => {
    setEvents((current) =>
      current.some((item) => item.id === event.id)
        ? current
        : [...current, event],
    );
    const payloadStatus = event.payload.status;
    const status =
      event.type === "status" && isSessionStatus(payloadStatus)
        ? payloadStatus
        : event.type === "error"
          ? event.payload.recoverable === true
            ? "rescheduled"
            : "terminated"
          : undefined;
    if (status) {
      setSession((current) => {
        if (!current) return current;
        return { ...current, status };
      });
    }
  }, []);

  useEffect(() => {
    if (!sessionId || !sessionLoaded) return;
    setConnection("connecting");
    const source = new EventSource(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/events`,
      { withCredentials: true },
    );
    const receive = (raw: Event) => {
      if (!(raw instanceof MessageEvent) || typeof raw.data !== "string") {
        return;
      }
      try {
        const parsed = JSON.parse(raw.data) as UiEvent;
        if (
          typeof parsed.id === "string" &&
          typeof parsed.sourceType === "string" &&
          typeof parsed.createdAt === "string" &&
          typeof parsed.payload === "object" &&
          parsed.payload !== null
        ) {
          projectEvent(parsed);
          const terminated =
            (parsed.type === "status" &&
              parsed.payload.status === "terminated") ||
            (parsed.type === "error" && parsed.payload.recoverable !== true);
          if (terminated) {
            source.close();
            setConnection("ended");
          }
        }
      } catch {
        setFeedback({
          kind: "info",
          message: "An invalid Session event was ignored.",
        });
      }
    };
    for (const name of eventNames) source.addEventListener(name, receive);
    source.onopen = () => {
      setConnection("live");
      onStreamReady(sessionId);
    };
    source.onerror = () => setConnection("reconnecting");
    return () => {
      source.close();
    };
  }, [onStreamReady, projectEvent, sessionId, sessionLoaded]);

  useEffect(() => {
    if (session) onSessionChanged(session);
  }, [onSessionChanged, session]);

  function applySession(updated: SessionSummary) {
    setSession((current) =>
      current ? { ...current, ...updated, inputs: current.inputs } : current,
    );
    onSessionChanged(updated);
  }

  async function submitMessage(
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ) {
    event.preventDefault();
    if (
      !sessionId ||
      !session ||
      pendingAction ||
      message.trim().length === 0
    ) {
      return;
    }
    const content = message.trim();
    setPendingAction("message");
    setFeedback(null);
    try {
      const result = await apiClient.sendMessage(sessionId, content);
      setMessage("");
      setFeedback({
        kind: "success",
        message:
          result.delivery === "queued"
            ? "Message queued."
            : "Message accepted.",
      });
    } catch (error) {
      if (error instanceof ApiClientError && error.isAuthRequired) {
        onAuthRequired();
      } else {
        setFeedback(sessionErrorFeedback(error, "The message"));
      }
    } finally {
      setPendingAction(null);
    }
  }

  async function interrupt() {
    if (!sessionId || pendingAction) return;
    setPendingAction("interrupt");
    setFeedback(null);
    try {
      await apiClient.interruptSession(sessionId);
      setFeedback({ kind: "success", message: "Interrupt requested." });
    } catch (error) {
      if (error instanceof ApiClientError && error.isAuthRequired) {
        onAuthRequired();
      } else {
        setFeedback(sessionErrorFeedback(error, "The interrupt"));
      }
    } finally {
      setPendingAction(null);
    }
  }

  async function toggleArchive() {
    if (!sessionId || !session || pendingAction) return;
    setPendingAction("archive");
    setFeedback(null);
    try {
      const updated = session.archivedAt
        ? await apiClient.restoreSession(sessionId)
        : await apiClient.archiveSession(sessionId);
      applySession(updated);
      setActionsOpen(false);
      setFeedback({
        kind: "success",
        message: updated.archivedAt ? "Session archived." : "Session restored.",
      });
    } catch (error) {
      if (error instanceof ApiClientError && error.isAuthRequired) {
        onAuthRequired();
      } else {
        setFeedback(sessionErrorFeedback(error, "The archive change"));
      }
    } finally {
      setPendingAction(null);
    }
  }

  async function deleteSession() {
    const currentSession = session;
    if (!currentSession || pendingAction || deleteConfirmation !== "DELETE") {
      return;
    }
    setPendingAction("delete");
    setFeedback(null);
    try {
      const result = await apiClient.deleteSession(sessionId);
      applySession({
        ...currentSession,
        deletionState: result.deletionState,
      });
      closeDeleteDialog();
    } catch (error) {
      if (error instanceof ApiClientError && error.isAuthRequired) {
        onAuthRequired();
      } else {
        setFeedback(sessionErrorFeedback(error, "Permanent deletion"));
        closeDeleteDialog();
      }
    } finally {
      setPendingAction(null);
    }
  }

  if (loadError) {
    return (
      <div className="page">
        <div className="page-heading">
          <p className="eyebrow">Session</p>
          <h1>Session</h1>
          <p className="muted">This Session could not be loaded.</p>
        </div>
        <Button
          variant="secondary"
          onClick={() => setReloadKey((key) => key + 1)}
        >
          Retry
        </Button>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="session-page" aria-busy="true">
        <div className="session-header skeleton-header">
          <Spinner size={18} aria-hidden="true" />
          <span>Loading Session…</span>
        </div>
        <div className="timeline-shell" />
        <div className="session-composer placeholder-composer" />
      </div>
    );
  }

  const messageDisabled =
    session.status === "terminated" || session.deletionState !== "none";
  const connectionLabel =
    connection === "live"
      ? "Live"
      : connection === "reconnecting"
        ? "Reconnecting…"
        : connection === "ended"
          ? "Ended"
          : "Connecting…";
  const connectionTone: BadgeTone =
    connection === "live"
      ? "success"
      : connection === "reconnecting"
        ? "warning"
        : connection === "ended"
          ? "danger"
          : "neutral";
  const composerError =
    delivery?.status === "failed" || feedback?.kind === "error";

  return (
    <div
      className={`session-page${composerError ? " session-page--composer-error" : ""}`}
    >
      <header className="session-header">
        <div className="session-heading">
          <p className="eyebrow">Session</p>
          <h1 ref={pageHeadingRef} tabIndex={-1}>
            {session.title}
          </h1>
          <div className="session-meta">
            <span>{session.agent.name}</span>
            <span>Version {session.agent.version}</span>
            <Badge tone={statusTones[session.status]}>
              {statusLabels[session.status]}
            </Badge>
            <Badge className="session-connection-badge" tone={connectionTone}>
              {connectionLabel}
            </Badge>
          </div>
        </div>
        <div className="session-header-actions">
          {session.status === "running" ? (
            <Button
              variant="secondary"
              size="compact"
              aria-label="Interrupt Session"
              onClick={() => void interrupt()}
              loading={pendingAction === "interrupt"}
              disabled={pendingAction !== null}
            >
              {pendingAction === "interrupt" ? (
                <Spinner size={14} aria-hidden="true" />
              ) : (
                <Square size={14} aria-hidden="true" />
              )}
              Interrupt
            </Button>
          ) : null}
          {session.deletionState !== "none" ? null : session.archivedAt ? (
            <Button
              variant="secondary"
              size="compact"
              aria-label="Restore Session"
              onClick={() => void toggleArchive()}
              loading={pendingAction === "archive"}
              disabled={pendingAction !== null}
            >
              {pendingAction === "archive" ? (
                <Spinner size={14} aria-hidden="true" />
              ) : (
                <RotateCcw size={14} aria-hidden="true" />
              )}
              Restore
            </Button>
          ) : (
            <div ref={actionMenuRef} className="action-menu">
              <IconButton
                label="Session actions"
                aria-expanded={actionsOpen}
                onClick={() => setActionsOpen((open) => !open)}
              >
                <MoreHorizontal size={18} aria-hidden="true" />
              </IconButton>
              {actionsOpen ? (
                <div className="action-menu-panel">
                  <Button
                    variant="text"
                    size="compact"
                    loading={pendingAction === "archive"}
                    onClick={() => void toggleArchive()}
                  >
                    {pendingAction === "archive" ? (
                      <Spinner size={14} aria-hidden="true" />
                    ) : (
                      <Archive size={15} aria-hidden="true" />
                    )}
                    Archive Session
                  </Button>
                  <Button
                    variant="text"
                    size="compact"
                    className="session-action-menu__danger"
                    onClick={() => {
                      setActionsOpen(false);
                      setDeleteOpen(true);
                    }}
                  >
                    <Trash2 size={15} aria-hidden="true" />
                    Delete Session permanently
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </header>

      <div className="session-body">
        {session.inputs.length > 0 ? (
          <div className="session-inputs" aria-label="Session input files">
            <Paperclip size={15} aria-hidden="true" />
            {session.inputs.map((input) => (
              <span key={input.id}>{input.name}</span>
            ))}
          </div>
        ) : null}

        {session.deletionState === "pending" ? (
          <Alert className="session-deletion-alert" tone="warning">
            <div className="session-deletion-alert__copy">
              <strong>Permanent deletion pending</strong>
              <span>The Session will disappear after background cleanup.</span>
            </div>
          </Alert>
        ) : session.deletionState === "deletion_failed" ? (
          <Alert className="session-deletion-alert" tone="danger">
            <div className="session-deletion-alert__copy">
              <strong>Permanent deletion failed</strong>
              <span>Background cleanup could not finish.</span>
            </div>
          </Alert>
        ) : null}

        <section className="timeline-shell" aria-label="Session timeline">
          {events.length === 0 ? (
            <div className="timeline-empty">
              <Bot size={20} aria-hidden="true" />
              <p>Waiting for Session activity…</p>
            </div>
          ) : (
            <ol className="timeline">
              {events.map((event) => (
                <TimelineEvent key={event.id} event={event} />
              ))}
            </ol>
          )}
        </section>
      </div>

      <form className="session-composer" onSubmit={submitMessage}>
        <label className="sr-only" htmlFor="session-message">
          Message
        </label>
        <Textarea
          id="session-message"
          rows={2}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder={
            messageDisabled
              ? "This Session cannot accept messages."
              : "Continue this Session…"
          }
          disabled={messageDisabled || pendingAction !== null}
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
            disabled={
              messageDisabled ||
              pendingAction !== null ||
              message.trim().length === 0
            }
          >
            {pendingAction === "message" ? (
              <Spinner size={17} aria-hidden="true" />
            ) : (
              <Send size={17} aria-hidden="true" />
            )}
          </IconButton>
        </div>
      </form>

      <Dialog
        open={deleteOpen}
        title="Delete Session permanently?"
        onClose={closeDeleteDialog}
        closeLabel="Close deletion confirmation"
        closeDisabled={pendingAction !== null}
        initialFocusRef={deleteInitialFocusRef}
        returnFocusRef={actionTriggerRef}
        fallbackFocusRef={pageHeadingRef}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={closeDeleteDialog}
              disabled={pendingAction !== null}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              className="session-delete-button"
              loading={pendingAction === "delete"}
              onClick={() => void deleteSession()}
              disabled={
                pendingAction !== null || deleteConfirmation !== "DELETE"
              }
            >
              <span className="session-delete-button__icon">
                {pendingAction === "delete" ? (
                  <Spinner size={15} aria-hidden="true" />
                ) : (
                  <Trash2 size={15} aria-hidden="true" />
                )}
              </span>
              Delete permanently
            </Button>
          </>
        }
      >
        <div className="session-delete-dialog">
          <p>
            This removes the Session, its event history, and generated
            artifacts. This action cannot be undone.
          </p>
          <Field label="Type DELETE to confirm">
            <Input
              ref={deleteInitialFocusRef}
              value={deleteConfirmation}
              onChange={(event) => setDeleteConfirmation(event.target.value)}
              autoComplete="off"
            />
          </Field>
        </div>
      </Dialog>
    </div>
  );
}

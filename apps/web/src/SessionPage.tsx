import {
  Archive,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Paperclip,
  RotateCcw,
  Square,
  Trash2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { useParams, useSearchParams } from "react-router-dom";
import {
  ApiClientError,
  apiClient,
  type ArtifactSummary,
  type SessionDetail,
  type SessionStatus,
  type SessionSummary,
} from "./api.js";
import { Transcript } from "./components/Transcript.js";
import {
  SessionComposer,
  type FirstMessageDelivery,
  type SessionFeedback,
} from "./components/SessionComposer.js";
import { useSessionTimeline } from "./timeline/useSessionTimeline.js";
import {
  RAIL_DEFAULT_WIDTH,
  WorkspaceRail,
} from "./components/WorkspaceRail.js";
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
} from "./ui/index.js";

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

interface SessionPageProps {
  deliveries: Record<string, FirstMessageDelivery>;
  onRetryFirstMessage: (sessionId: string, content: string) => void;
  onStreamReady: (sessionId: string) => void;
  onSessionChanged: (session: SessionSummary) => void;
  onAuthRequired: () => void;
}

export function SessionPage(props: SessionPageProps) {
  const { sessionId } = useParams();
  // Held above the keyed content so the chosen panel width survives moving
  // between Sessions rather than snapping back on every navigation.
  const [railWidth, setRailWidth] = useState(RAIL_DEFAULT_WIDTH);
  if (!sessionId) return null;
  return (
    <SessionPageContent
      key={sessionId}
      {...props}
      sessionId={sessionId}
      railWidth={railWidth}
      onRailWidthChange={setRailWidth}
    />
  );
}

function SessionPageContent({
  deliveries,
  onRetryFirstMessage,
  onStreamReady,
  onSessionChanged,
  onAuthRequired,
  sessionId,
  railWidth,
  onRailWidthChange,
}: SessionPageProps & {
  sessionId: string;
  railWidth: number;
  onRailWidthChange: (width: number) => void;
}) {
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [feedback, setFeedback] = useState<SessionFeedback | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [railOpen, setRailOpen] = useState(true);
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

  const reportInvalidEvent = useCallback(() => {
    setFeedback({
      kind: "info",
      message: "An invalid Session event was ignored.",
    });
  }, []);

  const timeline = useSessionTimeline({
    sessionId,
    enabled: sessionLoaded,
    onStreamReady,
    onInvalidEvent: reportInvalidEvent,
  });

  // The fold owns live status; mirror it onto the record so the header badge and
  // the sidebar summary keep updating as they did when events drove it directly.
  const timelineStatus = timeline.status;
  useEffect(() => {
    if (!timelineStatus) return;
    setSession((current) =>
      current && current.status !== timelineStatus
        ? { ...current, status: timelineStatus }
        : current,
    );
  }, [timelineStatus]);

  useEffect(() => {
    if (session) onSessionChanged(session);
  }, [onSessionChanged, session]);

  const [searchParams, setSearchParams] = useSearchParams();
  const selectedArtifactId = searchParams.get("artifact");

  const writeCount = useMemo(
    () =>
      timeline.items.reduce(
        (total, item) =>
          item.kind === "tool" &&
          item.status === "ok" &&
          (item.name === "write" || item.name === "edit")
            ? total + 1
            : total,
        0,
      ),
    [timeline.items],
  );
  const artifactRefreshKey = `${writeCount}:${timeline.status ?? "unknown"}`;

  const [artifacts, setArtifacts] = useState<ArtifactSummary[]>([]);
  const [artifactsError, setArtifactsError] = useState(false);
  const [artifactsSyncError, setArtifactsSyncError] = useState(false);

  const loadArtifacts = useCallback(() => {
    let active = true;
    setArtifactsError(false);
    void apiClient
      .listArtifacts(sessionId)
      .then((result) => {
        if (active) setArtifacts(result.artifacts);
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof ApiClientError && error.isAuthRequired) {
          onAuthRequired();
          return;
        }
        setArtifactsError(true);
      });
    return () => {
      active = false;
    };
  }, [onAuthRequired, sessionId]);

  useEffect(() => loadArtifacts(), [artifactRefreshKey, loadArtifacts]);

  useEffect(() => {
    if (selectedArtifactId) setRailOpen(true);
  }, [selectedArtifactId]);

  const selectArtifact = useCallback(
    (artifactId: string | null) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (artifactId) next.set("artifact", artifactId);
          else next.delete("artifact");
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  // One in-flight sync shared by the turn-end refresh and link clicks, so a
  // click during the post-turn sync awaits it instead of starting a second one.
  const syncInFlightRef = useRef<Promise<ArtifactSummary[] | null> | null>(
    null,
  );
  const syncArtifactsNow = useCallback((): Promise<
    ArtifactSummary[] | null
  > => {
    if (!syncInFlightRef.current) {
      syncInFlightRef.current = (async () => {
        try {
          await apiClient.syncArtifacts(sessionId);
          const result = await apiClient.listArtifacts(sessionId);
          setArtifacts(result.artifacts);
          setArtifactsError(false);
          setArtifactsSyncError(false);
          return result.artifacts;
        } catch (error) {
          if (error instanceof ApiClientError && error.isAuthRequired) {
            onAuthRequired();
          } else {
            // Silence here used to hide a broken sync entirely; the rail now
            // says so and offers a retry.
            setArtifactsSyncError(true);
          }
          return null;
        } finally {
          syncInFlightRef.current = null;
        }
      })();
    }
    return syncInFlightRef.current;
  }, [onAuthRequired, sessionId]);

  const prevStatusRef = useRef(timelineStatus);
  useEffect(() => {
    const previous = prevStatusRef.current;
    prevStatusRef.current = timelineStatus;
    const wasInFlight = previous === "running" || previous === "rescheduled";
    const ended = timelineStatus === "idle" || timelineStatus === "terminated";
    if (!wasInFlight || !ended) return;
    // Files can land on the Agent side slightly after the final event, so the
    // sync waits a beat once the turn settles.
    const timer = setTimeout(() => {
      void syncArtifactsNow();
    }, 1500);
    return () => clearTimeout(timer);
  }, [timelineStatus, syncArtifactsNow]);

  const openArtifactByPath = useCallback(
    (path: string) => {
      const name = path.slice(path.lastIndexOf("/") + 1);
      const match = artifacts.find(
        (artifact) =>
          artifact.name === name && artifact.deletionState === "none",
      );
      if (match) {
        selectArtifact(match.id);
        return;
      }
      void syncArtifactsNow().then((synced) => {
        const fresh = synced?.find(
          (artifact) =>
            artifact.name === name && artifact.deletionState === "none",
        );
        if (fresh) {
          selectArtifact(fresh.id);
        } else {
          setFeedback({
            kind: "info",
            message: "That file isn't available in this Session's outputs yet.",
          });
        }
      });
    },
    [artifacts, selectArtifact, syncArtifactsNow],
  );

  function handleSessionBodyClick(event: MouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    const chip = target.closest<HTMLElement>("[data-artifact-path]");
    if (chip) openArtifactByPath(chip.dataset.artifactPath ?? "");
  }

  function applySession(updated: SessionSummary) {
    setSession((current) =>
      current ? { ...current, ...updated, inputs: current.inputs } : current,
    );
    onSessionChanged(updated);
  }

  async function sendMessage(content: string): Promise<boolean> {
    if (!session || pendingAction) return false;
    setPendingAction("message");
    setFeedback(null);
    try {
      const result = await apiClient.sendMessage(sessionId, content);
      setFeedback({
        kind: "success",
        message:
          result.delivery === "queued"
            ? "Message queued."
            : "Message accepted.",
      });
      return true;
    } catch (error) {
      if (error instanceof ApiClientError && error.isAuthRequired) {
        onAuthRequired();
      } else {
        setFeedback(sessionErrorFeedback(error, "The message"));
      }
      return false;
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

  const { blocks, connection } = timeline;
  const panelSummary = [
    artifacts.length > 0
      ? `${artifacts.length} artifact${artifacts.length === 1 ? "" : "s"}`
      : "",
    timeline.todos.length > 0
      ? `${timeline.todos.length} task${timeline.todos.length === 1 ? "" : "s"}`
      : "",
  ]
    .filter((part) => part.length > 0)
    .join(", ");
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
    <div className="session-workspace">
      <div
        className={`session-page${composerError ? " session-page--composer-error" : ""}`}
      >
        <header className="session-header">
          <div className="session-heading">
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
            <IconButton
              className="rail-toggle"
              label={
                railOpen
                  ? "Collapse side panel"
                  : panelSummary.length > 0
                    ? `Open side panel, ${panelSummary}`
                    : "Open side panel"
              }
              aria-expanded={railOpen}
              onClick={() => setRailOpen((open) => !open)}
            >
              {railOpen ? (
                <PanelRightClose size={18} aria-hidden="true" />
              ) : (
                <PanelRightOpen size={18} aria-hidden="true" />
              )}
            </IconButton>
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

        <div className="session-body" onClick={handleSessionBodyClick}>
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
                <span>
                  The Session will disappear after background cleanup.
                </span>
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
            <Transcript blocks={blocks} />
          </section>
        </div>

        <SessionComposer
          disabled={messageDisabled}
          pendingAction={pendingAction}
          {...(delivery ? { delivery } : {})}
          feedback={feedback}
          onSend={sendMessage}
          onRetryFirstMessage={onRetryFirstMessage}
        />

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
      {railOpen ? (
        <WorkspaceRail
          todos={timeline.todos}
          artifacts={artifacts}
          artifactsError={artifactsError}
          artifactsSyncError={artifactsSyncError}
          onRetryArtifacts={() => {
            setArtifactsSyncError(false);
            void syncArtifactsNow();
            loadArtifacts();
          }}
          selectedArtifactId={selectedArtifactId}
          onSelectArtifact={selectArtifact}
          onClose={() => setRailOpen(false)}
          width={railWidth}
          onWidthChange={onRailWidthChange}
        />
      ) : null}
    </div>
  );
}

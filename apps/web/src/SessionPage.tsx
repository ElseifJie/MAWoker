import { hasSavedTurnAnswer } from "./turn-answer.js";
import {
  Archive,
  MoreHorizontal,
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
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ApiClientError,
  apiClient,
  type ArtifactSummary,
  type SessionDetail,
  type SessionSummary,
  type SessionTurn,
} from "./api.js";
import { Transcript, UserMessage } from "./components/Transcript.js";
import { NewMessages } from "./components/NewMessages.js";
import { TurnStatus } from "./components/TurnStatus.js";
import { canStopTask, taskStatus } from "./task-status.js";
import {
  downloadMarkdown,
  transcriptFilename,
  transcriptMarkdown,
} from "./exportTranscript.js";
import {
  SessionComposer,
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

function sessionErrorFeedback(
  error: unknown,
  operation: string,
): SessionFeedback {
  let message: string;
  if (error instanceof ApiClientError) {
    if (error.code === "SESSION_TERMINATED") {
      message = "此任务已结束，无法继续发送消息。";
    } else if (error.code === "SESSION_BUSY") {
      message = "任务正忙，本条消息未被接受，请稍后重试。";
    } else if (error.code === "DELETION_FAILED") {
      message = "永久删除失败，后台将继续重试。";
    } else if (error.retryable) {
      message = `${operation}未完成，请重试。`;
    } else {
      message = `${operation}未完成。`;
    }
  } else {
    message = `${operation}未完成。`;
  }
  return { kind: "error", message };
}

interface SessionPageProps {
  userId?: string;
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
  userId = "user",
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
  const navigate = useNavigate();
  const createFollowUp = () =>
    navigate(`/?sourceSessionId=${encodeURIComponent(sessionId)}`);
  const [feedback, setFeedback] = useState<SessionFeedback | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [railOpen, setRailOpen] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [turns, setTurns] = useState<SessionTurn[]>([]);
  const pageHeadingRef = useRef<HTMLHeadingElement>(null);
  const actionTriggerRef = useRef<HTMLButtonElement>(null);
  const actionMenuRef = useRef<HTMLDivElement>(null);
  const deleteInitialFocusRef = useRef<HTMLInputElement>(null);
  function closeDeleteDialog() {
    setDeleteOpen(false);
    setDeleteConfirmation("");
  }
  const sessionLoaded = session !== null;

  useEffect(() => {
    let active = true;
    const refresh = () => {
      void apiClient
        .listSessionTurns(sessionId)
        .then((result) => {
          if (active) setTurns(result.turns ?? []);
        })
        .catch((error) => {
          if (active && error instanceof ApiClientError && error.isAuthRequired)
            onAuthRequired();
        });
    };
    refresh();
    const timer = setInterval(refresh, 10_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [sessionId, onAuthRequired, reloadKey]);

  const latestTurn = turns[0];
  const currentTurn =
    latestTurn &&
    session?.status !== "running" &&
    !session?.submissions?.some(
      (item) =>
        item.status !== "failed" &&
        Date.parse(item.createdAt) > Date.parse(latestTurn.endedAt),
    )
      ? latestTurn
      : undefined;
  const recoverTurn = async () => {
    if (!latestTurn) return;
    setPendingAction("turn");
    try {
      await apiClient.retrySessionTurn(sessionId, latestTurn.id);
      setFeedback({ kind: "info", message: "已安排后台恢复结果同步。" });
      setReloadKey((key) => key + 1);
    } catch (error) {
      if (error instanceof ApiClientError && error.isAuthRequired)
        onAuthRequired();
      else
        setFeedback({
          kind: "error",
          message: "无法恢复结果同步，请刷新任务状态后再试。",
        });
    } finally {
      setPendingAction(null);
    }
  };

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

  useEffect(() => {
    if (
      !session?.submissions?.some((item) =>
        ["queued", "sending", "unknown"].includes(item.status),
      )
    )
      return;
    const timer = setInterval(() => setReloadKey((key) => key + 1), 2000);
    return () => clearInterval(timer);
  }, [session?.submissions]);

  useEffect(() => {
    if (!session?.historyState || session.deletionState !== "none") return;
    const timer = setInterval(() => setReloadKey((key) => key + 1), 10_000);
    return () => clearInterval(timer);
  }, [session?.historyState, session?.deletionState]);

  const reportInvalidEvent = useCallback(() => {
    setFeedback({
      kind: "info",
      message: "已忽略一条无效任务事件。",
    });
  }, []);

  const timeline = useSessionTimeline({
    sessionId,
    enabled: sessionLoaded && session?.upstreamReady !== false,
    onStreamReady,
    onInvalidEvent: reportInvalidEvent,
    onAuthInvalid: onAuthRequired,
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
    setRailOpen(Boolean(selectedArtifactId));
  }, [selectedArtifactId]);

  const selectArtifact = useCallback(
    (artifactId: string | null) => {
      setRailOpen(Boolean(artifactId));
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

  // Manual refresh and artifact links share one in-flight synchronization.
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
            message: "该文件尚未出现在此任务的成果中。",
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

  async function sendMessage(
    content: string,
    submissionId: string,
  ): Promise<boolean> {
    if (!session || pendingAction) return false;
    setPendingAction("message");
    setFeedback(null);
    try {
      const result = await apiClient.sendMessage(
        sessionId,
        content,
        submissionId,
      );
      setFeedback({
        kind: "success",
        message:
          result.delivery === "queued"
            ? "消息已排队，后台将继续发送。"
            : "消息已接受。",
      });
      // The 202 is the persistence boundary; a slow refresh must not hold the draft.
      setSession((current) =>
        current
          ? {
              ...current,
              submissions: [
                ...(current.submissions ?? []).filter(
                  (item) => item.submissionId !== submissionId,
                ),
                {
                  submissionId,
                  status: result.status ?? "queued",
                  content,
                  upstreamEventId:
                    result.delivery === "accepted" ? result.eventId : null,
                  errorCode: null,
                  createdAt: new Date().toISOString(),
                },
              ],
            }
          : current,
      );
      setReloadKey((key) => key + 1);
      return true;
    } catch (error) {
      if (error instanceof ApiClientError && error.isAuthRequired) {
        onAuthRequired();
      } else {
        setFeedback(sessionErrorFeedback(error, "发送消息"));
      }
      return false;
    } finally {
      setPendingAction(null);
    }
  }

  async function interrupt() {
    if (!session || !canStopTask(session) || pendingAction) return;
    setPendingAction("interrupt");
    setFeedback(null);
    try {
      await apiClient.interruptSession(sessionId);
      setFeedback({
        kind: "success",
        message: "已请求停止，等待任务状态确认。",
      });
      setReloadKey((key) => key + 1);
    } catch (error) {
      if (error instanceof ApiClientError && error.isAuthRequired) {
        onAuthRequired();
      } else {
        setFeedback(sessionErrorFeedback(error, "请求停止"));
      }
    } finally {
      setPendingAction(null);
    }
  }

  async function retryHistoryExport() {
    if (!session || pendingAction) return;
    setPendingAction("history");
    setHistoryError(null);
    try {
      const { events } = await apiClient.getSessionTranscript(sessionId);
      downloadMarkdown(
        transcriptFilename(session.title),
        transcriptMarkdown(session.title, events),
      );
      setReloadKey((key) => key + 1);
    } catch (error) {
      if (error instanceof ApiClientError && error.isAuthRequired) {
        onAuthRequired();
      } else {
        setHistoryError(
          error instanceof ApiClientError &&
            error.code === "EVENT_HISTORY_REPAIR_PENDING"
            ? error.message
            : "历史同步或导出失败，请稍后重试。",
        );
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
        message: updated.archivedAt ? "任务已归档。" : "任务已恢复。",
      });
    } catch (error) {
      if (error instanceof ApiClientError && error.isAuthRequired) {
        onAuthRequired();
      } else {
        setFeedback(sessionErrorFeedback(error, "归档操作"));
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
        setFeedback(sessionErrorFeedback(error, "永久删除"));
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
          <p className="eyebrow">任务</p>
          <h1>任务</h1>
          <p className="muted">无法加载此任务。</p>
        </div>
        <Button
          variant="secondary"
          onClick={() => setReloadKey((key) => key + 1)}
        >
          重试
        </Button>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="session-page" aria-busy="true">
        <div className="session-header skeleton-header">
          <Spinner size={18} aria-hidden="true" />
          <span>正在加载任务...</span>
        </div>
        <div className="timeline-shell" />
        <div className="session-composer placeholder-composer" />
      </div>
    );
  }

  const { blocks, connection } = timeline;
  const visibleTurn =
    currentTurn &&
    !timeline.items.some(
      (item) => Date.parse(item.ts) > Date.parse(currentTurn.endedAt),
    )
      ? currentTurn
      : undefined;
  const messageDisabled =
    session.status === "terminated" || session.deletionState !== "none";
  const connectionLabel =
    session.upstreamReady === false
      ? "等待发送"
      : connection === "live"
        ? "已连接"
        : connection === "reconnecting"
          ? "连接重试中"
          : connection === "ended"
            ? "连接已结束"
            : "连接中";
  const connectionTone: BadgeTone =
    connection === "live"
      ? "success"
      : connection === "reconnecting"
        ? "warning"
        : connection === "ended"
          ? "danger"
          : "neutral";
  const composerError = feedback?.kind === "error";
  const status = taskStatus(session, latestTurn, timeline.items);
  const messageRevision = JSON.stringify([timeline.items, session.submissions]);

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
              {status.label !== "确认中" ? (
                <Badge tone={status.tone}>{status.label}</Badge>
              ) : null}
              <span
                className={`session-connection session-connection--${connectionTone}`}
              >
                {connectionLabel}
              </span>
            </div>
          </div>
          <div className="session-header-actions">
            {session.deletionState === "none" ? (
              <Button
                variant="secondary"
                size="compact"
                onClick={createFollowUp}
                disabled={pendingAction !== null}
              >
                新建后续任务
              </Button>
            ) : null}
            {canStopTask(session) ? (
              <Button
                variant="secondary"
                size="compact"
                aria-label="停止任务"
                onClick={() => void interrupt()}
                loading={pendingAction === "interrupt"}
                disabled={pendingAction !== null}
              >
                {pendingAction === "interrupt" ? (
                  <Spinner size={14} aria-hidden="true" />
                ) : (
                  <Square size={14} aria-hidden="true" />
                )}
                停止
              </Button>
            ) : null}
            {session.deletionState !== "none" ? null : session.archivedAt ? (
              <Button
                variant="secondary"
                size="compact"
                aria-label="恢复任务"
                onClick={() => void toggleArchive()}
                loading={pendingAction === "archive"}
                disabled={pendingAction !== null}
              >
                {pendingAction === "archive" ? (
                  <Spinner size={14} aria-hidden="true" />
                ) : (
                  <RotateCcw size={14} aria-hidden="true" />
                )}
                恢复
              </Button>
            ) : (
              <div ref={actionMenuRef} className="action-menu">
                <IconButton
                  label="任务操作"
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
                      归档任务
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
                      永久删除任务
                    </Button>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </header>

        <div className="session-body" onClick={handleSessionBodyClick}>
          {session.inputs.length > 0 ? (
            <div className="session-inputs" aria-label="任务材料">
              <Paperclip size={15} aria-hidden="true" />
              {session.inputs.map((input) => (
                <span key={input.id}>{input.name}</span>
              ))}
            </div>
          ) : null}

          {session.deletionState === "pending" ? (
            <Alert className="session-deletion-alert" tone="warning">
              <div className="session-deletion-alert__copy">
                <strong>正在永久删除</strong>
                <span>后台清理完成后，任务将被移除。</span>
              </div>
            </Alert>
          ) : session.deletionState === "deletion_failed" ? (
            <Alert className="session-deletion-alert" tone="danger">
              <div className="session-deletion-alert__copy">
                <strong>永久删除失败</strong>
                <span>后台清理尚未完成。</span>
              </div>
            </Alert>
          ) : null}

          <NewMessages revision={messageRevision}>
            {session.deletionState === "none" &&
            (session.historyState?.repairRequired || historyError) ? (
              <Alert tone="warning">
                <strong>会话历史待修复</strong>
                <p>
                  {historyError ??
                    "实时消息仍可查看，后台正在补齐历史。完整导出需等待同步成功。"}
                </p>
                <Button
                  variant="secondary"
                  size="compact"
                  onClick={() => void retryHistoryExport()}
                  loading={pendingAction === "history"}
                  disabled={pendingAction !== null}
                >
                  重试同步并导出
                </Button>
              </Alert>
            ) : null}

            {session.deletionState === "none" &&
            session.status === "failed" &&
            !visibleTurn ? (
              <Alert tone="danger">
                执行失败
                {session.error?.code
                  ? `（${session.error.code}）`
                  : "，原因尚未确认"}
                。 请刷新状态后重试，或携带摘要创建后续任务。
              </Alert>
            ) : null}

            {session.deletionState === "none" && visibleTurn ? (
              <TurnStatus
                turn={visibleTurn}
                hasAnswer={hasSavedTurnAnswer(
                  visibleTurn,
                  blocks,
                  timeline.items,
                )}
                onRecover={() => void recoverTurn()}
                recovering={pendingAction === "turn"}
                disabled={pendingAction !== null}
              />
            ) : null}

            {session.submissions
              ?.filter(
                (item) =>
                  item.status !== "accepted" ||
                  !item.upstreamEventId ||
                  !timeline.items.some(
                    (event) =>
                      event.kind === "user" &&
                      event.id === item.upstreamEventId,
                  ),
              )
              .map((item) => (
                <div key={item.submissionId} className="submission-message">
                  {(item.content || item.acceptedContent) &&
                  !timeline.items.some(
                    (event) =>
                      event.kind === "user" &&
                      event.id === item.upstreamEventId,
                  ) ? (
                    <div
                      className="transcript__row transcript__row--user"
                      data-submission-id={item.submissionId}
                    >
                      <UserMessage
                        text={item.content ?? item.acceptedContent ?? ""}
                      />
                    </div>
                  ) : null}
                  <p className="submission-message__status" role="status">
                    {item.status === "unknown"
                      ? "正在核实消息发送结果，请勿重复发送。"
                      : item.status === "failed"
                        ? "消息发送失败。"
                        : item.status === "accepted"
                          ? "消息已接受。"
                          : "消息已排队。"}
                  </p>
                  <details className="submission-message__details">
                    <summary>发送详情</summary>
                    <span>
                      请求号：<code>{item.submissionId}</code>
                    </span>
                    {item.errorCode ? (
                      <span>
                        错误码：<code>{item.errorCode}</code>
                      </span>
                    ) : null}
                  </details>
                </div>
              ))}
            <Transcript
              blocks={blocks}
              showEmptyState={!session.submissions?.length}
            />
          </NewMessages>
        </div>

        <SessionComposer
          key={`${userId}:${sessionId}`}
          draftKey={`${userId}:${sessionId}`}
          disabled={messageDisabled}
          pendingAction={pendingAction}
          feedback={feedback}
          onSend={sendMessage}
          onAttach={createFollowUp}
        />

        <Dialog
          open={deleteOpen}
          title="永久删除任务？"
          onClose={closeDeleteDialog}
          closeLabel="关闭删除确认"
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
                取消
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
                永久删除
              </Button>
            </>
          }
        >
          <div className="session-delete-dialog">
            <p>
              此操作将删除任务、消息历史与生成的成果，无法撤销。此前形成的记忆会保留，
              可在设置中的记忆页面单独管理；删除不会创建新的对话副本。
            </p>
            <Field label="输入 DELETE 确认">
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
          onClose={() => selectArtifact(null)}
          width={railWidth}
          onWidthChange={onRailWidthChange}
        />
      ) : null}
    </div>
  );
}

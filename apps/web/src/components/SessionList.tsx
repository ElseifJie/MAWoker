import {
  Archive,
  Download,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  RotateCcw,
  Trash2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { NavLink } from "react-router-dom";
import {
  ApiClientError,
  apiClient,
  type SessionStatus,
  type SessionSummary,
} from "../api.js";
import {
  downloadMarkdown,
  transcriptFilename,
  transcriptMarkdown,
} from "../exportTranscript.js";
import {
  Button,
  Dialog,
  Field,
  IconButton,
  Input,
  Spinner,
} from "../ui/index.js";

const statusLabels: Record<SessionStatus, string> = {
  idle: "待开始",
  running: "执行中",
  rescheduled: "等待重试",
  initializing: "准备中",
  upgrading: "准备中",
  failed: "执行失败",
  terminated: "已结束",
};

export interface SessionGroup {
  key: string;
  label: string;
  sessions: SessionSummary[];
}

function lastActivity(session: SessionSummary): number {
  const stamp = session.lastEventAt ?? session.updatedAt ?? session.createdAt;
  const parsed = Date.parse(stamp);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function startOfDay(value: Date): number {
  return new Date(
    value.getFullYear(),
    value.getMonth(),
    value.getDate(),
  ).getTime();
}

/**
 * Time buckets over each Session's most recent activity, which is what "recent"
 * means for a task list. The exact boundaries are computed once per render so a
 * long list cannot straddle midnight mid-grouping.
 */
export function groupSessions(
  sessions: readonly SessionSummary[],
  now: Date,
): SessionGroup[] {
  const today = startOfDay(now);
  const day = 24 * 60 * 60 * 1_000;
  const buckets: SessionGroup[] = [
    { key: "today", label: "今天", sessions: [] },
    { key: "yesterday", label: "昨天", sessions: [] },
    { key: "week", label: "最近 7 天", sessions: [] },
    { key: "older", label: "更早", sessions: [] },
  ];
  for (const session of sessions) {
    const at = lastActivity(session);
    if (at >= today) buckets[0]!.sessions.push(session);
    else if (at >= today - day) buckets[1]!.sessions.push(session);
    else if (at >= today - 7 * day) buckets[2]!.sessions.push(session);
    else buckets[3]!.sessions.push(session);
  }
  return buckets.filter((bucket) => bucket.sessions.length > 0);
}

export function matchesQuery(session: SessionSummary, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return session.title.toLowerCase().includes(needle);
}

interface SessionMenuProps {
  session: SessionSummary;
  busy: boolean;
  onRename: () => void;
  onExport: () => void;
  onTogglePin: () => void;
  onToggleArchive: () => void;
  onDelete: () => void;
}

function SessionMenu({
  session,
  busy,
  onRename,
  onExport,
  onTogglePin,
  onToggleArchive,
  onDelete,
}: SessionMenuProps) {
  const [open, setOpen] = useState(false);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>();
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const trigger = containerRef.current?.querySelector<HTMLElement>("button");
    if (trigger) {
      const rect = trigger.getBoundingClientRect();
      const menuHeight =
        panelRef.current?.getBoundingClientRect().height || 280;
      const opensUp = rect.bottom + menuHeight + 12 > window.innerHeight;
      const preferredTop = opensUp
        ? rect.top - menuHeight - 4
        : rect.bottom + 4;
      setPanelStyle({
        top: Math.max(
          8,
          Math.min(preferredTop, window.innerHeight - menuHeight - 8),
        ),
        right: Math.max(8, window.innerWidth - rect.right),
      });
    }
    panelRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      containerRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    };
    // The panel is viewport-anchored, so any scroll would leave it detached.
    const close = (event: Event) => {
      if (
        event.target instanceof Node &&
        panelRef.current?.contains(event.target)
      )
        return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  const run = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  return (
    <div
      className="session-row__menu"
      ref={containerRef}
      onClick={(event) => event.preventDefault()}
    >
      <IconButton
        className="session-row__menu-trigger"
        label={`任务操作：${session.title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        size="small"
        onClick={() => setOpen((current) => !current)}
      >
        <MoreHorizontal size={15} aria-hidden="true" />
      </IconButton>
      {open ? (
        <div
          className="session-menu"
          role="menu"
          ref={panelRef}
          style={panelStyle}
        >
          <div className="session-menu__title">{session.title}</div>
          <button
            type="button"
            role="menuitem"
            className="session-menu__item"
            onClick={run(onRename)}
          >
            <Pencil size={14} aria-hidden="true" />
            重命名
          </button>
          <button
            type="button"
            role="menuitem"
            className="session-menu__item"
            onClick={run(onExport)}
          >
            <Download size={14} aria-hidden="true" />
            导出
          </button>
          <button
            type="button"
            role="menuitem"
            className="session-menu__item"
            onClick={run(onTogglePin)}
          >
            {session.pinnedAt ? (
              <PinOff size={14} aria-hidden="true" />
            ) : (
              <Pin size={14} aria-hidden="true" />
            )}
            {session.pinnedAt ? "取消置顶" : "置顶"}
          </button>
          <button
            type="button"
            role="menuitem"
            className="session-menu__item"
            disabled={busy}
            onClick={run(onToggleArchive)}
          >
            {session.archivedAt ? (
              <RotateCcw size={14} aria-hidden="true" />
            ) : (
              <Archive size={14} aria-hidden="true" />
            )}
            {session.archivedAt ? "恢复" : "归档"}
          </button>
          <button
            type="button"
            role="menuitem"
            className="session-menu__item session-menu__item--danger"
            onClick={run(onDelete)}
          >
            <Trash2 size={14} aria-hidden="true" />
            删除
          </button>
        </div>
      ) : null}
    </div>
  );
}

interface SessionRowProps {
  session: SessionSummary;
  onSessionChanged: (session: SessionSummary) => void;
  onError: (message: string) => void;
  onAuthRequired: () => void;
  onRenamed: (session: SessionSummary) => void;
  onDeleteRequested: (session: SessionSummary) => void;
}

function SessionRow({
  session,
  onSessionChanged,
  onError,
  onAuthRequired,
  onRenamed,
  onDeleteRequested,
}: SessionRowProps) {
  const [busy, setBusy] = useState(false);
  const pinned = Boolean(session.pinnedAt);

  const fail = (error: unknown, operation: string) => {
    if (error instanceof ApiClientError && error.isAuthRequired) {
      onAuthRequired();
      return;
    }
    onError(`${operation}未完成，请重试。`);
  };

  async function togglePin() {
    if (busy) return;
    setBusy(true);
    try {
      onSessionChanged(
        session.pinnedAt
          ? await apiClient.unpinSession(session.id)
          : await apiClient.pinSession(session.id),
      );
    } catch (error) {
      fail(error, session.pinnedAt ? "取消置顶" : "置顶");
    } finally {
      setBusy(false);
    }
  }

  async function toggleArchive() {
    if (busy) return;
    setBusy(true);
    try {
      onSessionChanged(
        session.archivedAt
          ? await apiClient.restoreSession(session.id)
          : await apiClient.archiveSession(session.id),
      );
    } catch (error) {
      fail(error, session.archivedAt ? "恢复" : "归档");
    } finally {
      setBusy(false);
    }
  }

  async function exportTranscript() {
    if (busy) return;
    setBusy(true);
    try {
      const { events } = await apiClient.getSessionTranscript(session.id);
      downloadMarkdown(
        transcriptFilename(session.title),
        transcriptMarkdown(session.title, events),
      );
    } catch (error) {
      fail(error, "导出");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="session-row">
      <NavLink
        to={`/sessions/${session.id}`}
        className={({ isActive }) =>
          `session-row__link${isActive ? " active" : ""}`
        }
        title={session.title}
      >
        {pinned ? (
          <Pin
            className="session-row__pin-indicator"
            size={13}
            aria-hidden="true"
          />
        ) : (
          <span
            className={`session-row__dot session-row__dot--${session.status}`}
            aria-hidden="true"
          />
        )}
        <span className="session-row__title">{session.title}</span>
        <span className="sr-only">
          {pinned ? "已置顶，" : ""}
          {session.archivedAt ? "已归档" : statusLabels[session.status]}
        </span>
      </NavLink>
      {busy ? (
        <span className="session-row__busy">
          <Spinner size={13} aria-hidden="true" />
        </span>
      ) : (
        <SessionMenu
          session={session}
          busy={busy}
          onRename={() => onRenamed(session)}
          onExport={() => void exportTranscript()}
          onTogglePin={() => void togglePin()}
          onToggleArchive={() => void toggleArchive()}
          onDelete={() => onDeleteRequested(session)}
        />
      )}
    </li>
  );
}

export interface SessionListProps {
  sessions: readonly SessionSummary[];
  archivedSessions: readonly SessionSummary[];
  onSessionChanged: (session: SessionSummary) => void;
  onAuthRequired: () => void;
}

/**
 * The Session half of the sidebar: pinned Sessions first, then time buckets,
 * each row carrying its own management menu. Rename, pin, archive and delete
 * live here because a Session list is where you decide what to do with one.
 */
export function SessionList({
  sessions,
  archivedSessions,
  onSessionChanged,
  onAuthRequired,
}: SessionListProps) {
  const [error, setError] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<SessionSummary | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renamePending, setRenamePending] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SessionSummary | null>(null);
  const [deleteDraft, setDeleteDraft] = useState("");
  const [deletePending, setDeletePending] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const renameRef = useRef<HTMLInputElement>(null);
  const deleteRef = useRef<HTMLInputElement>(null);

  const pinned = sessions.filter((session) => Boolean(session.pinnedAt));
  const unpinned = sessions.filter((session) => !session.pinnedAt);
  const groups = groupSessions(unpinned, new Date());

  const clearError = useCallback(() => setError(null), []);

  function openRename(session: SessionSummary) {
    clearError();
    setRenameDraft(session.title);
    setRenameTarget(session);
  }

  function closeRename() {
    if (renamePending) return;
    setRenameTarget(null);
  }

  async function submitRename() {
    const title = renameDraft.trim();
    if (!renameTarget || renamePending || title.length === 0) return;
    setRenamePending(true);
    try {
      onSessionChanged(await apiClient.renameSession(renameTarget.id, title));
      setRenameTarget(null);
    } catch (error) {
      if (error instanceof ApiClientError && error.isAuthRequired) {
        onAuthRequired();
        return;
      }
      setError(
        error instanceof ApiClientError && error.code === "VALIDATION_FAILED"
          ? "名称需为 1 至 120 个字符。"
          : "任务重命名失败，请重试。",
      );
    } finally {
      setRenamePending(false);
    }
  }

  function closeDelete() {
    if (deletePending) return;
    setDeleteTarget(null);
    setDeleteDraft("");
  }

  async function submitDelete() {
    if (!deleteTarget || deletePending || deleteDraft !== "DELETE") return;
    setDeletePending(true);
    try {
      const result = await apiClient.deleteSession(deleteTarget.id);
      onSessionChanged({
        ...deleteTarget,
        deletionState: result.deletionState,
      });
      setDeleteTarget(null);
      setDeleteDraft("");
    } catch (error) {
      if (error instanceof ApiClientError && error.isAuthRequired) {
        onAuthRequired();
        return;
      }
      setError("任务无法删除，请重试。");
      closeDelete();
    } finally {
      setDeletePending(false);
    }
  }

  const onRenameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void submitRename();
    }
  };

  const rowProps = {
    onSessionChanged,
    onError: (message: string) => setError(message),
    onAuthRequired,
    onRenamed: openRename,
    onDeleteRequested: (session: SessionSummary) => {
      clearError();
      setDeleteDraft("");
      setDeleteTarget(session);
    },
  };

  return (
    <div className="session-list">
      {error ? (
        <p className="session-list__error" role="alert">
          {error}
        </p>
      ) : null}

      {pinned.length > 0 ? (
        <section className="session-group" aria-label="置顶任务">
          <h2 className="session-group__label">
            置顶
            <span>{pinned.length}</span>
          </h2>
          <ul className="session-group__list">
            {pinned.map((session) => (
              <SessionRow key={session.id} session={session} {...rowProps} />
            ))}
          </ul>
        </section>
      ) : null}

      {groups.map((group) => (
        <section
          key={group.key}
          className="session-group"
          aria-label={group.label}
        >
          <h2 className="session-group__label">
            {group.label}
            <span>{group.sessions.length}</span>
          </h2>
          <ul className="session-group__list">
            {group.sessions.map((session) => (
              <SessionRow key={session.id} session={session} {...rowProps} />
            ))}
          </ul>
        </section>
      ))}

      {sessions.length === 0 ? (
        <p className="session-list__empty">还没有任务</p>
      ) : null}

      {archivedSessions.length > 0 ? (
        <section
          className="session-group session-group--archived"
          aria-label="已归档任务"
        >
          <h2 className="session-group__label">
            <button
              type="button"
              className="session-group__toggle"
              aria-expanded={showArchived}
              onClick={() => setShowArchived((current) => !current)}
            >
              已归档
              <span>{archivedSessions.length}</span>
            </button>
          </h2>
          {showArchived ? (
            <ul className="session-group__list">
              {archivedSessions.map((session) => (
                <SessionRow key={session.id} session={session} {...rowProps} />
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      <Dialog
        open={renameTarget !== null}
        title="重命名任务"
        onClose={closeRename}
        closeLabel="关闭重命名"
        closeDisabled={renamePending}
        initialFocusRef={renameRef}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={closeRename}
              disabled={renamePending}
            >
              取消
            </Button>
            <Button
              onClick={() => void submitRename()}
              loading={renamePending}
              disabled={renamePending || renameDraft.trim().length === 0}
            >
              保存名称
            </Button>
          </>
        }
      >
        <Field label="任务名称">
          <Input
            ref={renameRef}
            value={renameDraft}
            maxLength={120}
            onChange={(event) => setRenameDraft(event.target.value)}
            onKeyDown={onRenameKeyDown}
          />
        </Field>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        title="永久删除任务？"
        onClose={closeDelete}
        closeLabel="关闭删除确认"
        closeDisabled={deletePending}
        initialFocusRef={deleteRef}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={closeDelete}
              disabled={deletePending}
            >
              取消
            </Button>
            <Button
              variant="danger"
              loading={deletePending}
              disabled={deletePending || deleteDraft !== "DELETE"}
              onClick={() => void submitDelete()}
            >
              永久删除
            </Button>
          </>
        }
      >
        <div className="session-delete-dialog">
          <p>
            此操作将删除 <strong>{deleteTarget?.title}</strong>
            、消息历史及成果，无法撤销。
            此前形成的记忆会保留，可在个人记忆页面单独管理；删除不会创建对话副本。
          </p>
          <Field label="输入 DELETE 确认">
            <Input
              ref={deleteRef}
              value={deleteDraft}
              autoComplete="off"
              onChange={(event) => setDeleteDraft(event.target.value)}
            />
          </Field>
        </div>
      </Dialog>
    </div>
  );
}

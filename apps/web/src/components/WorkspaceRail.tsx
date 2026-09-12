import {
  CheckCircle2,
  Circle,
  CircleDot,
  FileText,
  ListTodo,
  Package,
  X,
} from "lucide-react";
import {
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { TodoEntry } from "@pwa/contracts";
import type { ArtifactSummary } from "../api.js";
import { Button, IconButton } from "../ui/index.js";
import { ArtifactViewer } from "./ArtifactViewer.js";

export const RAIL_MIN_WIDTH = 280;
export const RAIL_MAX_WIDTH = 720;
export const RAIL_DEFAULT_WIDTH = 340;
const RAIL_KEYBOARD_STEP = 24;

const todoIcons = {
  pending: Circle,
  in_progress: CircleDot,
  completed: CheckCircle2,
} as const;

const todoLabels = {
  pending: "Pending",
  in_progress: "In progress",
  completed: "Completed",
} as const;

export interface WorkspaceRailProps {
  todos: TodoEntry[];
  artifacts: readonly ArtifactSummary[];
  artifactsError: boolean;
  /** The last refresh of the Agent's output folder failed; the list may be stale. */
  artifactsSyncError?: boolean;
  onRetryArtifacts: () => void;
  selectedArtifactId: string | null;
  onSelectArtifact: (artifactId: string | null) => void;
  closeLabel?: string;
  onClose?: () => void;
  /** Panel width in pixels; clamped to the exported min/max while dragging. */
  width?: number;
  onWidthChange?: (width: number) => void;
}

/**
 * The session's third column: the Agent's own task list plus the files it
 * produced. Progress comes from `todo_write`, so it reports what the Agent
 * committed to rather than a guess derived from event counts.
 *
 * Presentational only — the page owns the fetch and the URL-addressed selection,
 * so the collapsed panel's count in the topbar and this list cannot disagree.
 */
export function WorkspaceRail({
  todos,
  artifacts,
  artifactsError,
  artifactsSyncError = false,
  onRetryArtifacts,
  selectedArtifactId,
  onSelectArtifact,
  closeLabel = "Hide side panel",
  onClose,
  width,
  onWidthChange,
}: WorkspaceRailProps) {
  const done = todos.filter((todo) => todo.status === "completed").length;
  const selected =
    artifacts.find((artifact) => artifact.id === selectedArtifactId) ?? null;
  const asideRef = useRef<HTMLElement>(null);
  const dragWidthRef = useRef(0);
  const [dragging, setDragging] = useState(false);
  const resizable = Boolean(onWidthChange);

  const clampWidth = (value: number) =>
    Math.min(RAIL_MAX_WIDTH, Math.max(RAIL_MIN_WIDTH, value));

  function widthFromPointer(event: ReactPointerEvent<HTMLDivElement>) {
    // The panel is anchored right, so its width is the gap from the pointer to
    // the viewport's right edge.
    return clampWidth(window.innerWidth - event.clientX);
  }

  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!resizable) return;
    event.preventDefault();
    dragWidthRef.current = asideRef.current?.offsetWidth ?? RAIL_MIN_WIDTH;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  }

  function onResizeMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    const next = widthFromPointer(event);
    dragWidthRef.current = next;
    onWidthChange?.(next);
  }

  function endResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragging(false);
  }

  function onResizeKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!resizable) return;
    const current = dragWidthRef.current || width || RAIL_MIN_WIDTH;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      dragWidthRef.current = clampWidth(current + RAIL_KEYBOARD_STEP);
      onWidthChange?.(dragWidthRef.current);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      dragWidthRef.current = clampWidth(current - RAIL_KEYBOARD_STEP);
      onWidthChange?.(dragWidthRef.current);
    }
  }

  return (
    <aside
      ref={asideRef}
      className="workspace-rail"
      aria-label="Session side panel"
      {...(width ? { style: { width: `${width}px` } } : {})}
    >
      {resizable ? (
        <div
          className={`workspace-rail__resizer${dragging ? " is-dragging" : ""}`}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize side panel"
          aria-valuemin={RAIL_MIN_WIDTH}
          aria-valuemax={RAIL_MAX_WIDTH}
          aria-valuenow={width ?? RAIL_MIN_WIDTH}
          tabIndex={0}
          onPointerDown={startResize}
          onPointerMove={onResizeMove}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onKeyDown={onResizeKeyDown}
        />
      ) : null}
      <div className="workspace-rail__scroll">
        <header className="workspace-rail__header">
          <h2>
            <ListTodo size={16} aria-hidden="true" />
            Progress
          </h2>
          {todos.length > 0 ? (
            <span className="workspace-rail__count">
              {done}/{todos.length}
            </span>
          ) : null}
          {onClose ? (
            <IconButton
              className="workspace-rail__close"
              label={closeLabel}
              size="small"
              onClick={onClose}
            >
              <X size={15} aria-hidden="true" />
            </IconButton>
          ) : null}
        </header>

        {todos.length === 0 ? (
          <p className="workspace-rail__empty">No plan yet.</p>
        ) : (
          <ol className="workspace-rail__todos">
            {todos.map((todo, index) => {
              const Icon = todoIcons[todo.status];
              return (
                <li
                  key={`${todo.status}-${index}-${todo.content.slice(0, 24)}`}
                  className={`todo todo--${todo.status}`}
                >
                  <Icon size={15} aria-hidden="true" />
                  <span className="todo__content">{todo.content}</span>
                  <span className="sr-only">{todoLabels[todo.status]}</span>
                </li>
              );
            })}
          </ol>
        )}

        <header className="workspace-rail__header workspace-rail__header--artifacts">
          <h2>
            <Package size={16} aria-hidden="true" />
            Artifacts
          </h2>
          {artifacts.length > 0 ? (
            <span className="workspace-rail__count">{artifacts.length}</span>
          ) : null}
        </header>

        {artifactsSyncError && !artifactsError ? (
          <p className="workspace-rail__stale" role="status">
            New files could not be checked.{" "}
            <button
              type="button"
              className="workspace-rail__stale-retry"
              onClick={onRetryArtifacts}
            >
              Retry
            </button>
          </p>
        ) : null}

        {artifactsError ? (
          <div className="workspace-rail__empty">
            <p>Artifacts could not be loaded.</p>
            <Button
              variant="secondary"
              size="compact"
              onClick={onRetryArtifacts}
            >
              Retry
            </Button>
          </div>
        ) : artifacts.length === 0 ? (
          <p className="workspace-rail__empty">No files yet.</p>
        ) : (
          <ul className="workspace-rail__artifacts">
            {artifacts.map((artifact) => (
              <li key={artifact.id}>
                <button
                  type="button"
                  className="artifact-link"
                  aria-current={artifact.id === selectedArtifactId || undefined}
                  onClick={() =>
                    onSelectArtifact(
                      artifact.id === selectedArtifactId ? null : artifact.id,
                    )
                  }
                >
                  <FileText size={15} aria-hidden="true" />
                  <span className="artifact-link__name" title={artifact.name}>
                    {artifact.name}
                  </span>
                  {artifact.deletionState !== "none" ? (
                    <span className="artifact-link__state">Deleting</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {selected ? (
        <ArtifactViewer
          artifact={selected}
          onClose={() => onSelectArtifact(null)}
        />
      ) : null}
    </aside>
  );
}

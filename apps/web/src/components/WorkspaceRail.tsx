import {
  CheckCircle2,
  Circle,
  CircleDot,
  FileText,
  ListTodo,
  Package,
  X,
} from "lucide-react";
import type { TodoEntry } from "@pwa/contracts";
import type { ArtifactSummary } from "../api.js";
import { Button, IconButton } from "../ui/index.js";
import { ArtifactViewer } from "./ArtifactViewer.js";

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
  onRetryArtifacts: () => void;
  selectedArtifactId: string | null;
  onSelectArtifact: (artifactId: string | null) => void;
  closeLabel?: string;
  onClose?: () => void;
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
  onRetryArtifacts,
  selectedArtifactId,
  onSelectArtifact,
  closeLabel = "Hide side panel",
  onClose,
}: WorkspaceRailProps) {
  const done = todos.filter((todo) => todo.status === "completed").length;
  const selected =
    artifacts.find((artifact) => artifact.id === selectedArtifactId) ?? null;

  return (
    <aside className="workspace-rail" aria-label="Session side panel">
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
        <p className="workspace-rail__empty">
          No plan reported yet. The Agent&rsquo;s task list appears here once it
          writes one.
        </p>
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

      {artifactsError ? (
        <div className="workspace-rail__empty">
          <p>Artifacts could not be loaded.</p>
          <Button variant="secondary" size="compact" onClick={onRetryArtifacts}>
            Retry
          </Button>
        </div>
      ) : artifacts.length === 0 ? (
        <p className="workspace-rail__empty">
          No files yet. Anything the Agent writes to its output folder appears
          here.
        </p>
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

      {selected ? (
        <ArtifactViewer
          artifact={selected}
          onClose={() => onSelectArtifact(null)}
        />
      ) : null}
    </aside>
  );
}

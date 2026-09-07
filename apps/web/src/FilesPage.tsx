import { Download, FileText, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  ApiClientError,
  apiClient,
  type ArtifactSummary,
  type SessionSummary,
} from "./api.js";
import {
  Alert,
  Badge,
  Button,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  PageHeader,
  Select,
  Spinner,
} from "./ui/index.js";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    return `${Math.round((bytes / 1024) * 10) / 10} KB`;
  }
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

export function FilesPage({
  sessions,
  onAuthRequired,
}: {
  sessions: SessionSummary[];
  onAuthRequired: () => void;
}) {
  const [sessionId, setSessionId] = useState("");
  const [knownSessionIds, setKnownSessionIds] = useState(() =>
    sessions.map((session) => session.id),
  );
  const [artifacts, setArtifacts] = useState<ArtifactSummary[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<ArtifactSummary | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const pageHeadingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let active = true;
    setLoadError(false);
    setArtifacts(null);
    void apiClient
      .listArtifacts(sessionId || undefined)
      .then((response) => {
        if (active) {
          setArtifacts(response.artifacts);
          setKnownSessionIds((current) => [
            ...new Set([
              ...current,
              ...response.artifacts.map((artifact) => artifact.sessionId),
            ]),
          ]);
        }
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

  async function requestDeletion() {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setFeedback(null);
    try {
      const result = await apiClient.deleteArtifact(deleteTarget.id);
      setArtifacts(
        (current) =>
          current?.map((artifact) =>
            artifact.id === result.id
              ? { ...artifact, deletionState: result.deletionState }
              : artifact,
          ) ?? null,
      );
      setDeleteTarget(null);
    } catch (error) {
      if (error instanceof ApiClientError && error.isAuthRequired) {
        onAuthRequired();
      } else {
        setFeedback("The artifact could not be deleted. Try again.");
        setDeleteTarget(null);
      }
    } finally {
      setDeleting(false);
    }
  }

  const sessionNames = new Map(
    sessions.map((session) => [session.id, session.title]),
  );

  return (
    <div className="page">
      <PageHeader
        eyebrow="Workspace"
        title="My files"
        description="Agent-generated artifacts from your Sessions."
        headingRef={pageHeadingRef}
        actions={
          <div className="artifact-filter">
            <Field label="Filter by Session">
              <Select
                value={sessionId}
                onChange={(event) => setSessionId(event.target.value)}
              >
                <option value="">All Sessions</option>
                {knownSessionIds.map((knownSessionId) => (
                  <option key={knownSessionId} value={knownSessionId}>
                    {sessionNames.get(knownSessionId) ??
                      `Session ${knownSessionId.slice(0, 8)}`}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        }
      />

      {feedback ? (
        <Alert className="artifact-feedback" tone="danger">
          {feedback}
        </Alert>
      ) : null}

      {loadError ? (
        <EmptyState
          title="Artifacts could not be loaded."
          action={
            <Button
              variant="secondary"
              onClick={() => setReloadKey((key) => key + 1)}
            >
              Retry
            </Button>
          }
        />
      ) : artifacts === null ? (
        <EmptyState
          className="artifact-loading-state"
          title="Loading artifacts…"
          action={<Spinner label="Loading artifacts" />}
        />
      ) : artifacts.length === 0 ? (
        <EmptyState title="No Agent artifacts found." />
      ) : (
        <ul className="artifact-list" aria-label="Agent artifacts">
          {artifacts.map((artifact) => {
            const source =
              sessionNames.get(artifact.sessionId) ??
              `Session ${artifact.sessionId.slice(0, 8)}`;
            return (
              <li key={artifact.id} className="artifact-record">
                <span className="artifact-record__icon" aria-hidden="true">
                  <FileText size={18} />
                </span>
                <div className="artifact-record__file">
                  <strong>{artifact.name}</strong>
                  <div className="artifact-record__metadata">
                    <span>{artifact.mimeType}</span>
                    <span>{formatBytes(artifact.sizeBytes)}</span>
                  </div>
                </div>
                <div className="artifact-record__source">
                  <span>{source}</span>
                  <time dateTime={artifact.generatedAt}>
                    {formatDate(artifact.generatedAt)}
                  </time>
                </div>
                <div className="artifact-record__actions">
                  {artifact.deletionState === "pending" ? (
                    <Badge tone="warning">Deletion pending</Badge>
                  ) : artifact.deletionState === "deletion_failed" ? (
                    <Badge tone="danger">Deletion failed</Badge>
                  ) : (
                    <>
                      <a
                        className="ui-icon-button ui-icon-button--small"
                        href={`/api/v1/artifacts/${encodeURIComponent(artifact.id)}/download`}
                        aria-label={`Download ${artifact.name}`}
                        title={`Download ${artifact.name}`}
                        download
                      >
                        <Download size={16} aria-hidden="true" />
                      </a>
                      <IconButton
                        size="small"
                        className="artifact-record__delete"
                        label={`Delete ${artifact.name}`}
                        onClick={() => setDeleteTarget(artifact)}
                      >
                        <Trash2 size={15} aria-hidden="true" />
                      </IconButton>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Dialog
        open={deleteTarget !== null}
        title="Delete artifact?"
        onClose={() => setDeleteTarget(null)}
        closeLabel="Close artifact deletion"
        closeDisabled={deleting}
        fallbackFocusRef={pageHeadingRef}
        footer={
          deleteTarget ? (
            <>
              <Button
                data-dialog-initial-focus
                variant="secondary"
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                loading={deleting}
                onClick={() => void requestDeletion()}
              >
                Delete artifact
              </Button>
            </>
          ) : null
        }
      >
        {deleteTarget ? (
          <p className="artifact-dialog-copy">
            Delete <strong>{deleteTarget.name}</strong> permanently. This cannot
            be undone.
          </p>
        ) : null}
      </Dialog>
    </div>
  );
}

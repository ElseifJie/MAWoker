import { useEffect, useState } from "react";
import { ApiClientError, apiClient, type ArtifactSummary } from "../api.js";
import type { PanelDescriptor } from "../shell/shell-state.js";
import { Alert, Button, Spinner } from "../ui/index.js";
import { ArtifactViewer } from "./ArtifactViewer.js";

interface ArtifactListResult {
  artifacts: ArtifactSummary[];
}

/**
 * StrictMode mounts effects twice in development. Sharing the in-flight list
 * request keeps that replay to one network call without caching stale results
 * after the request settles.
 */
const inFlightArtifactLists = new Map<string, Promise<ArtifactListResult>>();

function loadArtifactList(
  sessionId: string,
  loader: (sessionId: string) => Promise<ArtifactListResult>,
): Promise<ArtifactListResult> {
  const existing = inFlightArtifactLists.get(sessionId);
  if (existing) return existing;
  const request = loader(sessionId).finally(() => {
    inFlightArtifactLists.delete(sessionId);
  });
  inFlightArtifactLists.set(sessionId, request);
  return request;
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; artifact: ArtifactSummary }
  | { status: "missing" }
  | { status: "error" };

export interface ArtifactPanelProps {
  panel: PanelDescriptor;
  onClose(): void;
  onAuthRequired?(): void;
  listArtifacts?: (sessionId: string) => Promise<ArtifactListResult>;
}

/**
 * Hosts one artifact inside the workspace panel. The panel descriptor carries
 * only the session and artifact ids, so restores after a refresh re-fetch the
 * authoritative list instead of persisting a stale preview.
 */
export function ArtifactPanel({
  panel,
  onClose,
  onAuthRequired,
  listArtifacts = apiClient.listArtifacts,
}: ArtifactPanelProps) {
  const sessionId = panel.conversationId;
  const artifactId = panel.resourceRef;
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!sessionId || !artifactId) {
      setState({ status: "missing" });
      return;
    }
    let active = true;
    setState({ status: "loading" });
    loadArtifactList(sessionId, listArtifacts)
      .then(({ artifacts }) => {
        if (!active) return;
        const artifact = artifacts.find((item) => item.id === artifactId);
        setState(
          artifact ? { status: "ready", artifact } : { status: "missing" },
        );
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof ApiClientError && error.isAuthRequired) {
          onAuthRequired?.();
          return;
        }
        setState({ status: "error" });
      });
    return () => {
      active = false;
    };
  }, [artifactId, listArtifacts, onAuthRequired, reloadKey, sessionId]);

  if (state.status === "loading") {
    return (
      <div className="artifact-panel__state" aria-busy="true">
        <Spinner label="加载文件预览" />
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="artifact-panel__state">
        <Alert tone="danger">文件预览加载失败，请重试。</Alert>
        <Button
          variant="secondary"
          onClick={() => setReloadKey((key) => key + 1)}
        >
          重试
        </Button>
      </div>
    );
  }

  if (state.status === "missing") {
    return (
      <div className="artifact-panel__state">
        <p>文件不存在或已被删除。</p>
        <Button variant="secondary" onClick={onClose}>
          关闭
        </Button>
      </div>
    );
  }

  return <ArtifactViewer artifact={state.artifact} onClose={onClose} />;
}

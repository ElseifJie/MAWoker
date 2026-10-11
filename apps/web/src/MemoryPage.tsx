import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, FileText, Folder } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  ApiClientError,
  apiClient,
  type MemoryEntry,
  type MemoryList,
  type MemoryState,
} from "./api.js";
import {
  Alert,
  Badge,
  Button,
  DataTable,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Spinner,
  Textarea,
} from "./ui/index.js";

function ongoing(state: MemoryState | null) {
  return !!state?.run && !["completed", "failed"].includes(state.run.stage);
}

function memoryError(error: unknown): string {
  if (error instanceof ApiClientError) {
    switch (error.code) {
      case "MEMORY_BUSY":
        return "Memory is busy. Wait for the current operation.";
      case "MEMORY_CONFLICT":
        return "Memory content changed. Reload before editing.";
      case "MEMORY_INVALID":
        return "Check the path and content. Credentials cannot be stored in memory.";
      case "MEMORY_CAPACITY":
        return "Memory capacity exceeded. Use smaller entries or compress your memory.";
      case "MEMORY_REPAIR_REQUIRED":
        return "Memory requires repair. Contact support.";
    }
  }
  return "Memory could not be loaded or updated. Retry when your connection is available.";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(kib < 10 ? 1 : 0)} KB`;
  return `${(kib / 1024).toFixed(1)} MB`;
}

function formatDateTime(value: string | null): string {
  return value ? `${value.slice(0, 10)} ${value.slice(11, 19)}` : "—";
}

interface PathNode {
  name: string;
  path: string;
  folder: boolean;
  children: PathNode[];
}

function buildPathTree(paths: string[]): PathNode[] {
  const roots: PathNode[] = [];
  for (const path of paths) {
    const parts = path.split("/").filter(Boolean);
    let level = roots;
    let prefix = "";
    for (const [index, part] of parts.entries()) {
      prefix += `/${part}`;
      const folder = index < parts.length - 1;
      let node = level.find((candidate) => candidate.name === part);
      if (!node) {
        node = { name: part, path: prefix, folder, children: [] };
        level.push(node);
      }
      if (folder) level = node.children;
    }
  }
  const sort = (nodes: PathNode[]): PathNode[] => {
    nodes.sort((a, b) =>
      a.folder === b.folder ? a.name.localeCompare(b.name) : a.folder ? -1 : 1,
    );
    for (const node of nodes) if (node.folder) sort(node.children);
    return nodes;
  };
  return sort(roots);
}

function PathTree({
  nodes,
  selectedPath,
  disabled,
  onSelect,
}: {
  nodes: PathNode[];
  selectedPath: string | null;
  disabled: boolean;
  onSelect: (node: PathNode) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const render = (level: PathNode[]) =>
    level.map((node) =>
      node.folder ? (
        <div key={node.path}>
          <button
            type="button"
            className="memory-tree__row memory-tree__row--folder"
            onClick={() =>
              setCollapsed((current) => {
                const next = new Set(current);
                if (next.has(node.path)) next.delete(node.path);
                else next.add(node.path);
                return next;
              })
            }
          >
            {collapsed.has(node.path) ? (
              <ChevronRight size={14} aria-hidden="true" />
            ) : (
              <ChevronDown size={14} aria-hidden="true" />
            )}
            <Folder size={14} aria-hidden="true" />
            <span>{node.name}</span>
          </button>
          {!collapsed.has(node.path) ? render(node.children) : null}
        </div>
      ) : (
        <button
          key={node.path}
          type="button"
          disabled={disabled}
          className={
            selectedPath === node.path
              ? "memory-tree__row memory-tree__row--file is-selected"
              : "memory-tree__row memory-tree__row--file"
          }
          onClick={() => onSelect(node)}
        >
          <FileText size={14} aria-hidden="true" />
          <span>{node.name}</span>
        </button>
      ),
    );
  return <div className="memory-tree__nodes">{render(nodes)}</div>;
}

export function MemoryPage({ onAuthRequired }: { onAuthRequired: () => void }) {
  const location = useLocation();
  const detailView = location.pathname === "/context/store";
  return detailView ? (
    <MemoryStoreDetail onAuthRequired={onAuthRequired} />
  ) : (
    <MemoryStoreList onAuthRequired={onAuthRequired} />
  );
}

function MemoryStoreList({ onAuthRequired }: { onAuthRequired: () => void }) {
  const navigate = useNavigate();
  const [list, setList] = useState<MemoryList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const authRef = useRef(onAuthRequired);
  authRef.current = onAuthRequired;
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setError(null);
    apiClient
      .listMemory()
      .then((result) => {
        if (active) setList(result);
      })
      .catch((loadError) => {
        if (!active) return;
        if (loadError instanceof ApiClientError && loadError.isAuthRequired)
          authRef.current();
        else setError(memoryError(loadError));
      });
    return () => {
      active = false;
    };
  }, [reload]);

  return (
    <div className="page page--wide">
      <PageHeader
        title="Memory Stores"
        description="Persistent memory for Agents, provisioned automatically with your sessions and mounted read-write at runtime."
      />
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {!list ? (
        error ? (
          <EmptyState
            title="Memory Store unavailable"
            action={
              <Button onClick={() => setReload((value) => value + 1)}>
                Retry
              </Button>
            }
          />
        ) : (
          <Spinner label="Loading memory" />
        )
      ) : (
        <DataTable caption="Memory Stores">
          <thead>
            <tr>
              <th scope="col">Name/ID</th>
              <th scope="col">Sessions</th>
              <th scope="col">Memories</th>
              <th scope="col">Storage</th>
              <th scope="col">Updated</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr
              className="memory-store-row"
              onClick={() => navigate("/context/store")}
            >
              <td data-label="Name/ID">
                <span className="memory-store-name">Personal Memory</span>
                <span className="memory-store-id">{list.store.id}</span>
              </td>
              <td data-label="Sessions">
                <span className="memory-store-count">{list.sessionCount}</span>
              </td>
              <td data-label="Memories">{list.capacity.count}</td>
              <td data-label="Storage">{formatBytes(list.capacity.bytes)}</td>
              <td data-label="Updated">
                {formatDateTime(list.store.updatedAt)}
              </td>
              <td data-label="Actions">
                <Button
                  variant="text"
                  onClick={() => navigate("/context/store")}
                >
                  View
                </Button>
              </td>
            </tr>
          </tbody>
        </DataTable>
      )}
    </div>
  );
}

function MemoryStoreDetail({ onAuthRequired }: { onAuthRequired: () => void }) {
  const navigate = useNavigate();
  const [list, setList] = useState<MemoryList | null>(null);
  const [state, setState] = useState<MemoryState | null>(null);
  const [editor, setEditor] = useState<MemoryEntry | null>(null);
  const [existing, setExisting] = useState(false);
  const [pending, setPending] = useState(false);
  const [repairPending, setRepairPending] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const authRef = useRef(onAuthRequired);
  authRef.current = onAuthRequired;
  const accepted = useRef<"Save" | "Delete" | null>(null);
  const alive = useRef(true);

  const handleError = useCallback((loadError: unknown) => {
    if (!alive.current) return;
    if (loadError instanceof ApiClientError && loadError.isAuthRequired)
      authRef.current();
    else setError(memoryError(loadError));
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setError(null);
    apiClient
      .listMemory()
      .then((result) => {
        if (!active) return;
        setList(result);
        setState(result.state);
      })
      .catch(async (loadError) => {
        if (!active) return;
        handleError(loadError);
        // Listing is unavailable while the worker drains/applies; status still works.
        if (
          loadError instanceof ApiClientError &&
          loadError.code === "MEMORY_BUSY"
        ) {
          try {
            const next = await apiClient.getMemoryStatus();
            if (active) setState(next);
          } catch (statusError) {
            if (active) handleError(statusError);
          }
        }
      });
    return () => {
      active = false;
    };
  }, [handleError, reload]);

  const running = ongoing(state);
  useEffect(() => {
    if (!running) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await apiClient.getMemoryStatus();
        if (!active) return;
        if (!ongoing(next)) {
          const result = await apiClient.listMemory();
          if (!active) return;
          setList(result);
          setState(result.state);
          setError(null);
          if (next.run?.stage === "failed") {
            setError(next.run.error ?? "Memory operation failed.");
            setFeedback(null);
          } else if (accepted.current) {
            const action = accepted.current;
            setFeedback(
              action === "Save" ? "Memory saved." : "Memory deleted.",
            );
            if (action === "Save") {
              setEditor(
                (currentEntry) =>
                  result.entries.find(
                    (entry) => entry.path === currentEntry?.path,
                  ) ?? currentEntry,
              );
              setExisting(true);
            }
            if (action === "Delete") {
              setEditor(null);
              setExisting(false);
            }
          }
          accepted.current = null;
          return;
        }
        setState(next);
      } catch (pollError) {
        if (!active) return;
        handleError(pollError);
        if (pollError instanceof ApiClientError && pollError.isAuthRequired)
          return;
      }
      if (active)
        timer = setTimeout(() => {
          void poll();
        }, 2000);
    }
    timer = setTimeout(() => {
      void poll();
    }, 2000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [running, handleError]);

  async function mutate(
    operation: () => Promise<MemoryState>,
    action?: "Save" | "Delete",
  ) {
    if (pending || running || state?.status !== "active") return;
    setPending(true);
    setError(null);
    setFeedback(null);
    try {
      const next = await operation();
      if (!alive.current) return;
      if (action) {
        accepted.current = action;
        setFeedback(
          `${action} queued; ${action === "Save" ? "not saved" : "not deleted"} yet.`,
        );
      }
      setState(next);
    } catch (mutationError) {
      handleError(mutationError);
    } finally {
      if (alive.current) setPending(false);
    }
  }

  async function repair() {
    if (repairPending) return;
    setRepairPending(true);
    setError(null);
    setFeedback(null);
    try {
      const next = await apiClient.recoverMemory();
      if (!alive.current) return;
      setState(next);
      setFeedback("Repair accepted; memory resumes in the background.");
    } catch (repairError) {
      handleError(repairError);
    } finally {
      if (alive.current) setRepairPending(false);
    }
  }

  async function cancelOperation() {
    if (cancelPending) return;
    setCancelPending(true);
    setError(null);
    setFeedback(null);
    try {
      const next = await apiClient.cancelMemory();
      if (!alive.current) return;
      setState(next);
      setFeedback("Operation cancelled.");
      setReload((value) => value + 1);
    } catch (cancelError) {
      handleError(cancelError);
    } finally {
      if (alive.current) setCancelPending(false);
    }
  }

  const blocked = pending || running || state?.status !== "active";
  const entries = list?.entries ?? [];
  const tree = useMemo(
    () => buildPathTree(entries.map((entry) => entry.path)),
    [entries],
  );

  return (
    <div className="page page--wide memory-detail">
      <Button
        variant="text"
        className="memory-back"
        onClick={() => navigate("/context")}
      >
        ‹ Memory Stores
      </Button>

      {error ? <Alert tone="danger">{error}</Alert> : null}
      {feedback ? (
        <Alert tone={running ? "info" : "success"}>{feedback}</Alert>
      ) : null}

      {!list && !error ? <Spinner label="Loading memory" /> : null}

      {state ? (
        <>
          <header className="memory-detail__header">
            <div className="memory-detail__title">
              <h2>Personal Memory</h2>
              <Badge tone={running ? "warning" : "neutral"}>
                {state.status}
              </Badge>
              {running ? (
                <span className="memory-detail__running">
                  Consolidating memories…
                </span>
              ) : null}
            </div>
            <div className="memory-detail__actions">
              <label className="memory-autodream">
                <Input
                  type="checkbox"
                  checked={state.autoDream ?? false}
                  disabled={blocked}
                  onChange={(event) =>
                    void mutate(() =>
                      apiClient.setMemorySettings(event.target.checked),
                    )
                  }
                />
                Auto consolidation
              </label>
              <Button
                variant="secondary"
                disabled={pending}
                onClick={() => setReload((value) => value + 1)}
              >
                Refresh
              </Button>
              {running ? (
                <Button
                  variant="secondary"
                  loading={cancelPending}
                  onClick={() => void cancelOperation()}
                >
                  Cancel
                </Button>
              ) : null}
              {state.status === "repairing" ? (
                <Button
                  variant="secondary"
                  loading={repairPending}
                  onClick={() => void repair()}
                >
                  Repair
                </Button>
              ) : null}
            </div>
          </header>
          <p className="memory-detail__meta">
            <span>
              ID: <span className="memory-mono">{list?.store.id ?? "…"}</span>
            </span>
            {list ? (
              <>
                <span>
                  Memories: {list.capacity.count} (
                  {formatBytes(list.capacity.bytes)})
                </span>
                <span>Sessions: {list.sessionCount}</span>
                <span>Updated: {formatDateTime(list.store.updatedAt)}</span>
              </>
            ) : null}
          </p>
        </>
      ) : null}

      {!list ? (
        error ? (
          <EmptyState
            title="Memory Store unavailable"
            action={
              <Button onClick={() => setReload((value) => value + 1)}>
                Retry
              </Button>
            }
          />
        ) : null
      ) : (
        <div className="memory-detail__body">
          <aside className="memory-tree" aria-label="Memory files">
            <div className="memory-tree__head">
              <span>Files</span>
              <span className="memory-tree__count">{entries.length}</span>
            </div>
            <PathTree
              nodes={tree}
              selectedPath={editor?.path ?? null}
              disabled={pending}
              onSelect={(node) => {
                const entry = entries.find((item) => item.path === node.path);
                if (!entry) return;
                setEditor(entry);
                setExisting(true);
                setFeedback(null);
              }}
            />
            <div className="memory-tree__footer">
              <Button
                variant="text"
                disabled={blocked}
                onClick={() => {
                  setEditor({ path: "", content: "" });
                  setExisting(false);
                  setFeedback(null);
                }}
              >
                + New memory
              </Button>
            </div>
          </aside>

          <section className="memory-editor" aria-label="Memory editor">
            {editor ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void mutate(() => apiClient.writeMemory(editor), "Save");
                }}
              >
                <Field
                  label="Path"
                  hint="Use /memories/, /procedures/, /episodes/, or /resources/."
                >
                  <Input
                    value={editor.path}
                    required
                    maxLength={512}
                    disabled={blocked || existing}
                    onChange={(event) =>
                      setEditor({ ...editor, path: event.target.value })
                    }
                  />
                </Field>
                <Field label="Content">
                  <Textarea
                    rows={16}
                    value={editor.content}
                    disabled={blocked}
                    onChange={(event) =>
                      setEditor({ ...editor, content: event.target.value })
                    }
                  />
                </Field>
                <Field label="Protected">
                  <Input
                    type="checkbox"
                    checked={
                      state?.protectedPaths.includes(editor.path) ?? false
                    }
                    disabled={blocked || !existing}
                    onChange={(event) =>
                      void mutate(() =>
                        apiClient.protectMemory(
                          editor.path,
                          event.target.checked,
                        ),
                      )
                    }
                  />
                </Field>
                <div className="memory-editor__actions">
                  <Button
                    type="submit"
                    disabled={blocked || !editor.path}
                    loading={pending}
                  >
                    Save
                  </Button>
                  {existing ? (
                    <Button
                      variant="danger"
                      disabled={blocked}
                      onClick={() =>
                        void mutate(
                          () => apiClient.removeMemory(editor.path),
                          "Delete",
                        )
                      }
                    >
                      Delete
                    </Button>
                  ) : null}
                </div>
              </form>
            ) : (
              <EmptyState title="Select a file from the tree to view or edit it." />
            )}
          </section>
        </div>
      )}
    </div>
  );
}

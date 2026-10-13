import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, FileText, Folder } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { presentMemory } from "./memory-presentation.js";
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

/**
 * Stale-while-revalidate cache. Navigating between the Store list and the
 * detail view remounts this component, and every list refresh pays an
 * upstream Ark round trip — seconds per click. Rendering the last known list
 * immediately keeps navigation instant; the background refresh still corrects
 * it once the network responds.
 *
 * Entries are bound to the account that loaded them. A different account (or a
 * signed-out state) never renders another account's store, and a response that
 * arrives after an account switch only ever writes under its own account key.
 */
let memoryCache: { account: string; list: MemoryList } | null = null;

/**
 * Drops the cache entry for one account. App calls this on sign-out and on
 * auth-required so a stored list never outlives its session.
 */
export function clearMemoryCache(account: string): void {
  if (memoryCache?.account === account) memoryCache = null;
}

/** Test hook: the cache intentionally outlives a single mount. */
export function resetMemoryCacheForTest(): void {
  memoryCache = null;
}

function memoryError(error: unknown): string {
  if (error instanceof ApiClientError) {
    switch (error.code) {
      case "MEMORY_BUSY":
        return "记忆正在处理中，请等待当前操作完成。";
      case "MEMORY_CONFLICT":
        return "记忆内容已变更，请重新加载后编辑。";
      case "MEMORY_INVALID":
        return "请检查路径和内容；记忆中不能保存凭证。";
      case "MEMORY_CAPACITY":
        return "记忆容量已达上限，请精简内容。";
      case "MEMORY_REPAIR_REQUIRED":
        return "记忆需要修复，请联系管理员。";
    }
  }
  return "记忆无法加载或更新，请检查连接后重试。";
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

export function MemoryPage({
  onAuthRequired,
  account,
}: {
  onAuthRequired: () => void;
  account: string;
}) {
  const location = useLocation();
  const detailView = location.pathname === "/context/store";
  return detailView ? (
    <MemoryStoreDetail onAuthRequired={onAuthRequired} account={account} />
  ) : (
    <MemoryStoreList onAuthRequired={onAuthRequired} account={account} />
  );
}

function MemoryStoreList({
  onAuthRequired,
  account,
}: {
  onAuthRequired: () => void;
  account: string;
}) {
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
    // Only this account's cached list may render, and this account's response
    // may only write under this account's key.
    if (memoryCache?.account === account) setList(memoryCache.list);
    apiClient
      .listMemory()
      .then((result) => {
        if (active) {
          memoryCache = { account, list: result };
          setList(result);
        }
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
  }, [account, reload]);

  return (
    <div className="page page--wide memory-overview">
      <PageHeader
        title="个人记忆"
        description="助手可读取和记录个人记忆；自动整理单独控制。不使用记忆的任务仍会保存对话。"
      />
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {!list ? (
        error ? (
          <EmptyState
            title="个人记忆暂不可用"
            action={
              <Button onClick={() => setReload((value) => value + 1)}>
                重试
              </Button>
            }
          />
        ) : (
          <Spinner label="正在加载记忆" />
        )
      ) : (
        <DataTable caption="个人记忆">
          <thead>
            <tr>
              <th scope="col">名称</th>
              <th scope="col">关联任务</th>
              <th scope="col">记忆条目</th>
              <th scope="col">容量</th>
              <th scope="col">更新时间</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr
              className="memory-store-row"
              onClick={() => navigate("/context/store")}
            >
              <td data-label="名称">
                <span className="memory-store-name">个人记忆</span>
                <span className="memory-store-id">{list.store.id}</span>
              </td>
              <td data-label="关联任务">
                <span className="memory-store-count">{list.sessionCount}</span>
              </td>
              <td data-label="记忆条目">{list.capacity.count}</td>
              <td data-label="容量">{formatBytes(list.capacity.bytes)}</td>
              <td data-label="更新时间">
                {formatDateTime(list.store.updatedAt)}
              </td>
              <td data-label="操作">
                <Button
                  variant="text"
                  onClick={() => navigate("/context/store")}
                >
                  查看记忆
                </Button>
              </td>
            </tr>
          </tbody>
        </DataTable>
      )}
    </div>
  );
}

function MemoryStoreDetail({
  onAuthRequired,
  account,
}: {
  onAuthRequired: () => void;
  account: string;
}) {
  const navigate = useNavigate();
  const [list, setList] = useState<MemoryList | null>(null);
  const [state, setState] = useState<MemoryState | null>(null);
  const [editor, setEditor] = useState<MemoryEntry | null>(null);
  // The edit base captured when the entry was selected. It never follows the
  // draft or a background refresh: saving sends it as expectedHash, so a stale
  // editor conflicts instead of overwriting a concurrent update.
  const [baseHash, setBaseHash] = useState<string | null>(null);
  const [existing, setExisting] = useState(false);
  const [pending, setPending] = useState(false);
  const [repairPending, setRepairPending] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  // A save on an entry read without a server version: the page re-reads, and
  // the notice survives the refresh (unlike `error`, which the reload clears).
  const [versionNotice, setVersionNotice] = useState<string | null>(null);
  const [awaitingVersionFor, setAwaitingVersionFor] = useState<string | null>(
    null,
  );
  const authRef = useRef(onAuthRequired);
  authRef.current = onAuthRequired;
  const accepted = useRef<"Save" | "Delete" | null>(null);
  // Mirrors `editor` for the poll closure, which resolves the saved entry by
  // path once the queued write completes.
  const editorRef = useRef<MemoryEntry | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

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
    // Only this account's cached list may render, and this account's response
    // may only write under this account's key.
    if (memoryCache?.account === account) {
      setList(memoryCache.list);
      setState(memoryCache.list.state);
    }
    apiClient
      .listMemory()
      .then((result) => {
        if (!active) return;
        memoryCache = { account, list: result };
        setList(result);
        setState(result.state);
        // A re-read requested by the unversioned-save guard: only re-base the
        // draft when the server content is byte-identical to what the editor
        // holds — otherwise a fresh hash must never meet a stale draft.
        const awaitingPath = awaitingVersionFor;
        if (awaitingPath) {
          setAwaitingVersionFor(null);
          const fresh = result.entries.find(
            (entry) => entry.path === awaitingPath,
          );
          if (
            fresh?.hash &&
            editorRef.current?.path === awaitingPath &&
            editorRef.current?.content === fresh.content
          ) {
            setBaseHash(fresh.hash);
            setVersionNotice(null);
          }
        }
      })
      .catch(async (loadError) => {
        if (!active) return;
        handleError(loadError);
        // Only a store that was never provisioned stays unreadable; runs no
        // longer block listing. Status still works and keeps the UI informed.
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
  }, [account, awaitingVersionFor, handleError, reload]);

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
          memoryCache = { account, list: result };
          setList(result);
          setState(result.state);
          setError(null);
          if (next.run?.stage === "failed") {
            setError(next.run.error ?? "记忆操作失败。");
            setFeedback(null);
          } else if (accepted.current) {
            const action = accepted.current;
            setFeedback(action === "Save" ? "记忆已保存。" : "记忆已删除。");
            if (action === "Save") {
              const savedPath = editorRef.current?.path;
              const savedEntry = result.entries.find(
                (entry) => entry.path === savedPath,
              );
              setEditor(savedEntry ?? editorRef.current);
              // The write landed: the fresh content is the next edit base.
              setBaseHash(savedEntry?.hash ?? null);
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
  }, [account, running, handleError]);

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
          action === "Save"
            ? "保存已排队，尚未保存。"
            : "删除已排队，尚未删除。",
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
      setFeedback("已接受修复请求，后台将继续处理。");
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
      setFeedback("操作已取消。");
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
        ‹ 返回个人记忆
      </Button>
      <PageHeader
        title="编辑个人记忆"
        description="查看与编辑已保存的记忆；原始路径和版本校验仍用于安全更新。"
      />

      {error ? <Alert tone="danger">{error}</Alert> : null}
      {versionNotice ? <Alert tone="warning">{versionNotice}</Alert> : null}
      {running || (state !== null && state.status !== "active") ? (
        <Alert tone="warning">
          记忆正在准备或维护中，暂时不能编辑。
          <Button variant="text" onClick={() => navigate("/?temporary=true")}>
            另开不使用记忆的任务
          </Button>
        </Alert>
      ) : null}
      {running ? (
        <Alert tone="info">
          自动整理正在运行。当前内容可能包含整理中的变更，完成后会刷新并恢复编辑。
        </Alert>
      ) : null}
      {feedback ? (
        <Alert tone={running ? "info" : "success"}>{feedback}</Alert>
      ) : null}

      {!list && !error ? <Spinner label="正在加载记忆" /> : null}

      {state ? (
        <>
          <header className="memory-detail__header">
            <div className="memory-detail__title">
              <h2>记忆状态</h2>
              <Badge tone={running ? "warning" : "neutral"}>
                {{
                  active: "可用",
                  provisioning: "准备中",
                  draining: "等待任务结束",
                  applying: "应用中",
                  repairing: "修复中",
                }[state.status] ?? state.status}
              </Badge>
              {running ? (
                <span className="memory-detail__running">正在整理记忆…</span>
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
                自动整理
              </label>
              <Button
                variant="secondary"
                disabled={pending}
                onClick={() => setReload((value) => value + 1)}
              >
                刷新
              </Button>
              {running ? (
                <Button
                  variant="secondary"
                  loading={cancelPending}
                  onClick={() => void cancelOperation()}
                >
                  取消操作
                </Button>
              ) : null}
              {state.status === "repairing" ? (
                <Button
                  variant="secondary"
                  loading={repairPending}
                  onClick={() => void repair()}
                >
                  修复
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
                  记忆条目：{list.capacity.count} (
                  {formatBytes(list.capacity.bytes)})
                </span>
                <span>关联任务：{list.sessionCount}</span>
                <span>更新于 {formatDateTime(list.store.updatedAt)}</span>
              </>
            ) : null}
          </p>
        </>
      ) : null}

      {!list ? (
        error ? (
          <EmptyState
            title="个人记忆暂不可用"
            action={
              <Button onClick={() => setReload((value) => value + 1)}>
                重试
              </Button>
            }
          />
        ) : null
      ) : (
        <>
          <section className="memory-catalog" aria-label="记忆分类与来源">
            <h2>偏好、事实与协作习惯</h2>
            <p>
              关闭自动整理只停止后台整理，不会关闭助手原生记忆读写。删除任务与删除记忆是独立操作。
            </p>
            <ul className="memory-catalog__list">
              {entries.map((entry) => (
                <li key={entry.path}>
                  <Button
                    variant="text"
                    onClick={() => {
                      setEditor(entry);
                      setBaseHash(entry.hash ?? null);
                      setExisting(true);
                      setVersionNotice(null);
                    }}
                  >
                    {presentMemory(entry).category} ·{" "}
                    {entry.path.split("/").at(-1)}
                  </Button>
                  <p>{entry.content.slice(0, 300)}</p>
                  <p className="muted">{presentMemory(entry).source}</p>
                </li>
              ))}
            </ul>
          </section>
          <div className="memory-detail__body">
            <aside className="memory-tree" aria-label="记忆文件">
              <div className="memory-tree__head">
                <span>路径浏览</span>
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
                  setBaseHash(entry.hash ?? null);
                  setVersionNotice(null);
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
                    setBaseHash(null);
                    setVersionNotice(null);
                    setExisting(false);
                    setFeedback(null);
                  }}
                >
                  + 新建记忆
                </Button>
              </div>
            </aside>

            <section className="memory-editor" aria-label="记忆编辑器">
              {editor ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    // `hash` is read metadata, never a writable field.
                    const entry = {
                      path: editor.path,
                      content: editor.content,
                    };
                    if (existing && baseHash === null) {
                      // Never fall back to an unversioned write: re-read once.
                      // The notice survives the refresh; the draft is re-based
                      // only if the server content is byte-identical.
                      setAwaitingVersionFor(entry.path);
                      setVersionNotice(
                        "当前条目缺少版本信息，已重新读取；仍无法保存时请刷新页面或更新客户端。",
                      );
                      setReload((value) => value + 1);
                      return;
                    }
                    void mutate(
                      () =>
                        apiClient.writeMemory(
                          existing && baseHash !== null
                            ? { ...entry, expectedHash: baseHash }
                            : entry,
                        ),
                      "Save",
                    );
                  }}
                >
                  <Field
                    label="路径"
                    hint="可使用 /memories/、/procedures/、/episodes/ 或 /resources/。"
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
                  <Field label="内容">
                    <Textarea
                      rows={16}
                      value={editor.content}
                      disabled={blocked}
                      onChange={(event) =>
                        setEditor({ ...editor, content: event.target.value })
                      }
                    />
                  </Field>
                  <Field
                    label="保护（仅限制后台整理）"
                    hint="保护不会关闭助手原生记忆写入；维护期间仍需等待锁释放。"
                  >
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
                      保存
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
                        删除
                      </Button>
                    ) : null}
                  </div>
                </form>
              ) : (
                <EmptyState
                  title="选择记忆条目后查看或编辑"
                  description="可从分类卡片或左侧路径浏览中选择。"
                />
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}

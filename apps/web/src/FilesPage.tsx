import {
  ChevronDown,
  Download,
  FileText,
  Folder,
  Search,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { artifactKind } from "./artifacts.js";
import { ArtifactViewer } from "./components/ArtifactViewer.js";
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
  Input,
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

/** Native option popups size to the widest label, so a full task title would
 * blow the popup far past the select and read as misaligned. Labels stay
 * popup-sized; the full title remains on the group record. */
const MAX_OPTION_CHARS = 28;

function taskOptionLabel(title: string): string {
  return title.length > MAX_OPTION_CHARS
    ? `${title.slice(0, MAX_OPTION_CHARS)}…`
    : title;
}

export function FilesPage({
  sessions,
  onAuthRequired,
}: {
  sessions: SessionSummary[];
  onAuthRequired: () => void;
}) {
  const [sessionId, setSessionId] = useState("");
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState("");
  const [preview, setPreview] = useState<ArtifactSummary | null>(null);
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
  const previewTriggerRef = useRef<HTMLButtonElement>(null);

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
        setFeedback("文件无法删除，请重试。");
        setDeleteTarget(null);
      }
    } finally {
      setDeleting(false);
    }
  }

  const sessionNames = new Map(
    sessions.map((session) => [session.id, session.title]),
  );
  const filtered =
    artifacts?.filter(
      (file) =>
        file.name
          .toLocaleLowerCase()
          .includes(search.trim().toLocaleLowerCase()) &&
        (!kind || artifactKind(file) === kind),
    ) ?? [];
  // One record per task: a task's outputs stay together and expand in place.
  const groups = [...new Set(filtered.map((file) => file.sessionId))]
    .map((id) => {
      const files = filtered.filter((file) => file.sessionId === id);
      return {
        sessionId: id,
        files,
        updatedAt: files
          .map((file) => file.generatedAt)
          .reduce(
            (latest, at) => (at > latest ? at : latest),
            files[0]!.generatedAt,
          ),
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const kindLabels = {
    spreadsheet: "表格",
    word: "文档",
    slides: "演示",
    pdf: "PDF",
    image: "图片",
    text: "文本",
    html: "HTML",
    markdown: "Markdown",
    csv: "CSV",
    other: "文件",
  };

  return (
    <div className="page files-page">
      <PageHeader
        title="我的文件"
        headingRef={pageHeadingRef}
        description="查看任务成果，下载文件或继续使用已有材料。"
      />
      <div
        className="page-toolbar files-toolbar"
        role="search"
        aria-label="文件筛选"
      >
        {/* Not the shared Field: the search box carries a leading icon inside
            the labelled region, and Field's clone targets a direct child. */}
        <label className="ui-field files-toolbar__field">
          <span className="ui-field__label">搜索文件</span>
          <span className="files-toolbar__search">
            <Search size={14} aria-hidden="true" />
            <Input
              type="search"
              placeholder="输入文件名称"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </span>
        </label>
        <Field label="来源任务">
          <Select
            value={sessionId}
            onChange={(event) => setSessionId(event.target.value)}
          >
            <option value="">全部任务</option>
            {knownSessionIds.map((knownSessionId) => (
              <option key={knownSessionId} value={knownSessionId}>
                {taskOptionLabel(
                  sessionNames.get(knownSessionId) ??
                    `任务 ${knownSessionId.slice(0, 8)}`,
                )}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="文件类型">
          <Select
            value={kind}
            onChange={(event) => setKind(event.target.value)}
          >
            <option value="">全部类型</option>
            <option value="spreadsheet">表格</option>
            <option value="word">文档</option>
            <option value="slides">演示</option>
            <option value="pdf">PDF</option>
            <option value="image">图片</option>
            <option value="text">文本</option>
            <option value="markdown">Markdown</option>
            <option value="csv">CSV</option>
            <option value="html">HTML</option>
          </Select>
        </Field>
      </div>

      {feedback ? (
        <Alert className="artifact-feedback" tone="danger">
          {feedback}
        </Alert>
      ) : null}

      {loadError ? (
        <EmptyState
          className="ui-empty-state--page"
          title="文件无法加载。"
          action={
            <Button
              variant="secondary"
              onClick={() => setReloadKey((key) => key + 1)}
            >
              重试
            </Button>
          }
        />
      ) : artifacts === null ? (
        <EmptyState
          className="artifact-loading-state ui-empty-state--page"
          title="正在加载文件…"
          action={<Spinner label="正在加载文件" />}
        />
      ) : artifacts.length === 0 && !sessionId && !search.trim() && !kind ? (
        <EmptyState
          className="ui-empty-state--page"
          title="暂无成果文件。"
          description="任务生成的成果会保存在这里，方便下载和继续修改。"
          action={<Button onClick={() => navigate("/")}>创建新任务</Button>}
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          className="ui-empty-state--page"
          title="没有匹配的文件"
          description="试试其他文件名，或清除筛选查看全部成果。"
          action={
            <Button
              variant="secondary"
              onClick={() => {
                setSearch("");
                setKind("");
                setSessionId("");
              }}
            >
              清除筛选
            </Button>
          }
        />
      ) : (
        <ul className="artifact-list" aria-label="成果文件">
          {groups.map((group) => {
            const totalBytes = group.files.reduce(
              (sum, file) => sum + file.sizeBytes,
              0,
            );
            return (
              <li key={group.sessionId}>
                <details className="artifact-group">
                  <summary className="artifact-group__summary">
                    <span className="artifact-group__icon" aria-hidden="true">
                      <Folder size={16} />
                    </span>
                    <span className="artifact-group__heading">
                      <strong>
                        {sessionNames.get(group.sessionId) ??
                          `任务 ${group.sessionId.slice(0, 8)}`}
                      </strong>
                      <span className="artifact-group__meta">
                        {group.files.length} 个文件 · 共{" "}
                        {formatBytes(totalBytes)} · 更新于{" "}
                        {formatDate(group.updatedAt)}
                      </span>
                    </span>
                    <ChevronDown
                      size={16}
                      aria-hidden="true"
                      className="artifact-group__chevron"
                    />
                  </summary>
                  <ul className="artifact-group__files">
                    {group.files.map((artifact) => (
                      <li key={artifact.id} className="artifact-record">
                        <span
                          className="artifact-record__icon"
                          aria-hidden="true"
                        >
                          <FileText size={16} />
                        </span>
                        <div className="artifact-record__file">
                          <strong>{artifact.name}</strong>
                          <div className="artifact-record__metadata">
                            <span>{kindLabels[artifactKind(artifact)]}</span>
                            <span>{formatBytes(artifact.sizeBytes)}</span>
                            <time dateTime={artifact.generatedAt}>
                              {formatDate(artifact.generatedAt)}
                            </time>
                          </div>
                        </div>
                        <div className="artifact-record__actions">
                          {artifact.deletionState === "pending" ? (
                            <Badge tone="warning">删除中</Badge>
                          ) : artifact.deletionState === "deletion_failed" ? (
                            <Badge tone="danger">删除失败</Badge>
                          ) : (
                            <>
                              <Button
                                variant="text"
                                onClick={(event) => {
                                  previewTriggerRef.current =
                                    event.currentTarget;
                                  setPreview(artifact);
                                }}
                              >
                                预览
                              </Button>
                              <Button
                                variant="secondary"
                                onClick={() =>
                                  navigate(
                                    `/?artifactId=${encodeURIComponent(artifact.id)}`,
                                  )
                                }
                              >
                                继续修改
                              </Button>
                              <a
                                className="ui-icon-button ui-icon-button--small"
                                href={`/api/v1/artifacts/${encodeURIComponent(artifact.id)}/download`}
                                aria-label={`下载 ${artifact.name}`}
                                title={`下载 ${artifact.name}`}
                                download
                              >
                                <Download size={16} aria-hidden="true" />
                              </a>
                              <IconButton
                                size="small"
                                className="artifact-record__delete"
                                label={`删除 ${artifact.name}`}
                                onClick={() => setDeleteTarget(artifact)}
                              >
                                <Trash2 size={15} aria-hidden="true" />
                              </IconButton>
                            </>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            );
          })}
        </ul>
      )}
      <Dialog
        open={preview !== null}
        title={`文件预览：${preview?.name ?? ""}`}
        closeLabel="关闭文件预览"
        onClose={() => setPreview(null)}
        returnFocusRef={previewTriggerRef}
        fallbackFocusRef={pageHeadingRef}
      >
        {preview ? (
          <ArtifactViewer
            artifact={preview}
            onClose={() => setPreview(null)}
            hideHeader
          />
        ) : null}
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        title="删除文件？"
        onClose={() => setDeleteTarget(null)}
        closeLabel="关闭文件删除确认"
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
                取消
              </Button>
              <Button
                variant="danger"
                loading={deleting}
                onClick={() => void requestDeletion()}
              >
                删除文件
              </Button>
            </>
          ) : null
        }
      >
        {deleteTarget ? (
          <p className="artifact-dialog-copy">
            删除 <strong>{deleteTarget.name}</strong>
            。仍被其他任务引用的材料会继续保留。
          </p>
        ) : null}
      </Dialog>
    </div>
  );
}

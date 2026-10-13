import {
  clearDraft,
  readDraft,
  writeDraft,
  type AttemptedTask,
} from "../submission-drafts.js";
import {
  FileText,
  Files,
  GitCompareArrows,
  Info,
  NotebookPen,
  Paperclip,
  RotateCcw,
  X,
} from "lucide-react";
import {
  type ChangeEvent,
  type SyntheticEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  MaterialUploadQueue,
  validateMaterials,
} from "../material-upload-queue.js";
import { useSearchParams, Link } from "react-router-dom";
import {
  ApiClientError,
  apiClient,
  type AgentList,
  type SessionSummary,
  type UploadedInput,
  type UsageSummary,
  type ArtifactSummary,
} from "../api.js";
import {
  Alert,
  Button,
  Dialog,
  Field,
  IconButton,
  PageHeader,
  Select,
  Spinner,
  Textarea,
} from "../ui/index.js";
import { MaterialPicker } from "./MaterialPicker.js";

export interface TaskTemplate {
  id: string;
  label: string;
  outcome: string;
  prompt: string;
}

/**
 * Result-oriented starting points. Each one only prefills the composer; nothing
 * here promises a capability the Agent does not have.
 */
export const taskTemplates: TaskTemplate[] = [
  {
    id: "summarize",
    label: "总结材料",
    outcome: "提炼重点、决策与待确认问题。",
    prompt:
      "Read the attached material and produce a one-page brief: what it says, the decisions it implies, and the open questions. Cite the section each point comes from.",
  },
  {
    id: "compare",
    label: "比较方案并推荐",
    outcome: "对比成本、投入和风险，给出建议。",
    prompt:
      "Compare the options below on cost, effort and risk, present the comparison as a table, then recommend one and state what you would give up by choosing it.",
  },
  {
    id: "structure",
    label: "将笔记整理成文档",
    outcome: "保留事实，整理成条理清晰的文档。",
    prompt:
      "Turn the attached notes into a structured document with clear headings, a short summary at the top, and consistent terminology. Keep every factual claim from the notes.",
  },
];

type UploadState =
  | { key: number; file: File; status: "uploading" }
  | { key: number; file: File; status: "ready"; upload: UploadedInput }
  | { key: number; file: File; status: "failed" };

function isAuthError(error: unknown): boolean {
  return error instanceof ApiClientError && error.isAuthRequired;
}

export function quotaBlocker(usage: UsageSummary): string | null {
  if (usage.exhausted.monthlyTokens) {
    return "本月额度已用完，已有结果仍可查看。";
  }
  if (usage.exhausted.dailySessions) {
    return "今日任务额度已用完，请明天再试。";
  }
  if (usage.exhausted.concurrentSessions) {
    return "正在执行的任务已达上限，请等待任务完成。";
  }
  return null;
}

export interface SessionIntroProps {
  draftKey?: string;
  agents: AgentList;
  usage: UsageSummary;
  onAuthRequired: () => void;
  onSessionCreated: (session: SessionSummary, content: string) => void;
}

export function SessionIntro({
  draftKey = "new",
  agents,
  usage,
  onAuthRequired,
  onSessionCreated,
}: SessionIntroProps) {
  const nextUploadKey = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const messageInput = useRef<HTMLTextAreaElement>(null);
  const materialPickerTrigger = useRef<HTMLButtonElement>(null);
  const memoryExplanationTrigger = useRef<HTMLButtonElement>(null);
  const [materialPickerOpen, setMaterialPickerOpen] = useState(false);
  const [memoryExplanationOpen, setMemoryExplanationOpen] = useState(false);
  const [draft] = useState(() => readDraft(draftKey));
  const [selectedAgentId, setSelectedAgentId] = useState(
    draft.attempt?.agentId ?? agents.selection?.agentId ?? "",
  );
  const [params] = useSearchParams();
  const [temporary, setTemporary] = useState(
    params.get("temporary") === "true" || draft.temporary === true,
  );
  const [existingFiles, setExistingFiles] = useState<ArtifactSummary[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(
    new Set(params.getAll("artifactId")),
  );
  const [reused, setReused] = useState<Record<string, UploadedInput>>({});
  const sourceSessionId = params.get("sourceSessionId");
  const [submissionId, setSubmissionId] = useState(draft.submissionId);
  const [message, setMessage] = useState(draft.content);
  const messageEdited = useRef(false);
  const currentDraft = useRef({ message, submissionId, temporary });
  currentDraft.current = { message, submissionId, temporary };
  const attemptedRequest = useRef("");
  const exactAttempt = useRef<AttemptedTask | undefined>(draft.attempt);
  const preparation = useRef(new AbortController());
  const composing = useRef(false);
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [submissionStatus, setSubmissionStatus] = useState("");
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const queue = useRef(new MaterialUploadQueue());
  useEffect(() => {
    const controller = new AbortController();
    preparation.current = controller;
    return () => {
      queue.current.dispose();
      controller.abort();
    };
  }, []);
  useEffect(() => {
    let active = true;
    void apiClient
      .listArtifacts()
      .then((result) => {
        if (active) setExistingFiles(result.artifacts);
      })
      .catch(() => {});
    if (sourceSessionId)
      void apiClient
        .listSessionTurns(sourceSessionId)
        .then((result) => {
          if (
            active &&
            result.turns[0]?.summary &&
            !messageEdited.current &&
            !currentDraft.current.message.trim()
          ) {
            const content = `接着完成以下任务，可根据新材料调整：\n\n${result.turns[0].summary}`;
            setMessage(content);
            writeDraft(
              draftKey,
              content,
              currentDraft.current.submissionId,
              currentDraft.current.temporary,
            );
          }
        })
        .catch(() => {
          if (active)
            setSubmissionError("无法读取原任务摘要，请输入后续任务要求。");
        });
    return () => {
      active = false;
    };
  }, [sourceSessionId]);

  const agentBlocker =
    agents.blocker && !exactAttempt.current
      ? "暂无默认助手，请联系管理员配置可用助手。"
      : null;
  const blocker =
    agentBlocker ?? (exactAttempt.current ? null : quotaBlocker(usage));
  const hasUnreadyUploads = uploads.some((upload) => upload.status !== "ready");

  function invalidateAttempt(content = message, nextTemporary = temporary) {
    exactAttempt.current = undefined;
    attemptedRequest.current = "";
    const id = crypto.randomUUID();
    setSubmissionId(id);
    writeDraft(draftKey, content, id, nextTemporary);
  }

  async function uploadFile(item: UploadState) {
    setUploads((current) =>
      current.map((upload) =>
        upload.key === item.key
          ? { key: item.key, file: item.file, status: "uploading" }
          : upload,
      ),
    );
    try {
      const uploaded = await queue.current.add(item.key, (signal) =>
        apiClient.upload(item.file, signal),
      );
      setUploads((current) =>
        current.map((upload) =>
          upload.key === item.key
            ? {
                key: item.key,
                file: item.file,
                status: "ready",
                upload: uploaded,
              }
            : upload,
        ),
      );
    } catch (error) {
      if (isAuthError(error)) {
        onAuthRequired();
        return;
      }
      setUploads((current) =>
        current.map((upload) =>
          upload.key === item.key
            ? { key: item.key, file: item.file, status: "failed" }
            : upload,
        ),
      );
    }
  }

  function addFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    const invalid = validateMaterials(
      files,
      uploads.map((item) => item.file),
    );
    if (invalid) {
      setSubmissionError(invalid);
      event.target.value = "";
      return;
    }
    const remaining = Math.max(0, 20 - uploads.length);
    const items: UploadState[] = files.slice(0, remaining).map((file) => ({
      key: nextUploadKey.current++,
      file,
      status: "uploading",
    }));
    if (items.length > 0) {
      invalidateAttempt();
      setUploads((current) => [...current, ...items]);
      for (const item of items) void uploadFile(item);
    }
    event.target.value = "";
  }

  function applyTemplate(template: TaskTemplate) {
    messageEdited.current = true;
    invalidateAttempt(template.prompt);
    setMessage(template.prompt);
    messageInput.current?.focus();
  }

  async function submitTask(
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ) {
    event.preventDefault();
    const content = message.trim();
    if (
      submitting ||
      blocker ||
      hasUnreadyUploads ||
      !selectedAgentId ||
      !content ||
      composing.current
    ) {
      return;
    }
    const invalid = validateMaterials(
      [...selectedFiles].map((id) => ({
        size: existingFiles.find((file) => file.id === id)?.sizeBytes ?? 0,
      })),
      uploads.map((item) => item.file),
    );
    if (invalid) {
      setSubmissionError(invalid);
      return;
    }

    const signal = preparation.current.signal;
    setSubmitting(true);
    setSubmissionError(null);
    setSubmissionStatus("正在保存任务…");
    try {
      const requestHash = JSON.stringify({
        selectedAgentId,
        content,
        uploads: uploads.flatMap((upload) =>
          upload.status === "ready" ? [upload.upload.id] : [],
        ),
        temporary,
        selectedFiles: [...selectedFiles].sort(),
      });
      const stableId =
        attemptedRequest.current && attemptedRequest.current !== requestHash
          ? crypto.randomUUID()
          : submissionId;
      attemptedRequest.current = requestHash;
      setSubmissionId(stableId);
      writeDraft(draftKey, content, stableId, temporary, exactAttempt.current);
      const request = exactAttempt.current ?? {
        submissionId: stableId,
        content,
        agentId: selectedAgentId,
        uploadIds: [
          ...uploads.flatMap((upload) =>
            upload.status === "ready" ? [upload.upload.id] : [],
          ),
          ...(await prepareSelectedFiles(signal)),
        ],
        title: content.slice(0, 120),
        temporary,
      };
      signal.throwIfAborted();
      exactAttempt.current = request;
      writeDraft(
        draftKey,
        request.content,
        request.submissionId,
        request.temporary,
        request,
      );
      const session = await apiClient.createSession(request);
      if (signal.aborted) return;
      if (readDraft(draftKey).submissionId === request.submissionId)
        clearDraft(draftKey);
      onSessionCreated(session, request.content);
    } catch (error) {
      if (signal.aborted) return;
      if (isAuthError(error)) {
        onAuthRequired();
        return;
      }
      const quotaError =
        error instanceof ApiClientError &&
        (error.code === "QUOTA_EXCEEDED" ||
          error.code === "CONCURRENCY_LIMITED");
      setSubmissionError(
        quotaError
          ? "任务额度已用完，已有结果仍可查看。"
          : "任务无法启动，请重试。",
      );
      setSubmissionStatus("");
    } finally {
      if (!signal.aborted) setSubmitting(false);
    }
  }

  async function prepareSelectedFiles(signal: AbortSignal) {
    const ids: string[] = [];
    for (const id of selectedFiles) {
      signal.throwIfAborted();
      if (reused[id]) {
        ids.push(reused[id]!.id);
        continue;
      }
      const prepared = await apiClient.reuseArtifact(id, signal);
      signal.throwIfAborted();
      setReused((current) => ({ ...current, [id]: prepared }));
      ids.push(prepared.id);
    }
    return ids;
  }

  return (
    <div className="page session-intro">
      <div className="session-intro__header">
        <PageHeader title="新任务" />
        <Link className="session-intro__settings-link" to="/settings">
          助手与记忆设置
        </Link>
      </div>
      {sourceSessionId ? (
        <aside className="session-intro__context" aria-label="后续任务来源">
          <strong>新的后续任务</strong>
          <p>请编辑下面的摘要并选择材料；原任务的完整执行环境不会自动复制。</p>
          <details>
            <summary>来源任务</summary>
            <Link to={`/sessions/${encodeURIComponent(sourceSessionId)}`}>
              {sourceSessionId}
            </Link>
          </details>
        </aside>
      ) : null}

      <form className="composer composer--new-task" onSubmit={submitTask}>
        <label className="sr-only" htmlFor="task-message">
          任务要求
        </label>
        <Textarea
          id="task-message"
          ref={messageInput}
          value={message}
          onChange={(event) => {
            messageEdited.current = true;
            invalidateAttempt(event.target.value);
            setMessage(event.target.value);
          }}
          placeholder="描述你希望完成的工作…"
          rows={6}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          disabled={submitting}
        />

        {uploads.length > 0 || selectedFiles.size > 0 ? (
          <ul className="upload-list composer-materials" aria-label="已选材料">
            {uploads.map((upload) => (
              <li
                className="material-chip material-chip--upload"
                key={`upload-${upload.key}`}
              >
                <FileText size={16} aria-hidden="true" />
                <span className="upload-name">{upload.file.name}</span>
                {upload.status === "uploading" ? (
                  <span className="upload-state">
                    <Spinner size={14} aria-hidden="true" />
                    上传中
                  </span>
                ) : null}
                {upload.status === "ready" ? (
                  <span className="upload-state ready">已就绪</span>
                ) : null}
                {upload.status === "failed" ? (
                  <>
                    <span className="upload-error">
                      {upload.file.name} 上传失败。
                    </span>
                    <Button
                      variant="text"
                      size="compact"
                      onClick={() => void uploadFile(upload)}
                    >
                      <RotateCcw size={14} aria-hidden="true" />
                      重试上传
                    </Button>
                  </>
                ) : null}
                <IconButton
                  className="small-control"
                  label={`移除 ${upload.file.name}`}
                  size="small"
                  onClick={() => {
                    invalidateAttempt();
                    queue.current.cancel(upload.key);
                    setUploads((current) =>
                      current.filter((item) => item.key !== upload.key),
                    );
                  }}
                  disabled={submitting}
                >
                  <X size={15} aria-hidden="true" />
                </IconButton>
              </li>
            ))}
            {[...selectedFiles].map((id) => {
              const file = existingFiles.find((item) => item.id === id);
              return (
                <li
                  className="material-chip material-chip--existing"
                  key={`artifact-${id}`}
                >
                  <FileText size={16} aria-hidden="true" />
                  <span className="material-chip__file">
                    <span className="upload-name">{file?.name ?? id}</span>
                    <span className="material-chip__id">{id}</span>
                    {file?.sessionId ? (
                      <span className="material-chip__source">
                        来源任务：{file.sessionId}
                      </span>
                    ) : null}
                  </span>
                  <span className="upload-state">已有文件</span>
                  <IconButton
                    className="small-control"
                    label={`移除材料 ${file?.name ?? id} · ${id}`}
                    size="small"
                    disabled={submitting}
                    onClick={() => {
                      invalidateAttempt();
                      setSelectedFiles((current) => {
                        const next = new Set(current);
                        next.delete(id);
                        return next;
                      });
                    }}
                  >
                    <X size={15} aria-hidden="true" />
                  </IconButton>
                </li>
              );
            })}
          </ul>
        ) : null}

        {blocker || submissionError || submissionStatus ? (
          <div className="composer-feedback" aria-live="polite">
            {blocker ? (
              <Alert tone="danger">{blocker}</Alert>
            ) : submissionError ? (
              <Alert tone="danger">{submissionError}</Alert>
            ) : (
              <span>
                <Spinner size={15} aria-hidden="true" />
                {submissionStatus}
              </span>
            )}
          </div>
        ) : null}
        <div className="composer-footer">
          <div className="composer-controls composer-controls--materials">
            <Button
              className="attachment-button"
              variant="text"
              size="compact"
              onClick={() => fileInput.current?.click()}
              disabled={submitting || uploads.length >= 20}
            >
              <Paperclip size={16} aria-hidden="true" />
              添加材料
            </Button>
            <input
              ref={fileInput}
              className="file-input"
              type="file"
              multiple
              aria-label="材料文件"
              onChange={addFiles}
              disabled={submitting || uploads.length >= 20}
              tabIndex={-1}
            />
            <Button
              className="material-picker-trigger"
              variant="text"
              size="compact"
              aria-haspopup="dialog"
              aria-expanded={materialPickerOpen}
              onClick={(event) => {
                materialPickerTrigger.current = event.currentTarget;
                setMaterialPickerOpen(true);
              }}
              disabled={submitting}
            >
              <Files size={16} aria-hidden="true" />
              选已有文件
            </Button>
            <div className="memory-control">
              <label className="memory-control__label">
                <input
                  type="checkbox"
                  checked={!temporary}
                  disabled={submitting}
                  onChange={(event) => {
                    const next = !event.target.checked;
                    invalidateAttempt(message, next);
                    setTemporary(next);
                  }}
                />
                使用个人记忆
              </label>
              <IconButton
                className="memory-control__help"
                label="个人记忆说明"
                size="small"
                aria-haspopup="dialog"
                aria-expanded={memoryExplanationOpen}
                onClick={(event) => {
                  memoryExplanationTrigger.current = event.currentTarget;
                  setMemoryExplanationOpen(true);
                }}
              >
                <Info size={16} aria-hidden="true" />
              </IconButton>
            </div>
          </div>
          <div className="composer-controls composer-controls--submit">
            <Field label="助手">
              <Select
                className="agent-picker"
                aria-label="助手"
                value={selectedAgentId}
                onChange={(event) => {
                  invalidateAttempt();
                  setSelectedAgentId(event.target.value);
                }}
                disabled={submitting || agents.agents.length === 0}
              >
                {agents.agents.length === 0 ? (
                  <option value="">暂无可用助手</option>
                ) : null}
                {agents.agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                    {agent.kind === "platform" ? " · 平台" : ""}
                  </option>
                ))}
              </Select>
            </Field>
            <Button
              type="submit"
              className="composer-start-button"
              loading={submitting}
              disabled={
                submitting ||
                Boolean(blocker) ||
                hasUnreadyUploads ||
                !selectedAgentId ||
                message.trim().length === 0
              }
            >
              开始任务
            </Button>
          </div>
        </div>
        {temporary ? (
          <p className="memory-control__status" role="status">
            不使用个人记忆，对话仍保存
          </p>
        ) : null}
      </form>

      <section className="session-intro__templates" aria-label="任务模板">
        {taskTemplates.map((template) => {
          const Icon =
            template.id === "compare"
              ? GitCompareArrows
              : template.id === "structure"
                ? NotebookPen
                : FileText;
          return (
            <button
              key={template.id}
              type="button"
              className="template-card"
              onClick={() => applyTemplate(template)}
              disabled={submitting || Boolean(blocker)}
            >
              <Icon size={18} aria-hidden="true" />
              <span className="template-card__copy">
                <span className="template-card__label">{template.label}</span>
                <span className="template-card__description">
                  {template.outcome}
                </span>
              </span>
            </button>
          );
        })}
      </section>

      <MaterialPicker
        open={materialPickerOpen}
        files={existingFiles}
        selectedIds={selectedFiles}
        returnFocusRef={materialPickerTrigger}
        onClose={() => setMaterialPickerOpen(false)}
        onConfirm={(ids) => {
          if (
            ids.size !== selectedFiles.size ||
            [...ids].some((id) => !selectedFiles.has(id))
          ) {
            invalidateAttempt();
            setSelectedFiles(ids);
          }
          setMaterialPickerOpen(false);
        }}
      />
      <Dialog
        open={memoryExplanationOpen}
        title="个人记忆说明"
        closeLabel="关闭个人记忆说明"
        onClose={() => setMemoryExplanationOpen(false)}
        returnFocusRef={memoryExplanationTrigger}
        footer={
          <Button onClick={() => setMemoryExplanationOpen(false)}>
            知道了
          </Button>
        }
      >
        <p className="memory-control__explanation">
          开启后，本任务可读取并整理个人记忆。关闭后，本任务不读取或整理个人记忆；对话仍会保存。
        </p>
      </Dialog>
    </div>
  );
}

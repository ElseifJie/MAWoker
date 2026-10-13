import { CloudUpload, FolderArchive, Pencil, Plus, Trash2 } from "lucide-react";
import {
  type ChangeEvent,
  type DragEvent,
  type SyntheticEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ApiClientError,
  apiClient,
  type SkillList,
  type SkillScope,
  type SkillStatus,
  type SkillSummary,
} from "./api.js";
import {
  Alert,
  Badge,
  Button,
  Dialog,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Spinner,
  Textarea,
  type BadgeTone,
} from "./ui/index.js";

/** Mirrors the API route's per-request upload cap. */
export const SKILL_MAX_BYTES = 50 * 1024 * 1024;

interface SkillsPageProps {
  onAuthRequired: () => void;
}

function skillStatusTone(status: SkillStatus): BadgeTone {
  if (status === "active") return "success";
  if (status === "failed") return "danger";
  if (status === "provisioning" || status === "deleting") return "warning";
  return "neutral";
}

function isAuthError(error: unknown): boolean {
  return error instanceof ApiClientError && error.isAuthRequired;
}

function formatBytes(size: number): string {
  if (size >= 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

function skillErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiClientError) {
    if (error.code === "INVALID_SKILL_PACKAGE") {
      return "技能包无效，请上传不超过 50 MB 的非空 ZIP 文件。";
    }
    if (error.code === "QUOTA_EXCEEDED") {
      return "个人助手额度不足，技能暂时无法同步到默认助手。";
    }
    if (error.retryable) {
      return "技能服务暂不可用，请重试。";
    }
  }
  return fallback;
}

interface SkillFormValue {
  displayTitle: string;
  description: string;
  file: File | null;
}

type EditorState =
  | { mode: "create"; value: SkillFormValue }
  | { mode: "edit"; skill: SkillSummary; value: SkillFormValue };

const emptyForm: SkillFormValue = {
  displayTitle: "",
  description: "",
  file: null,
};

function SkillCard({
  skill,
  onDelete,
  onEdit,
  deleting,
}: {
  skill: SkillSummary;
  onDelete: (skill: SkillSummary) => void;
  onEdit: (skill: SkillSummary) => void;
  deleting: boolean;
}) {
  return (
    <li className="skill-card" aria-busy={deleting}>
      <div className="skill-card__heading">
        <span className="skill-card__icon" aria-hidden="true">
          <FolderArchive size={18} />
        </span>
        <div className="skill-card__title">
          <h3>{skill.displayTitle || skill.fileName || "技能"}</h3>
          {skill.name ? (
            <code className="skill-card__name">{skill.name}</code>
          ) : null}
        </div>
        <Badge tone={skillStatusTone(skill.status)}>
          {{
            active: "可用",
            failed: "失败",
            provisioning: "准备中",
            deleting: "删除中",
          }[skill.status] ?? skill.status}
        </Badge>
      </div>
      <p className="skill-card__description">
        {skill.description || "暂无描述"}
      </p>
      <div className="skill-card__metadata">
        <span>v{skill.latestVersion}</span>
        <span>{formatBytes(skill.fileSize)}</span>
        <span>
          更新于 {new Date(skill.updatedAt).toLocaleDateString("zh-CN")}
        </span>
      </div>
      {!skill.preset ? (
        <div className="skill-card__actions">
          <Button
            size="compact"
            variant="secondary"
            aria-label={`编辑 ${skill.displayTitle}`}
            onClick={() => onEdit(skill)}
          >
            <Pencil size={14} aria-hidden="true" />
            编辑
          </Button>
          <Button
            size="compact"
            variant="text"
            className="skill-card__delete"
            aria-label={`删除 ${skill.displayTitle}`}
            onClick={() => onDelete(skill)}
          >
            <Trash2 size={14} aria-hidden="true" />
            删除
          </Button>
        </div>
      ) : null}
    </li>
  );
}

export function SkillsPage({ onAuthRequired }: SkillsPageProps) {
  const [list, setList] = useState<SkillList | null>(null);
  const [scope, setScope] = useState<SkillScope>("custom");
  const [search, setSearch] = useState("");
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [syncWarning, setSyncWarning] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SkillSummary | null>(null);
  const [pending, setPending] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editorInitialFocusRef = useRef<HTMLInputElement>(null);
  const authRef = useRef(onAuthRequired);
  authRef.current = onAuthRequired;

  useEffect(() => {
    let active = true;
    setLoadError(false);
    apiClient
      .listSkills(scope)
      .then((result) => {
        if (active) setList(result);
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (isAuthError(error)) authRef.current();
        else setLoadError(true);
      });
    return () => {
      active = false;
    };
  }, [scope, reloadKey]);

  function closeEditor() {
    setEditor(null);
    setFeedback(null);
  }

  function openCreate() {
    setFeedback(null);
    setSyncWarning(null);
    setEditor({ mode: "create", value: { ...emptyForm } });
  }

  function openEdit(skill: SkillSummary) {
    setFeedback(null);
    setSyncWarning(null);
    setEditor({
      mode: "edit",
      skill,
      value: {
        displayTitle: skill.displayTitle,
        description: skill.description,
        file: null,
      },
    });
  }

  function acceptFile(file: File | null) {
    if (!editor) return;
    setEditor({ ...editor, value: { ...editor.value, file } });
  }

  function onFilePicked(event: ChangeEvent<HTMLInputElement>) {
    acceptFile(event.target.files?.[0] ?? null);
    event.target.value = "";
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragActive(false);
    if (!editor) return;
    acceptFile(event.dataTransfer.files?.[0] ?? null);
  }

  async function saveSkill() {
    if (!editor || pending) return;
    const title = editor.value.displayTitle.trim();
    if (editor.mode === "create" && !editor.value.file) return;
    setPending(true);
    setFeedback(null);
    try {
      const titleArg = title || undefined;
      const descriptionArg = editor.value.description.trim() || undefined;
      const saved =
        editor.mode === "create"
          ? await apiClient.uploadSkill({
              file: editor.value.file!,
              ...(titleArg ? { displayTitle: titleArg } : {}),
              ...(descriptionArg ? { description: descriptionArg } : {}),
            })
          : await apiClient.updateSkill(editor.skill.id, {
              ...(editor.value.file ? { file: editor.value.file } : {}),
              ...(titleArg ? { displayTitle: titleArg } : {}),
              ...(descriptionArg ? { description: descriptionArg } : {}),
            });
      if (!saved.defaultAgentSync.synced) {
        setSyncWarning(
          "技能已保存，默认助手尚未完成同步。下次技能变更时会自动重试。",
        );
      }
      setEditor(null);
      setList(await apiClient.listSkills(scope));
    } catch (error) {
      if (isAuthError(error)) {
        onAuthRequired();
      } else {
        setFeedback(
          skillErrorMessage(
            error,
            editor.mode === "create"
              ? "技能无法创建，请检查文件后重试。"
              : "技能无法保存，请重试。",
          ),
        );
      }
    } finally {
      setPending(false);
    }
  }

  async function deleteSkill() {
    if (!deleteTarget || pending) return;
    setPending(true);
    setFeedback(null);
    try {
      await apiClient.deleteSkill(deleteTarget.id);
      setDeleteTarget(null);
      setList(await apiClient.listSkills(scope));
    } catch (error) {
      if (isAuthError(error)) {
        onAuthRequired();
      } else {
        setFeedback(skillErrorMessage(error, "技能无法删除，请重试。"));
        setDeleteTarget(null);
      }
    } finally {
      setPending(false);
    }
  }

  const skills = list?.skills ?? [];
  const filtered = search.trim()
    ? skills.filter((skill) =>
        `${skill.displayTitle} ${skill.name}`
          .toLowerCase()
          .includes(search.trim().toLowerCase()),
      )
    : skills;
  const createBlocked = editor?.mode === "create" && !editor.value.file;

  return (
    <div className="page page--wide skills-page">
      <PageHeader
        title="技能库"
        headingRef={headingRef}
        description="管理可复用的工作能力。上传技能后，默认助手会自动同步。"
        actions={
          <Button onClick={openCreate}>
            <Plus size={16} aria-hidden="true" />
            上传技能
          </Button>
        }
      />

      {feedback ? (
        <Alert className="skills-feedback" tone="danger">
          {feedback}
        </Alert>
      ) : null}
      {syncWarning && !editor ? (
        <Alert className="skills-feedback" tone="warning">
          {syncWarning}
        </Alert>
      ) : null}

      <div className="skills-toolbar">
        <div className="skills-tabs" role="tablist" aria-label="技能范围">
          <button
            type="button"
            role="tab"
            aria-selected={scope === "custom"}
            className={scope === "custom" ? "is-active" : undefined}
            onClick={() => setScope("custom")}
          >
            我的技能
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={scope === "preset"}
            className={scope === "preset" ? "is-active" : undefined}
            onClick={() => setScope("preset")}
          >
            预置技能
          </button>
        </div>
        <Input
          type="search"
          className="skills-search"
          placeholder="搜索技能名称"
          aria-label="搜索技能"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      {loadError ? (
        <EmptyState
          className="ui-empty-state--page"
          title="技能无法加载"
          action={
            <Button
              variant="secondary"
              onClick={() => setReloadKey((key) => key + 1)}
            >
              重试
            </Button>
          }
        />
      ) : list === null ? (
        <div className="skills-loading" aria-busy="true">
          <Spinner label="正在加载技能" />
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          className="ui-empty-state--page"
          title={
            scope === "custom" && !search.trim()
              ? "还没有技能"
              : "没有匹配的技能"
          }
          {...(scope === "custom" && !search.trim()
            ? {
                description: "上传第一个技能包，将自动同步到默认助手。",
              }
            : {})}
          {...(scope === "custom" && !search.trim()
            ? {
                action: (
                  <Button variant="secondary" onClick={openCreate}>
                    <Plus size={16} aria-hidden="true" />
                    上传技能
                  </Button>
                ),
              }
            : {})}
        />
      ) : (
        <ul className="skill-cards" aria-label="技能">
          {filtered.map((skill) => (
            <SkillCard
              key={skill.id}
              skill={skill}
              deleting={pending && deleteTarget?.id === skill.id}
              onEdit={openEdit}
              onDelete={setDeleteTarget}
            />
          ))}
        </ul>
      )}

      <Dialog
        open={editor !== null}
        title={editor?.mode === "create" ? "上传技能" : "编辑技能"}
        eyebrow="技能库"
        onClose={closeEditor}
        closeLabel="关闭技能编辑"
        closeDisabled={pending}
        initialFocusRef={editorInitialFocusRef}
        footer={
          editor ? (
            <>
              <Button
                variant="secondary"
                onClick={closeEditor}
                disabled={pending}
              >
                取消
              </Button>
              <Button
                type="submit"
                form="skill-editor-form"
                loading={pending}
                disabled={createBlocked}
              >
                {editor.mode === "create" ? "上传" : "保存修改"}
              </Button>
            </>
          ) : null
        }
      >
        {editor ? (
          <>
            <form
              id="skill-editor-form"
              className="skill-editor-form"
              onSubmit={(event: SyntheticEvent<HTMLFormElement>) => {
                event.preventDefault();
                void saveSkill();
              }}
            >
              <Field label="技能包">
                <div
                  className={
                    dragActive ? "skill-dropzone is-dragging" : "skill-dropzone"
                  }
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDragActive(true);
                  }}
                  onDragLeave={() => setDragActive(false)}
                  onDrop={onDrop}
                >
                  <CloudUpload size={28} aria-hidden="true" />
                  {editor.value.file ? (
                    <p className="skill-dropzone__file">
                      {editor.value.file.name}
                    </p>
                  ) : (
                    <p>
                      {editor.mode === "create"
                        ? "选择或拖入技能包"
                        : "替换技能包（可选）"}
                    </p>
                  )}
                  <span className="skill-dropzone__hint">
                    ZIP 文件，最大 50 MB
                  </span>
                  <div className="skill-dropzone__actions">
                    <Button
                      size="compact"
                      variant="secondary"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      选择文件
                    </Button>
                    {editor.value.file ? (
                      <Button
                        size="compact"
                        variant="text"
                        onClick={() => acceptFile(null)}
                      >
                        移除
                      </Button>
                    ) : null}
                  </div>
                  <input
                    ref={fileInputRef}
                    className="file-input"
                    type="file"
                    accept=".zip,application/zip"
                    aria-label="技能包文件"
                    onChange={onFilePicked}
                    tabIndex={-1}
                  />
                </div>
              </Field>
              <Field label="标题">
                <Input
                  ref={editorInitialFocusRef}
                  value={editor.value.displayTitle}
                  maxLength={80}
                  placeholder={
                    editor.mode === "create" ? "留空时使用文件名称" : undefined
                  }
                  onChange={(event) =>
                    setEditor({
                      ...editor,
                      value: {
                        ...editor.value,
                        displayTitle: event.target.value,
                      },
                    })
                  }
                />
              </Field>
              <Field label="描述">
                <Textarea
                  value={editor.value.description}
                  maxLength={300}
                  rows={3}
                  onChange={(event) =>
                    setEditor({
                      ...editor,
                      value: {
                        ...editor.value,
                        description: event.target.value,
                      },
                    })
                  }
                />
              </Field>
            </form>
            {feedback ? (
              <Alert className="skills-dialog-feedback" tone="danger">
                {feedback}
              </Alert>
            ) : null}
          </>
        ) : null}
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        title="删除技能？"
        onClose={() => setDeleteTarget(null)}
        closeDisabled={pending}
        hideCloseButton
        fallbackFocusRef={headingRef}
        footer={
          deleteTarget ? (
            <>
              <Button
                data-dialog-initial-focus
                variant="secondary"
                onClick={() => setDeleteTarget(null)}
                disabled={pending}
              >
                取消
              </Button>
              <Button
                variant="danger"
                loading={pending}
                onClick={() => void deleteSkill()}
              >
                删除技能
              </Button>
            </>
          ) : null
        }
      >
        {deleteTarget ? (
          <p className="skill-dialog-copy">
            删除 <strong>{deleteTarget.displayTitle}</strong>
            。已绑定该技能的助手仍可继续工作，默认助手会自动更新。
          </p>
        ) : null}
      </Dialog>
    </div>
  );
}

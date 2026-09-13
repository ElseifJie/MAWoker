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
      return "That file is not a valid Skill package. Upload a non-empty .zip archive up to 50 MB.";
    }
    if (error.code === "QUOTA_EXCEEDED") {
      return "Your Skill could not be synced to your default Agent because the personal Agent quota is exhausted.";
    }
    if (error.retryable) {
      return "The Skill service is temporarily unavailable. Try again.";
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
          <h3>{skill.displayTitle || skill.fileName || "Skill"}</h3>
          {skill.name ? (
            <code className="skill-card__name">{skill.name}</code>
          ) : null}
        </div>
        <Badge tone={skillStatusTone(skill.status)}>{skill.status}</Badge>
      </div>
      <p className="skill-card__description">
        {skill.description || "No description"}
      </p>
      <div className="skill-card__metadata">
        <span>v{skill.latestVersion}</span>
        <span>{formatBytes(skill.fileSize)}</span>
        <span>Updated {new Date(skill.updatedAt).toLocaleDateString()}</span>
      </div>
      {!skill.preset ? (
        <div className="skill-card__actions">
          <Button
            size="compact"
            variant="secondary"
            aria-label={`Edit ${skill.displayTitle}`}
            onClick={() => onEdit(skill)}
          >
            <Pencil size={14} aria-hidden="true" />
            Edit
          </Button>
          <Button
            size="compact"
            variant="text"
            className="skill-card__delete"
            aria-label={`Delete ${skill.displayTitle}`}
            onClick={() => onDelete(skill)}
          >
            <Trash2 size={14} aria-hidden="true" />
            Delete
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
          "This Skill is saved, but your default Agent could not be re-synced. The next Skill change retries automatically.",
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
              ? "The Skill could not be created. Check the file and try again."
              : "The Skill could not be saved. Try again.",
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
        setFeedback(skillErrorMessage(error, "The Skill could not be deleted."));
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
    <div className="page page--wide">
      <PageHeader
        title="Skills"
        headingRef={headingRef}
        description="Reusable capability packages your Agents can load. Upload once, and your default Agent always carries every Skill you own."
        actions={
          <Button onClick={openCreate}>
            <Plus size={16} aria-hidden="true" />
            New skill
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
        <div
          className="skills-tabs"
          role="tablist"
          aria-label="Skill scope"
        >
          <button
            type="button"
            role="tab"
            aria-selected={scope === "custom"}
            className={scope === "custom" ? "is-active" : undefined}
            onClick={() => setScope("custom")}
          >
            Custom
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={scope === "preset"}
            className={scope === "preset" ? "is-active" : undefined}
            onClick={() => setScope("preset")}
          >
            Preset
          </button>
        </div>
        <Input
          type="search"
          className="skills-search"
          placeholder="Search skills"
          aria-label="Search skills"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      {loadError ? (
        <EmptyState
          title="Skills could not be loaded."
          action={
            <Button
              variant="secondary"
              onClick={() => setReloadKey((key) => key + 1)}
            >
              Retry
            </Button>
          }
        />
      ) : list === null ? (
        <div className="skills-loading" aria-busy="true">
          <Spinner label="Loading skills" />
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          title={
            scope === "custom" && !search.trim()
              ? "No skills yet."
              : "No matching skills."
          }
          {...(scope === "custom" && !search.trim()
            ? {
                description:
                  "Create your first Skill — it is added to your default Agent automatically.",
              }
            : {})}
          {...(scope === "custom" && !search.trim()
            ? {
                action: (
                  <Button variant="secondary" onClick={openCreate}>
                    <Plus size={16} aria-hidden="true" />
                    New skill
                  </Button>
                ),
              }
            : {})}
        />
      ) : (
        <ul className="skill-cards" aria-label="Skills">
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
        title={editor?.mode === "create" ? "Create skill" : "Edit skill"}
        eyebrow="Skills"
        onClose={closeEditor}
        closeLabel="Close skill editor"
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
                Cancel
              </Button>
              <Button
                type="submit"
                form="skill-editor-form"
                loading={pending}
                disabled={createBlocked}
              >
                {editor.mode === "create" ? "Create" : "Save changes"}
              </Button>
            </>
          ) : null
        }
      >
        {editor ? (
          <>
            <div className="skills-source-tabs" role="tablist" aria-label="Source">
              <button type="button" className="is-active" role="tab" aria-selected>
                Local upload
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={false}
                disabled
                title="GitHub import is coming soon"
              >
                GitHub
              </button>
            </div>
            <form
              id="skill-editor-form"
              className="skill-editor-form"
              onSubmit={(event: SyntheticEvent<HTMLFormElement>) => {
                event.preventDefault();
                void saveSkill();
              }}
            >
              <Field label="Skill package">
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
                        ? "Click or drag a Skill package to upload"
                        : "Replace the package (optional)"}
                    </p>
                  )}
                  <span className="skill-dropzone__hint">
                    .zip archive, up to 50 MB
                  </span>
                  <div className="skill-dropzone__actions">
                    <Button
                      size="compact"
                      variant="secondary"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      Choose file
                    </Button>
                    {editor.value.file ? (
                      <Button
                        size="compact"
                        variant="text"
                        onClick={() => acceptFile(null)}
                      >
                        Remove
                      </Button>
                    ) : null}
                  </div>
                  <input
                    ref={fileInputRef}
                    className="file-input"
                    type="file"
                    accept=".zip,application/zip"
                    aria-label="Skill package file"
                    onChange={onFilePicked}
                    tabIndex={-1}
                  />
                </div>
              </Field>
              <Field label="Title">
                <Input
                  ref={editorInitialFocusRef}
                  value={editor.value.displayTitle}
                  maxLength={80}
                  placeholder={
                    editor.mode === "create"
                      ? "Defaults to the file name"
                      : undefined
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
              <Field label="Description">
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
        title="Delete skill?"
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
                Cancel
              </Button>
              <Button
                variant="danger"
                loading={pending}
                onClick={() => void deleteSkill()}
              >
                Delete skill
              </Button>
            </>
          ) : null
        }
      >
        {deleteTarget ? (
          <p className="skill-dialog-copy">
            Delete <strong>{deleteTarget.displayTitle}</strong>. Agents that
            bound it keep working, and your default Agent is updated
            automatically.
          </p>
        ) : null}
      </Dialog>
    </div>
  );
}

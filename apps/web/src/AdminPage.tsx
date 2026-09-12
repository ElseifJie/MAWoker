import {
  Bot,
  KeyRound,
  Pencil,
  Plus,
  Power,
  Trash2,
  Users,
} from "lucide-react";
import { type SyntheticEvent, useEffect, useRef, useState } from "react";
import { Link, Navigate, Route, Routes } from "react-router-dom";
import { PASSWORD_MIN_LENGTH } from "@pwa/contracts";
import {
  ApiClientError,
  apiClient,
  type AdminPlatformAgent,
  type AdminQuota,
  type AdminUserRole,
  type AdminUserSummary,
} from "./api.js";
import {
  Alert,
  AppShell,
  Badge,
  Button,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  Input,
  PageHeader,
  PasswordInput,
  Select,
  Spinner,
  Textarea,
  type BadgeTone,
} from "./ui/index.js";

interface AdminWorkspaceProps {
  onSignedOut: () => void;
  onAuthRequired: () => void;
}

interface AdminData {
  agents: AdminPlatformAgent[];
  users: AdminUserSummary[];
  models: string[];
}

const UNCONFIGURABLE_CAPABILITIES = [
  "Skills",
  "Custom Tools",
  "Multi Agents",
  "MCPs",
];

function platformAgentStatusTone(
  status: AdminPlatformAgent["status"],
): BadgeTone {
  if (status === "active") return "success";
  if (status === "failed") return "danger";
  if (status === "provisioning" || status === "deleting") return "warning";
  return "neutral";
}

function AdminPlatformAgentsPage({
  agents,
  models,
  onAgentsChanged,
  onAuthRequired,
}: {
  agents: AdminPlatformAgent[];
  models: string[];
  onAgentsChanged: (agents: AdminPlatformAgent[]) => void;
  onAuthRequired: () => void;
}) {
  type AgentForm = Pick<
    AdminPlatformAgent,
    "name" | "description" | "modelId" | "systemPrompt"
  >;
  type Editor =
    | { mode: "create"; value: AgentForm }
    | { mode: "edit"; agent: AdminPlatformAgent; value: AgentForm };

  const [editor, setEditor] = useState<Editor | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AdminPlatformAgent | null>(
    null,
  );
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const editorInitialFocusRef = useRef<HTMLInputElement>(null);

  // Keep an out-of-allowlist model selectable so the dropdown cannot silently
  // rewrite it to the first allowlisted model.
  const offAllowlistModel =
    editor && editor.value.modelId && !models.includes(editor.value.modelId)
      ? editor.value.modelId
      : undefined;
  const modelOptions = offAllowlistModel
    ? [offAllowlistModel, ...models]
    : models;

  function closeEditor() {
    setEditor(null);
    setFeedback(null);
  }

  function closeDeleteDialog() {
    setDeleteTarget(null);
    setFeedback(null);
  }

  function handleError(error: unknown, operation: "save" | "delete") {
    if (error instanceof ApiClientError && error.isAuthRequired) {
      onAuthRequired();
      return;
    }
    if (error instanceof ApiClientError && error.code === "ARK_CONFLICT") {
      setFeedback(
        "This Agent changed elsewhere. Reload the page before saving again.",
      );
      return;
    }
    if (
      operation === "delete" &&
      error instanceof ApiClientError &&
      error.status === 409
    ) {
      setFeedback(
        "This Agent is still assigned to users or referenced by Sessions.",
      );
      return;
    }
    setFeedback(
      error instanceof ApiClientError && error.retryable
        ? "Ark is temporarily unavailable. Try again."
        : `The Agent could not be ${operation === "save" ? "saved" : "deleted"}.`,
    );
  }

  function replaceAgent(agent: AdminPlatformAgent) {
    onAgentsChanged(
      agents.some((candidate) => candidate.id === agent.id)
        ? agents.map((candidate) =>
            candidate.id === agent.id ? agent : candidate,
          )
        : [...agents, agent],
    );
  }

  async function saveAgent(
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ) {
    event.preventDefault();
    if (!editor || pending) return;
    setPending(true);
    setFeedback(null);
    try {
      const saved =
        editor.mode === "create"
          ? await apiClient.createAdminPlatformAgent(editor.value)
          : await apiClient.updateAdminPlatformAgent(editor.agent.id, {
              ...editor.value,
              arkVersion: editor.agent.arkVersion,
            });
      replaceAgent(saved);
      setEditor(null);
    } catch (error) {
      handleError(error, "save");
    } finally {
      setPending(false);
    }
  }

  async function toggleStatus(agent: AdminPlatformAgent) {
    if (pending || (agent.status !== "active" && agent.status !== "disabled")) {
      return;
    }
    setPending(true);
    setFeedback(null);
    try {
      replaceAgent(
        await apiClient.updateAdminPlatformAgent(agent.id, {
          status: agent.status === "active" ? "disabled" : "active",
        }),
      );
    } catch (error) {
      handleError(error, "save");
    } finally {
      setPending(false);
    }
  }

  async function deleteAgent() {
    if (!deleteTarget || pending) return;
    setPending(true);
    setFeedback(null);
    try {
      await apiClient.deleteAdminPlatformAgent(deleteTarget.id);
      onAgentsChanged(agents.filter((agent) => agent.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (error) {
      handleError(error, "delete");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="page admin-page">
      <PageHeader
        eyebrow="Administration"
        title="Platform Agents"
        description="Manage shared Agent configurations without accessing user content."
        headingRef={headingRef}
        actions={
          <Button
            onClick={() => {
              setFeedback(null);
              setEditor({
                mode: "create",
                value: {
                  name: "",
                  description: "",
                  modelId: models[0] ?? "",
                  systemPrompt: "",
                },
              });
            }}
          >
            <Plus size={16} aria-hidden="true" />
            New platform Agent
          </Button>
        }
      />

      {feedback && !editor && !deleteTarget ? (
        <Alert className="admin-page-feedback" tone="danger">
          {feedback}
        </Alert>
      ) : null}

      <DataTable
        caption="Platform Agents"
        className="admin-agent-table"
        minWidth="wide"
      >
        <thead>
          <tr>
            <th scope="col">Agent</th>
            <th scope="col">Model</th>
            <th scope="col">Current Ark version</th>
            <th scope="col">Status</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((agent) => (
            <tr key={agent.id}>
              <th scope="row" data-label="Agent">
                <div className="admin-agent-summary">
                  <strong>{agent.name}</strong>
                  <span>{agent.description || "No description"}</span>
                </div>
              </th>
              <td className="admin-agent-model" data-label="Model">
                <span>{agent.modelId}</span>
              </td>
              <td data-label="Current Ark version">
                <span>{agent.arkVersion}</span>
              </td>
              <td data-label="Status">
                <div className="admin-status-stack">
                  <Badge tone={platformAgentStatusTone(agent.status)}>
                    {agent.status}
                  </Badge>
                  {agent.lastErrorCode ? (
                    <Badge tone="danger">Sync needs attention</Badge>
                  ) : null}
                </div>
              </td>
              <td data-label="Actions">
                <div className="admin-row-actions">
                  <Button
                    size="compact"
                    variant="secondary"
                    aria-label={`Edit ${agent.name}`}
                    onClick={() => {
                      setFeedback(null);
                      setEditor({
                        mode: "edit",
                        agent,
                        value: {
                          name: agent.name,
                          description: agent.description,
                          modelId: agent.modelId,
                          systemPrompt: agent.systemPrompt,
                        },
                      });
                    }}
                    disabled={pending || agent.status === "deleting"}
                  >
                    <Pencil size={14} aria-hidden="true" />
                    Edit
                  </Button>
                  {agent.status === "active" || agent.status === "disabled" ? (
                    <Button
                      size="compact"
                      variant="secondary"
                      aria-label={`${agent.status === "active" ? "Disable" : "Enable"} ${agent.name}`}
                      onClick={() => void toggleStatus(agent)}
                      disabled={pending}
                    >
                      <Power size={14} aria-hidden="true" />
                      {agent.status === "active" ? "Disable" : "Enable"}
                    </Button>
                  ) : null}
                  <Button
                    size="compact"
                    variant="text"
                    className="admin-delete-action"
                    aria-label={`Delete ${agent.name}`}
                    onClick={() => {
                      setFeedback(null);
                      setDeleteTarget(agent);
                    }}
                    disabled={pending || agent.status === "deleting"}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                    Delete
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </DataTable>

      <Dialog
        open={editor !== null}
        title={editor?.mode === "create" ? "Create Agent" : "Edit Agent"}
        eyebrow="Platform Agent"
        onClose={closeEditor}
        closeLabel="Close Agent editor"
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
                form="admin-agent-editor-form"
                loading={pending}
                disabled={
                  editor.value.name.trim().length === 0 ||
                  editor.value.modelId.trim().length === 0
                }
              >
                <span className="admin-loading-icon-slot" aria-hidden="true">
                  {pending ? <Spinner size={15} /> : null}
                </span>
                {editor.mode === "create" ? "Create Agent" : "Save changes"}
              </Button>
            </>
          ) : null
        }
      >
        {editor ? (
          <>
            <form
              id="admin-agent-editor-form"
              className="admin-agent-editor-form"
              onSubmit={saveAgent}
            >
              <section
                className="agent-form-section"
                aria-labelledby="agent-section-basic"
              >
                <header className="agent-form-section__header">
                  <span className="agent-form-section__index">01</span>
                  <div>
                    <h3 id="agent-section-basic">Basic information</h3>
                    <p>How this Agent is identified in the workspace picker.</p>
                  </div>
                </header>
                <div className="agent-form-section__body">
                  <Field label="Agent name">
                    <Input
                      ref={editorInitialFocusRef}
                      value={editor.value.name}
                      maxLength={80}
                      required
                      onChange={(event) =>
                        setEditor({
                          ...editor,
                          value: { ...editor.value, name: event.target.value },
                        })
                      }
                    />
                  </Field>
                  <Field label="Description">
                    <Textarea
                      value={editor.value.description}
                      maxLength={500}
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
                </div>
              </section>

              <section
                className="agent-form-section"
                aria-labelledby="agent-section-model"
              >
                <header className="agent-form-section__header">
                  <span className="agent-form-section__index">02</span>
                  <div>
                    <h3 id="agent-section-model">Model configuration</h3>
                    <p>Only models on the workspace allowlist can be used.</p>
                  </div>
                </header>
                <div className="agent-form-section__body">
                  <Field label="Model">
                    <Select
                      value={editor.value.modelId}
                      required
                      onChange={(event) =>
                        setEditor({
                          ...editor,
                          value: {
                            ...editor.value,
                            modelId: event.target.value,
                          },
                        })
                      }
                    >
                      {modelOptions.map((model) => (
                        <option key={model} value={model}>
                          {model}
                          {model === offAllowlistModel ? " (not allowed)" : ""}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
              </section>

              <section
                className="agent-form-section"
                aria-labelledby="agent-section-prompt"
              >
                <header className="agent-form-section__header">
                  <span className="agent-form-section__index">03</span>
                  <div>
                    <h3 id="agent-section-prompt">System Prompt</h3>
                    <p>Defines the role, boundaries, and reply style.</p>
                  </div>
                </header>
                <div className="agent-form-section__body">
                  <Field label="System">
                    <Textarea
                      value={editor.value.systemPrompt}
                      maxLength={32_000}
                      rows={8}
                      onChange={(event) =>
                        setEditor({
                          ...editor,
                          value: {
                            ...editor.value,
                            systemPrompt: event.target.value,
                          },
                        })
                      }
                    />
                  </Field>
                </div>
              </section>

              <section
                className="agent-form-section"
                aria-labelledby="agent-section-capabilities"
              >
                <header className="agent-form-section__header">
                  <span className="agent-form-section__index">04</span>
                  <div>
                    <h3 id="agent-section-capabilities">
                      Capability extensions
                    </h3>
                    <p>Managed by the platform and not editable per Agent.</p>
                  </div>
                </header>
                <dl className="agent-capability-list">
                  <div>
                    <dt>Tools</dt>
                    <dd>
                      <Badge tone="info">Managed</Badge>
                      Every Platform Agent runs with the platform toolset.
                    </dd>
                  </div>
                  {UNCONFIGURABLE_CAPABILITIES.map((capability) => (
                    <div key={capability}>
                      <dt>{capability}</dt>
                      <dd>
                        <Badge tone="neutral">Unavailable</Badge>
                        Not available in this deployment.
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            </form>
            {editor.mode === "edit" ? (
              <p className="form-note">
                Current Ark version: {editor.agent.arkVersion}
              </p>
            ) : null}
            {feedback ? (
              <Alert className="admin-dialog-feedback" tone="danger">
                {feedback}
              </Alert>
            ) : null}
          </>
        ) : null}
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        title="Delete platform Agent?"
        onClose={closeDeleteDialog}
        closeLabel="Close platform Agent deletion"
        closeDisabled={pending}
        fallbackFocusRef={headingRef}
        footer={
          deleteTarget ? (
            <>
              <Button
                data-dialog-initial-focus
                variant="secondary"
                onClick={closeDeleteDialog}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => void deleteAgent()}
                loading={pending}
              >
                Delete Agent
              </Button>
            </>
          ) : null
        }
      >
        {deleteTarget ? (
          <>
            <p className="admin-dialog-copy">
              Delete <strong>{deleteTarget.name}</strong>. The server will
              reject this action while users or Sessions still reference it.
            </p>
            {feedback ? (
              <Alert className="admin-dialog-feedback" tone="danger">
                {feedback}
              </Alert>
            ) : null}
          </>
        ) : null}
      </Dialog>
    </div>
  );
}

function AdminUsersPage({
  agents,
  users,
  onUserChanged,
  onUsersChanged,
  onAuthRequired,
}: {
  agents: AdminPlatformAgent[];
  users: AdminUserSummary[];
  onUserChanged: (user: AdminUserSummary) => void;
  onUsersChanged: (users: AdminUserSummary[]) => void;
  onAuthRequired: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<CreateUserDraft>(emptyUserDraft);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  function closeDialog() {
    if (pending) return;
    setCreating(false);
    setDraft(emptyUserDraft);
    setFeedback(null);
  }

  async function createUser(
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ) {
    event.preventDefault();
    if (pending) return;
    if (draft.password !== draft.confirmPassword) {
      setFeedback("The passwords do not match.");
      return;
    }
    setPending(true);
    setFeedback(null);
    try {
      await apiClient.createAdminUser({
        email: draft.email.trim().toLowerCase(),
        password: draft.password,
        role: draft.role,
      });
      const refreshed = await apiClient.listAdminUsers();
      onUsersChanged(refreshed.users);
      setCreating(false);
      setDraft(emptyUserDraft);
    } catch (error) {
      if (error instanceof ApiClientError && error.isAuthRequired) {
        onAuthRequired();
        return;
      }
      setFeedback(
        userAdminErrorMessage(error, "The user could not be created."),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="page admin-page">
      <PageHeader
        eyebrow="Administration"
        title="Users"
        description="Create accounts and manage default Agents and limits. Users sign in with the email and password set here."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus size={16} aria-hidden="true" />
            New user
          </Button>
        }
      />
      <section className="admin-user-records" aria-label="User administration">
        {users.length === 0 ? (
          <EmptyState
            title="No users yet"
            description="Create the first account to let someone sign in."
          />
        ) : null}
        {users.map((user) => (
          <AdminUserRecord
            key={user.id}
            agents={agents}
            user={user}
            onUserChanged={onUserChanged}
            onAuthRequired={onAuthRequired}
          />
        ))}
      </section>

      <Dialog
        open={creating}
        title="New user"
        eyebrow="User account"
        onClose={closeDialog}
        closeLabel="Close new user dialog"
        closeDisabled={pending}
        initialFocusRef={emailRef}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={closeDialog}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              form="admin-user-create-form"
              loading={pending}
              disabled={!createUserReady(draft)}
            >
              <span className="admin-loading-icon-slot" aria-hidden="true">
                {pending ? <Spinner size={15} /> : null}
              </span>
              Create user
            </Button>
          </>
        }
      >
        <form
          id="admin-user-create-form"
          className="admin-agent-editor-form"
          onSubmit={createUser}
        >
          <Field label="Email">
            <Input
              ref={emailRef}
              type="email"
              autoComplete="off"
              value={draft.email}
              maxLength={320}
              required
              disabled={pending}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  email: event.target.value,
                }))
              }
            />
          </Field>
          <Field
            label="Password"
            hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
            error={passwordRequirementError(draft.password)}
          >
            <PasswordInput
              autoComplete="new-password"
              value={draft.password}
              minLength={PASSWORD_MIN_LENGTH}
              maxLength={200}
              required
              disabled={pending}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  password: event.target.value,
                }))
              }
            />
          </Field>
          <Field
            label="Confirm password"
            error={passwordMatchError(draft.confirmPassword, draft.password)}
          >
            <PasswordInput
              autoComplete="new-password"
              value={draft.confirmPassword}
              minLength={PASSWORD_MIN_LENGTH}
              maxLength={200}
              required
              disabled={pending}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  confirmPassword: event.target.value,
                }))
              }
            />
          </Field>
          <Field label="Role">
            <Select
              value={draft.role}
              disabled={pending}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  role: event.target.value as AdminUserRole,
                }))
              }
            >
              <option value="user">User</option>
              <option value="admin">Administrator</option>
            </Select>
          </Field>
        </form>
        {feedback ? (
          <Alert className="admin-dialog-feedback" tone="danger">
            {feedback}
          </Alert>
        ) : null}
      </Dialog>
    </div>
  );
}

type QuotaDraft = Record<keyof AdminQuota, string>;

interface CreateUserDraft {
  email: string;
  password: string;
  confirmPassword: string;
  role: AdminUserRole;
}

const emptyUserDraft: CreateUserDraft = {
  email: "",
  password: "",
  confirmPassword: "",
  role: "user",
};

function createUserReady(draft: CreateUserDraft): boolean {
  return (
    draft.email.trim().length > 0 &&
    draft.password.length >= PASSWORD_MIN_LENGTH &&
    draft.password === draft.confirmPassword
  );
}

function passwordRequirementError(value: string): string | undefined {
  if (value.length === 0) return undefined;
  return value.length < PASSWORD_MIN_LENGTH
    ? `Password does not meet the requirements — use at least ${PASSWORD_MIN_LENGTH} characters.`
    : undefined;
}

function passwordMatchError(
  confirm: string,
  password: string,
): string | undefined {
  if (confirm.length === 0) return undefined;
  return confirm === password ? undefined : "The passwords do not match.";
}

function userAdminErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiClientError) {
    if (error.code === "USER_EMAIL_CONFLICT") {
      return "A user with this email already exists.";
    }
    if (error.code === "VALIDATION_FAILED") {
      return `Check the email and password (at least ${PASSWORD_MIN_LENGTH} characters).`;
    }
    if (error.retryable) {
      return "The service is temporarily unavailable. Try again.";
    }
  }
  return fallback;
}

function quotaDraft(quota: AdminQuota): QuotaDraft {
  return {
    personalAgentLimit: String(quota.personalAgentLimit),
    concurrentSessionLimit: String(quota.concurrentSessionLimit),
    dailySessionLimit: String(quota.dailySessionLimit),
    monthlyTokenLimit: String(quota.monthlyTokenLimit),
  };
}

function parsedQuota(draft: QuotaDraft): AdminQuota | null {
  if (Object.values(draft).some((value) => value.trim().length === 0)) {
    return null;
  }
  const values = {
    personalAgentLimit: Number(draft.personalAgentLimit),
    concurrentSessionLimit: Number(draft.concurrentSessionLimit),
    dailySessionLimit: Number(draft.dailySessionLimit),
    monthlyTokenLimit: Number(draft.monthlyTokenLimit),
  };
  return Object.values(values).every(
    (value) => Number.isSafeInteger(value) && value >= 0,
  )
    ? values
    : null;
}

interface AdminUserRecordProps {
  agents: AdminPlatformAgent[];
  user: AdminUserSummary;
  onUserChanged: (user: AdminUserSummary) => void;
  onAuthRequired: () => void;
}

function AdminUserRecord({
  agents,
  user,
  onUserChanged,
  onAuthRequired,
}: AdminUserRecordProps) {
  const [selectedAgentId, setSelectedAgentId] = useState(
    user.defaultAgentId ?? "",
  );
  const [quota, setQuota] = useState<QuotaDraft>(() => quotaDraft(user.quota));
  const [pending, setPending] = useState<"agent" | "quota" | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetDraft, setResetDraft] = useState({
    password: "",
    confirmPassword: "",
  });
  const [resetPending, setResetPending] = useState(false);
  const [resetFeedback, setResetFeedback] = useState<string | null>(null);
  const resetPasswordRef = useRef<HTMLInputElement>(null);
  const {
    personalAgentLimit,
    concurrentSessionLimit,
    dailySessionLimit,
    monthlyTokenLimit,
  } = user.quota;
  const activeSelection = agents.some(
    (agent) => agent.id === selectedAgentId && agent.status === "active",
  );
  const selectableAgents = agents.filter(
    (agent) => agent.status === "active",
  ).length;
  const quotaValue = parsedQuota(quota);
  const controlsDisabled = pending !== null || user.status !== "active";

  useEffect(() => {
    setSelectedAgentId(user.defaultAgentId ?? "");
  }, [user.defaultAgentId]);

  useEffect(() => {
    setQuota(
      quotaDraft({
        personalAgentLimit,
        concurrentSessionLimit,
        dailySessionLimit,
        monthlyTokenLimit,
      }),
    );
  }, [
    concurrentSessionLimit,
    dailySessionLimit,
    monthlyTokenLimit,
    personalAgentLimit,
  ]);

  function fail(error: unknown) {
    if (error instanceof ApiClientError && error.isAuthRequired) {
      onAuthRequired();
      return;
    }
    setFeedback(
      error instanceof ApiClientError && error.retryable
        ? "The service is temporarily unavailable. Try again."
        : "Changes could not be saved. Review the values and try again.",
    );
  }

  async function saveDefaultAgent() {
    if (!activeSelection || controlsDisabled) return;
    setPending("agent");
    setFeedback(null);
    try {
      const assignment = await apiClient.assignAdminDefaultAgent(
        user.id,
        selectedAgentId,
      );
      onUserChanged({
        ...user,
        defaultAgentId: assignment.platformAgentId,
      });
      setFeedback("Default Agent saved.");
    } catch (error) {
      fail(error);
    } finally {
      setPending(null);
    }
  }

  async function saveQuota() {
    if (!quotaValue || controlsDisabled) return;
    setPending("quota");
    setFeedback(null);
    try {
      const updated = await apiClient.updateAdminUserQuota(user.id, quotaValue);
      const nextQuota = {
        personalAgentLimit: updated.personalAgentLimit,
        concurrentSessionLimit: updated.concurrentSessionLimit,
        dailySessionLimit: updated.dailySessionLimit,
        monthlyTokenLimit: updated.monthlyTokenLimit,
      };
      setQuota(quotaDraft(nextQuota));
      onUserChanged({ ...user, quota: nextQuota });
      setFeedback("Quotas saved.");
    } catch (error) {
      fail(error);
    } finally {
      setPending(null);
    }
  }

  function openResetDialog() {
    setResetDraft({ password: "", confirmPassword: "" });
    setResetFeedback(null);
    setResetOpen(true);
  }

  function closeResetDialog() {
    if (resetPending) return;
    setResetOpen(false);
    setResetFeedback(null);
  }

  async function submitReset(
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ) {
    event.preventDefault();
    if (resetPending) return;
    if (resetDraft.password !== resetDraft.confirmPassword) {
      setResetFeedback("The passwords do not match.");
      return;
    }
    setResetPending(true);
    setResetFeedback(null);
    try {
      await apiClient.resetAdminUserPassword(user.id, resetDraft.password);
      onUserChanged({ ...user, hasPassword: true });
      setResetOpen(false);
      setFeedback("Password reset.");
    } catch (error) {
      if (error instanceof ApiClientError && error.isAuthRequired) {
        onAuthRequired();
        return;
      }
      setResetFeedback(
        userAdminErrorMessage(error, "The password could not be reset."),
      );
    } finally {
      setResetPending(false);
    }
  }

  const quotaFields: Array<{
    key: keyof AdminQuota;
    label: string;
  }> = [
    { key: "personalAgentLimit", label: "Personal Agent limit" },
    { key: "concurrentSessionLimit", label: "Concurrent Session limit" },
    { key: "dailySessionLimit", label: "Daily Session limit" },
    { key: "monthlyTokenLimit", label: "Monthly token limit" },
  ];

  const identityHeadingId = `admin-user-identity-${user.id}`;
  const userHeadingId = `admin-user-${user.id}`;
  const defaultAgentHeadingId = `admin-user-default-agent-${user.id}`;
  const quotaHeadingId = `admin-user-quotas-${user.id}`;
  const feedbackSucceeded = /(saved|reset)\.$/.test(feedback ?? "");

  return (
    <section className="admin-user-record" aria-labelledby={userHeadingId}>
      <section
        className="admin-user-group admin-user-identity"
        aria-labelledby={identityHeadingId}
      >
        <div className="admin-user-identity__summary">
          <h2 id={userHeadingId}>{user.email}</h2>
          <div className="admin-user-identity__badges">
            <Badge tone={user.role === "admin" ? "info" : "neutral"}>
              {user.role === "admin" ? "Administrator" : "User"}
            </Badge>
            <Badge tone={user.hasPassword ? "neutral" : "warning"}>
              {user.hasPassword ? "Password set" : "No password"}
            </Badge>
            <Badge tone={user.status === "active" ? "success" : "neutral"}>
              {user.status}
            </Badge>
          </div>
        </div>
        <h3 className="admin-user-group__label" id={identityHeadingId}>
          Identity
        </h3>
        <Button
          size="compact"
          variant="secondary"
          aria-label={`Reset password for ${user.email}`}
          onClick={openResetDialog}
        >
          <KeyRound size={14} aria-hidden="true" />
          Reset password
        </Button>
        {feedback ? (
          <Alert
            className="admin-user-feedback"
            tone={feedbackSucceeded ? "success" : "danger"}
            role={feedbackSucceeded ? "status" : "alert"}
          >
            {feedback}
          </Alert>
        ) : null}
      </section>

      {user.role === "user" ? (
        <>
          <section
            className="admin-user-group admin-user-default-agent"
            aria-labelledby={defaultAgentHeadingId}
          >
            <h3 className="admin-user-group__label" id={defaultAgentHeadingId}>
              Default Agent
            </h3>
            <div className="admin-default-agent-controls">
              <Select
                aria-label={`Default Agent for ${user.email}`}
                value={selectedAgentId}
                onChange={(event) => setSelectedAgentId(event.target.value)}
                disabled={controlsDisabled}
              >
                <option value="" disabled>
                  Select Agent
                </option>
                {agents.map((agent) => (
                  <option
                    key={agent.id}
                    value={agent.id}
                    disabled={agent.status !== "active"}
                  >
                    {agent.name}
                  </option>
                ))}
              </Select>
              <Button
                size="compact"
                variant="secondary"
                aria-label={`Save default Agent for ${user.email}`}
                onClick={() => void saveDefaultAgent()}
                loading={pending === "agent"}
                disabled={
                  controlsDisabled ||
                  !activeSelection ||
                  selectedAgentId === user.defaultAgentId
                }
              >
                <span className="admin-loading-icon-slot" aria-hidden="true">
                  {pending === "agent" ? <Spinner size={14} /> : null}
                </span>
                Save
              </Button>
            </div>
            {agents.length === 0 ? (
              <p className="form-note">
                No Platform Agent exists yet.{" "}
                <Link to="/admin/platform-agents">Create one</Link> before
                assigning a default.
              </p>
            ) : null}
            {agents.length > 0 && selectableAgents === 0 ? (
              <p className="form-note">
                No Platform Agent is active.{" "}
                <Link to="/admin/platform-agents">Activate one</Link> to make it
                assignable.
              </p>
            ) : null}
          </section>

          <section
            className="admin-user-group admin-user-quotas"
            aria-labelledby={quotaHeadingId}
          >
            <h3 className="admin-user-group__label" id={quotaHeadingId}>
              Quotas
            </h3>
            <div className="admin-quota-fields">
              {quotaFields.map(({ key, label }) => (
                <Field label={label} key={key}>
                  <Input
                    aria-label={`${label} for ${user.email}`}
                    type="number"
                    min={0}
                    max={Number.MAX_SAFE_INTEGER}
                    step={1}
                    value={quota[key]}
                    onChange={(event) =>
                      setQuota((current) => ({
                        ...current,
                        [key]: event.target.value,
                      }))
                    }
                    disabled={controlsDisabled}
                  />
                </Field>
              ))}
            </div>
            <Button
              size="compact"
              variant="secondary"
              className="admin-save-quotas"
              aria-label={`Save quotas for ${user.email}`}
              onClick={() => void saveQuota()}
              loading={pending === "quota"}
              disabled={controlsDisabled || quotaValue === null}
            >
              <span className="admin-loading-icon-slot" aria-hidden="true">
                {pending === "quota" ? <Spinner size={14} /> : null}
              </span>
              Save quotas
            </Button>
          </section>
        </>
      ) : null}

      <Dialog
        open={resetOpen}
        title="Reset password"
        eyebrow="User account"
        onClose={closeResetDialog}
        closeLabel="Close password reset dialog"
        closeDisabled={resetPending}
        initialFocusRef={resetPasswordRef}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={closeResetDialog}
              disabled={resetPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              form={`admin-user-password-form-${user.id}`}
              loading={resetPending}
              disabled={
                resetDraft.password.length < PASSWORD_MIN_LENGTH ||
                resetDraft.password !== resetDraft.confirmPassword
              }
            >
              <span className="admin-loading-icon-slot" aria-hidden="true">
                {resetPending ? <Spinner size={15} /> : null}
              </span>
              Reset password
            </Button>
          </>
        }
      >
        <p className="admin-dialog-copy">
          Set a new password for <strong>{user.email}</strong>. Existing
          sessions for this account are signed out.
        </p>
        <form
          id={`admin-user-password-form-${user.id}`}
          className="admin-agent-editor-form"
          onSubmit={submitReset}
        >
          <Field
            label="New password"
            hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
            error={passwordRequirementError(resetDraft.password)}
          >
            <PasswordInput
              ref={resetPasswordRef}
              autoComplete="new-password"
              value={resetDraft.password}
              minLength={PASSWORD_MIN_LENGTH}
              maxLength={200}
              required
              disabled={resetPending}
              onChange={(event) =>
                setResetDraft((current) => ({
                  ...current,
                  password: event.target.value,
                }))
              }
            />
          </Field>
          <Field
            label="Confirm password"
            error={passwordMatchError(
              resetDraft.confirmPassword,
              resetDraft.password,
            )}
          >
            <PasswordInput
              autoComplete="new-password"
              value={resetDraft.confirmPassword}
              minLength={PASSWORD_MIN_LENGTH}
              maxLength={200}
              required
              disabled={resetPending}
              onChange={(event) =>
                setResetDraft((current) => ({
                  ...current,
                  confirmPassword: event.target.value,
                }))
              }
            />
          </Field>
        </form>
        {resetFeedback ? (
          <Alert className="admin-dialog-feedback" tone="danger">
            {resetFeedback}
          </Alert>
        ) : null}
      </Dialog>
    </section>
  );
}

export function AdminWorkspace({
  onSignedOut,
  onAuthRequired,
}: AdminWorkspaceProps) {
  const [data, setData] = useState<AdminData | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setLoadError(false);
    Promise.all([
      apiClient.listAdminPlatformAgents(),
      apiClient.listAdminUsers(),
      apiClient.getCapabilities(),
    ])
      .then(([agents, users, capabilities]) => {
        if (active)
          setData({
            agents: agents.agents,
            users: users.users,
            models: capabilities.personalAgentModels,
          });
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
  }, [onAuthRequired, reloadKey]);

  async function signOut() {
    try {
      await apiClient.logout();
    } finally {
      onSignedOut();
    }
  }

  if (loadError) {
    return (
      <main className="centered-page">
        <EmptyState
          title="Administration unavailable"
          description="Administrator data could not be loaded."
          action={
            <Button
              variant="secondary"
              onClick={() => setReloadKey((key) => key + 1)}
            >
              Retry
            </Button>
          }
        />
      </main>
    );
  }

  if (!data) {
    return (
      <main className="centered-page" aria-busy="true">
        <Spinner label="Loading administration" />
        <p>Loading administration…</p>
      </main>
    );
  }

  return (
    <AppShell
      brand="Administration"
      navigationLabel="Administration"
      navigation={[
        {
          to: "/admin/platform-agents",
          label: "Platform Agents",
          icon: Bot,
        },
        { to: "/admin/users", label: "Users", icon: Users },
      ]}
      openNavigationLabel="Open administration navigation"
      closeNavigationLabel="Close administration navigation"
      backdropLabel="Close administration navigation"
      onSignOut={() => void signOut()}
    >
      <Routes>
        <Route
          path="/admin/platform-agents"
          element={
            <AdminPlatformAgentsPage
              agents={data.agents}
              models={data.models}
              onAgentsChanged={(agents) =>
                setData((current) =>
                  current ? { ...current, agents } : current,
                )
              }
              onAuthRequired={onAuthRequired}
            />
          }
        />
        <Route
          path="/admin/users"
          element={
            <AdminUsersPage
              agents={data.agents}
              users={data.users}
              onUsersChanged={(users) =>
                setData((current) =>
                  current ? { ...current, users } : current,
                )
              }
              onUserChanged={(user) =>
                setData((current) =>
                  current
                    ? {
                        ...current,
                        users: current.users.map((candidate) =>
                          candidate.id === user.id ? user : candidate,
                        ),
                      }
                    : current,
                )
              }
              onAuthRequired={onAuthRequired}
            />
          }
        />
        <Route
          path="*"
          element={<Navigate to="/admin/platform-agents" replace />}
        />
      </Routes>
    </AppShell>
  );
}

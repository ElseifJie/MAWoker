import { Pencil, Plus, Power, Trash2 } from "lucide-react";
import { type SyntheticEvent, useRef, useState } from "react";
import { ApiClientError, apiClient, type AdminPlatformAgent } from "../api.js";
import {
  Alert,
  Badge,
  Button,
  DataTable,
  Dialog,
  Field,
  Input,
  PageHeader,
  Select,
  Spinner,
  Textarea,
  type BadgeTone,
} from "../ui/index.js";

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

export function AdminPlatformAgentsPage({
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
      error instanceof ApiClientError &&
      error.code === "ARK_INVALID_RESPONSE"
    ) {
      setFeedback(
        "Ark rejected this Agent and it is marked as failed in the list. Verify the model configuration, then delete and recreate it.",
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

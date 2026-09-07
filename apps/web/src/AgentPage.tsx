import { Pencil, Plus, Trash2 } from "lucide-react";
import { type ReactNode, type SyntheticEvent, useRef, useState } from "react";
import {
  ApiClientError,
  apiClient,
  type AgentDetail,
  type AgentList,
  type AgentSummary,
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
  SectionHeader,
  Select,
  Spinner,
  Textarea,
} from "./ui/index.js";

interface AgentPageProps {
  agents: AgentList;
  models: string[];
  onAgentsChanged: (agents: AgentSummary[]) => void;
  onAuthRequired: () => void;
}

interface AgentFormValue {
  name: string;
  description: string;
  modelId: string;
  systemPrompt: string;
}

type EditorState =
  | { mode: "create"; value: AgentFormValue }
  | { mode: "edit"; agent: AgentDetail; value: AgentFormValue };

const emptyForm = (modelId: string): AgentFormValue => ({
  name: "",
  description: "",
  modelId,
  systemPrompt: "",
});

function errorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.code === "ARK_CONFLICT") {
      return "This Agent changed elsewhere. Close and reopen the editor, then try again.";
    }
    if (error.code === "QUOTA_EXCEEDED") {
      return "Your personal Agent limit has been reached.";
    }
    if (error.retryable) {
      return "The Agent service is temporarily unavailable. Try again.";
    }
  }
  return "The Agent could not be saved. Check the fields and try again.";
}

function AgentRecord({
  actions,
  agent,
}: {
  actions?: ReactNode;
  agent: AgentSummary;
}) {
  const personal = agent.kind === "personal";

  return (
    <li className="agent-record">
      <div className="agent-record__content">
        <div className="agent-record__heading">
          <h3>{agent.name}</h3>
          <Badge tone={personal ? "warning" : "neutral"}>
            {personal ? "Personal" : "Platform"}
          </Badge>
        </div>
        <p className="agent-record__description">
          {agent.description || "No description"}
        </p>
        <div className="agent-record__metadata">
          <span>{agent.modelId}</span>
          <span>Version {agent.version}</span>
        </div>
      </div>
      {actions ? <div className="agent-record__actions">{actions}</div> : null}
    </li>
  );
}

export function AgentPage({
  agents,
  models,
  onAgentsChanged,
  onAuthRequired,
}: AgentPageProps) {
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [loadingAgentId, setLoadingAgentId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AgentSummary | null>(null);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const pageHeadingRef = useRef<HTMLHeadingElement>(null);
  const editorInitialFocusRef = useRef<HTMLInputElement>(null);
  const platformAgents = agents.agents.filter(
    (agent) => agent.kind === "platform",
  );
  const personalAgents = agents.agents.filter(
    (agent) => agent.kind === "personal",
  );

  function closeEditor() {
    setEditor(null);
    setFeedback(null);
  }

  function replaceAgent(agent: AgentSummary) {
    onAgentsChanged(
      agents.agents.some((item) => item.id === agent.id)
        ? agents.agents.map((item) => (item.id === agent.id ? agent : item))
        : [...agents.agents, agent],
    );
  }

  async function openEditor(agent: AgentSummary) {
    setFeedback(null);
    setLoadingAgentId(agent.id);
    try {
      const detail = await apiClient.getAgent(agent.id);
      setEditor({
        mode: "edit",
        agent: detail,
        value: {
          name: detail.name,
          description: detail.description,
          modelId: detail.modelId,
          systemPrompt: detail.systemPrompt ?? "",
        },
      });
    } catch (error) {
      if (error instanceof ApiClientError && error.isAuthRequired) {
        onAuthRequired();
      } else {
        setFeedback("The Agent details could not be loaded. Try again.");
      }
    } finally {
      setLoadingAgentId(null);
    }
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
          ? await apiClient.createAgent(editor.value)
          : await apiClient.updateAgent(editor.agent.id, {
              ...editor.value,
              arkVersion: editor.agent.version,
            });
      replaceAgent(saved);
      setEditor(null);
    } catch (error) {
      if (error instanceof ApiClientError && error.isAuthRequired) {
        onAuthRequired();
      } else {
        setFeedback(errorMessage(error));
      }
    } finally {
      setPending(false);
    }
  }

  async function deleteAgent() {
    if (!deleteTarget || pending) return;
    setPending(true);
    setFeedback(null);
    try {
      await apiClient.deleteAgent(deleteTarget.id);
      onAgentsChanged(
        agents.agents.filter((agent) => agent.id !== deleteTarget.id),
      );
      setDeleteTarget(null);
    } catch (error) {
      if (error instanceof ApiClientError && error.isAuthRequired) {
        onAuthRequired();
      } else {
        setFeedback(
          error instanceof ApiClientError && error.retryable
            ? "Deletion is being reconciled. Try again later."
            : "The Agent could not be deleted.",
        );
        setDeleteTarget(null);
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="page">
      <PageHeader
        eyebrow="Workspace"
        title="Agents"
        description="Use assigned Agents or shape a personal Agent for focused work."
        headingRef={pageHeadingRef}
        actions={
          <Button
            onClick={() => {
              setFeedback(null);
              setEditor({ mode: "create", value: emptyForm(models[0] ?? "") });
            }}
            disabled={models.length === 0}
          >
            <Plus size={16} aria-hidden="true" />
            New personal Agent
          </Button>
        }
      />

      {feedback && !editor ? (
        <Alert className="agent-feedback" tone="danger">
          {feedback}
        </Alert>
      ) : null}

      <section className="agent-section" aria-label="Platform provided">
        <SectionHeader
          title="Platform provided"
          description="Assigned by your administrator and available read-only."
          actions={<Badge>{platformAgents.length}</Badge>}
        />
        {platformAgents.length === 0 ? (
          <EmptyState title="No platform Agent is assigned." />
        ) : (
          <ul className="agent-records" aria-label="Platform Agents">
            {platformAgents.map((agent) => (
              <AgentRecord agent={agent} key={agent.id} />
            ))}
          </ul>
        )}
      </section>

      <section className="agent-section" aria-label="My Agents">
        <SectionHeader
          title="My Agents"
          description="Private configurations that only you can manage."
          actions={<Badge>{personalAgents.length}</Badge>}
        />
        {personalAgents.length === 0 ? (
          <EmptyState title="You have not created a personal Agent." />
        ) : (
          <ul className="agent-records" aria-label="Personal Agents">
            {personalAgents.map((agent) => (
              <AgentRecord
                agent={agent}
                key={agent.id}
                actions={
                  <>
                    <Button
                      size="compact"
                      variant="secondary"
                      aria-label={`Edit ${agent.name}`}
                      loading={loadingAgentId === agent.id}
                      onClick={() => void openEditor(agent)}
                    >
                      {loadingAgentId === agent.id ? (
                        <Spinner size={14} aria-hidden="true" />
                      ) : (
                        <Pencil size={14} aria-hidden="true" />
                      )}
                      Edit
                    </Button>
                    <Button
                      size="compact"
                      variant="text"
                      className="agent-record__delete"
                      aria-label={`Delete ${agent.name}`}
                      onClick={() => setDeleteTarget(agent)}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                      Delete
                    </Button>
                  </>
                }
              />
            ))}
          </ul>
        )}
      </section>

      <Dialog
        open={editor !== null}
        title={editor?.mode === "create" ? "Create Agent" : "Edit Agent"}
        eyebrow="Personal Agent"
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
                form="agent-editor-form"
                loading={pending}
                disabled={
                  editor.value.name.trim().length === 0 ||
                  editor.value.modelId.length === 0
                }
              >
                {pending ? <Spinner size={15} aria-hidden="true" /> : null}
                {editor.mode === "create" ? "Create Agent" : "Save changes"}
              </Button>
            </>
          ) : null
        }
      >
        {editor ? (
          <>
            <form
              id="agent-editor-form"
              className="agent-editor-form"
              onSubmit={saveAgent}
            >
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
              <Field label="Model">
                <Select
                  value={editor.value.modelId}
                  required
                  onChange={(event) =>
                    setEditor({
                      ...editor,
                      value: { ...editor.value, modelId: event.target.value },
                    })
                  }
                >
                  {models.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="System Prompt">
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
            </form>
            {feedback ? (
              <Alert className="agent-editor-feedback" tone="danger">
                {feedback}
              </Alert>
            ) : null}
          </>
        ) : null}
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        title="Delete personal Agent?"
        onClose={() => setDeleteTarget(null)}
        closeDisabled={pending}
        hideCloseButton
        fallbackFocusRef={pageHeadingRef}
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
                onClick={() => void deleteAgent()}
              >
                Delete Agent
              </Button>
            </>
          ) : null
        }
      >
        {deleteTarget ? (
          <p className="agent-dialog-copy">
            Delete <strong>{deleteTarget.name}</strong>. Existing Sessions keep
            their Agent snapshot.
          </p>
        ) : null}
      </Dialog>
    </div>
  );
}

import { ArrowLeft } from "lucide-react";
import { type SyntheticEvent, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ApiClientError,
  apiClient,
  type AdminPlatformAgent,
} from "../api.js";
import {
  Alert,
  Badge,
  Button,
  Field,
  Input,
  PageHeader,
  Select,
  Spinner,
  Textarea,
} from "../ui/index.js";

const UNCONFIGURABLE_CAPABILITIES = [
  "Custom Tools",
  "Multi Agents",
  "MCPs",
];

interface AdminAgentEditorPageProps {
  models: string[];
  onAuthRequired: () => void;
  onAgentSaved: (agent: AdminPlatformAgent) => void;
}

interface EditorValue {
  name: string;
  description: string;
  modelId: string;
  systemPrompt: string;
}

function editorErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.code === "ARK_CONFLICT") {
      return "This Agent changed elsewhere. Go back and reopen the editor, then try again.";
    }
    if (error.code === "ARK_INVALID_RESPONSE") {
      return "Ark rejected this Agent. Verify the model configuration, then delete and recreate it if the problem persists.";
    }
    if (error.retryable) {
      return "Ark is temporarily unavailable. Try again.";
    }
  }
  return "The Agent could not be saved. Check the fields and try again.";
}

/**
 * The platform Agent editor shares the personal Agent editor's full-page
 * numbered-section layout; only the capability section differs (platform
 * Agents run without Skill bindings).
 */
export function AdminAgentEditorPage({
  models,
  onAuthRequired,
  onAgentSaved,
}: AdminAgentEditorPageProps) {
  const navigate = useNavigate();
  const { agentId } = useParams<{ agentId: string }>();
  const editing = Boolean(agentId);
  const [value, setValue] = useState<EditorValue>({
    name: "",
    description: "",
    modelId: models[0] ?? "",
    systemPrompt: "",
  });
  const [agent, setAgent] = useState<AdminPlatformAgent | null>(null);
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(editing);
  const [loadFailed, setLoadFailed] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const authRef = useRef(onAuthRequired);
  authRef.current = onAuthRequired;

  useEffect(() => {
    if (!agentId) return;
    let active = true;
    apiClient
      .listAdminPlatformAgents()
      .then((result) => {
        if (!active) return;
        const found = result.agents.find((candidate) => candidate.id === agentId);
        if (!found) {
          setLoadFailed(true);
        } else {
          setAgent(found);
          setValue({
            name: found.name,
            description: found.description,
            modelId: found.modelId,
            systemPrompt: found.systemPrompt,
          });
        }
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof ApiClientError && error.isAuthRequired) {
          authRef.current();
        } else {
          setLoadFailed(true);
        }
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [agentId]);

  function goBack() {
    navigate("/admin/platform-agents");
  }

  async function save(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !value.name.trim() || !value.modelId) return;
    setPending(true);
    setFeedback(null);
    try {
      const saved = editing
        ? await apiClient.updateAdminPlatformAgent(agentId!, {
            name: value.name.trim(),
            description: value.description.trim(),
            modelId: value.modelId,
            systemPrompt: value.systemPrompt,
            arkVersion: agent?.arkVersion ?? "1",
          })
        : await apiClient.createAdminPlatformAgent({
            name: value.name.trim(),
            description: value.description.trim(),
            modelId: value.modelId,
            systemPrompt: value.systemPrompt,
          });
      onAgentSaved(saved);
      goBack();
    } catch (error) {
      if (error instanceof ApiClientError && error.isAuthRequired) {
        onAuthRequired();
      } else {
        setFeedback(editorErrorMessage(error));
      }
    } finally {
      setPending(false);
    }
  }

  if (loadFailed) {
    return (
      <div className="page page--wide agent-editor-page">
        <PageHeader title="Agent unavailable" />
        <Alert tone="danger">The Agent could not be loaded.</Alert>
        <Button variant="secondary" onClick={goBack}>
          Back to Agents
        </Button>
      </div>
    );
  }

  const offAllowlistModel =
    value.modelId && !models.includes(value.modelId)
      ? value.modelId
      : undefined;
  const modelOptions = offAllowlistModel
    ? [offAllowlistModel, ...models]
    : models;

  return (
    <div className="page page--wide agent-editor-page">
      <button type="button" className="agent-editor-back" onClick={goBack}>
        <ArrowLeft size={16} aria-hidden="true" />
        Agents
      </button>
      <PageHeader
        title={editing ? "Edit platform Agent" : "New platform Agent"}
        headingRef={headingRef}
        description={
          editing
            ? "Update the shared Agent configuration. User Sessions keep their Agent snapshot."
            : "Create the shared Agent that administrators assign as the workspace default."
        }
        actions={
          <>
            <Button variant="secondary" onClick={goBack} disabled={pending}>
              Cancel
            </Button>
            <Button
              type="submit"
              form="admin-agent-editor-page-form"
              loading={pending}
              disabled={loading || !value.name.trim() || !value.modelId}
            >
              {editing ? "Save changes" : "Create Agent"}
            </Button>
          </>
        }
      />

      {loading ? (
        <div className="skills-loading" aria-busy="true">
          <Spinner label="Loading Agent" />
        </div>
      ) : (
        <form
          id="admin-agent-editor-page-form"
          className="agent-editor-form"
          onSubmit={save}
        >
          <section
            className="agent-form-section"
            aria-labelledby="admin-agent-section-basic"
          >
            <header className="agent-form-section__header">
              <span className="agent-form-section__index">01</span>
              <div>
                <h3 id="admin-agent-section-basic">Basic information</h3>
                <p>How this Agent is identified in the workspace picker.</p>
              </div>
            </header>
            <div className="agent-form-section__body">
              <Field label="Name" hint="Required.">
                <Input
                  value={value.name}
                  maxLength={80}
                  required
                  onChange={(event) =>
                    setValue({ ...value, name: event.target.value })
                  }
                />
              </Field>
              <Field
                label="Description"
                hint="Describe the Agent's use case and scope."
              >
                <Textarea
                  value={value.description}
                  maxLength={500}
                  rows={3}
                  onChange={(event) =>
                    setValue({ ...value, description: event.target.value })
                  }
                />
              </Field>
            </div>
          </section>

          <section
            className="agent-form-section"
            aria-labelledby="admin-agent-section-model"
          >
            <header className="agent-form-section__header">
              <span className="agent-form-section__index">02</span>
              <div>
                <h3 id="admin-agent-section-model">Model configuration</h3>
                <p>Only models on the workspace allowlist can be used.</p>
              </div>
            </header>
            <div className="agent-form-section__body">
              <Field label="Model">
                <Select
                  value={value.modelId}
                  required
                  onChange={(event) =>
                    setValue({ ...value, modelId: event.target.value })
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
            aria-labelledby="admin-agent-section-prompt"
          >
            <header className="agent-form-section__header">
              <span className="agent-form-section__index">03</span>
              <div>
                <h3 id="admin-agent-section-prompt">System Prompt</h3>
                <p>Defines the role, boundaries, and reply style.</p>
              </div>
            </header>
            <div className="agent-form-section__body">
              <Field
                label="System"
                hint={`${value.systemPrompt.length}/32000`}
              >
                <Textarea
                  value={value.systemPrompt}
                  maxLength={32_000}
                  rows={8}
                  onChange={(event) =>
                    setValue({ ...value, systemPrompt: event.target.value })
                  }
                />
              </Field>
            </div>
          </section>

          <section
            className="agent-form-section"
            aria-labelledby="admin-agent-section-capabilities"
          >
            <header className="agent-form-section__header">
              <span className="agent-form-section__index">04</span>
              <div>
                <h3 id="admin-agent-section-capabilities">
                  Capability extensions
                </h3>
                <p>
                  Skills are attached by users to their personal Agents;
                  platform Agents run with the platform toolset.
                </p>
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
              <div>
                <dt>Skills</dt>
                <dd>
                  <Badge tone="info">Personal only</Badge>
                  Users attach Skills to their personal Agents.
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

          {feedback ? (
            <Alert tone="danger" className="agent-editor-page-feedback">
              {feedback}
            </Alert>
          ) : null}
        </form>
      )}
    </div>
  );
}

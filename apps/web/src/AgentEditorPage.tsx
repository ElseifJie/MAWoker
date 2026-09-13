import { ArrowLeft, Check, Puzzle, X } from "lucide-react";
import { type SyntheticEvent, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ApiClientError,
  apiClient,
  type AgentDetail,
  type AgentSkillSummary,
  type SkillSummary,
} from "./api.js";
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
} from "./ui/index.js";

interface AgentEditorPageProps {
  models: string[];
  onAuthRequired: () => void;
  onAgentSaved: (agent: AgentDetail) => void;
}

interface EditorValue {
  name: string;
  description: string;
  modelId: string;
  systemPrompt: string;
  skillIds: string[];
}

function editorErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.code === "ARK_CONFLICT") {
      return "This Agent changed elsewhere. Go back and reopen the editor, then try again.";
    }
    if (error.code === "QUOTA_EXCEEDED") {
      return "Your personal Agent limit has been reached.";
    }
    if (error.code === "SKILL_NOT_AVAILABLE") {
      return "One of the selected Skills is no longer available. Review the list and try again.";
    }
    if (error.retryable) {
      return "The Agent service is temporarily unavailable. Try again.";
    }
  }
  return "The Agent could not be saved. Check the fields and try again.";
}

function SkillPickList({
  available,
  selected,
  onToggle,
}: {
  available: SkillSummary[];
  selected: string[];
  onToggle: (skillId: string, add: boolean) => void;
}) {
  return (
    <ul className="skill-pick-list" aria-label="Available skills">
      {available.map((skill) => {
        const picked = selected.includes(skill.id);
        return (
          <li key={skill.id} className={picked ? "is-selected" : undefined}>
            <div className="skill-pick-list__label">
              <Puzzle size={14} aria-hidden="true" />
              <span>{skill.displayTitle || skill.fileName}</span>
              {skill.preset ? <Badge tone="info">Preset</Badge> : null}
            </div>
            <Button
              size="compact"
              variant={picked ? "secondary" : "text"}
              aria-pressed={picked}
              aria-label={
                picked
                  ? `Remove ${skill.displayTitle}`
                  : `Add ${skill.displayTitle}`
              }
              onClick={() => onToggle(skill.id, !picked)}
            >
              {picked ? (
                <X size={14} aria-hidden="true" />
              ) : (
                <Check size={14} aria-hidden="true" />
              )}
              {picked ? "Remove" : "Add"}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

export function AgentEditorPage({
  models,
  onAuthRequired,
  onAgentSaved,
}: AgentEditorPageProps) {
  const navigate = useNavigate();
  const { agentId } = useParams<{ agentId: string }>();
  const editing = Boolean(agentId);
  const [value, setValue] = useState<EditorValue>({
    name: "",
    description: "",
    modelId: models[0] ?? "",
    systemPrompt: "",
    skillIds: [],
  });
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [capabilitiesTab, setCapabilitiesTab] = useState("skills");
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(editing);
  const [loadFailed, setLoadFailed] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const authRef = useRef(onAuthRequired);
  authRef.current = onAuthRequired;

  const offAllowlistModel =
    value.modelId && !models.includes(value.modelId)
      ? value.modelId
      : undefined;
  const modelOptions = offAllowlistModel
    ? [offAllowlistModel, ...models]
    : models;

  useEffect(() => {
    let active = true;
    apiClient
      .listSkills("custom")
      .then((result) => {
        if (active) setSkills(result.skills);
      })
      .catch(() => {
        if (active) setSkills([]);
      });
    if (!agentId) return () => {
      active = false;
    };
    apiClient
      .getAgent(agentId)
      .then((detail) => {
        if (!active) return;
        setAgent(detail);
        setValue({
          name: detail.name,
          description: detail.description,
          modelId: detail.modelId,
          systemPrompt: detail.systemPrompt ?? "",
          skillIds: (detail.skills ?? []).map((skill) => skill.id),
        });
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
    navigate("/agents");
  }

  function toggleSkill(skillId: string, add: boolean) {
    setValue((current) => ({
      ...current,
      skillIds: add
        ? [...current.skillIds, skillId]
        : current.skillIds.filter((id) => id !== skillId),
    }));
  }

  async function save(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !value.name.trim() || !value.modelId) return;
    setPending(true);
    setFeedback(null);
    try {
      const saved = editing
        ? await apiClient.updateAgent(agentId!, {
            name: value.name.trim(),
            description: value.description.trim(),
            modelId: value.modelId,
            systemPrompt: value.systemPrompt,
            skillIds: value.skillIds,
            arkVersion: agent?.version ?? "1",
          })
        : await apiClient.createAgent({
            name: value.name.trim(),
            description: value.description.trim(),
            modelId: value.modelId,
            systemPrompt: value.systemPrompt,
            skillIds: value.skillIds,
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
      <div className="page page--wide">
        <PageHeader title="Agent unavailable" />
        <Alert tone="danger">The Agent could not be loaded.</Alert>
        <Button variant="secondary" onClick={goBack}>
          Back to Agents
        </Button>
      </div>
    );
  }

  const selectedSkills: AgentSkillSummary[] = skills
    ? value.skillIds
        .map((id) => skills.find((skill) => skill.id === id))
        .filter((skill): skill is SkillSummary => Boolean(skill))
        .map((skill) => ({ id: skill.id, displayTitle: skill.displayTitle }))
    : (agent?.skills ?? []);

  return (
    <div className="page page--wide agent-editor-page">
      <button type="button" className="agent-editor-back" onClick={goBack}>
        <ArrowLeft size={16} aria-hidden="true" />
        Agents
      </button>
      <PageHeader
        title={editing ? "Edit Agent" : "New personal Agent"}
        headingRef={headingRef}
        description={
          editing
            ? "Update the configuration. Existing Sessions keep their Agent snapshot."
            : "Create a personal Agent, then extend it with the Skills you have uploaded."
        }
        actions={
          <>
            <Button variant="secondary" onClick={goBack} disabled={pending}>
              Cancel
            </Button>
            <Button
              type="submit"
              form="agent-editor-page-form"
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
          id="agent-editor-page-form"
          className="agent-editor-form"
          onSubmit={save}
        >
          <section
            className="agent-form-section"
            aria-labelledby="agent-section-basic"
          >
            <header className="agent-form-section__header">
              <span className="agent-form-section__index">01</span>
              <div>
                <h3 id="agent-section-basic">Basic information</h3>
                <p>How this Agent is identified across the workspace.</p>
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
            aria-labelledby="agent-section-prompt"
          >
            <header className="agent-form-section__header">
              <span className="agent-form-section__index">03</span>
              <div>
                <h3 id="agent-section-prompt">System Prompt</h3>
                <p>
                  Defines the Agent's role, boundaries, and working style — how
                  it should think, reply, and which rules to follow.
                </p>
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
            aria-labelledby="agent-section-capabilities"
          >
            <header className="agent-form-section__header">
              <span className="agent-form-section__index">04</span>
              <div>
                <h3 id="agent-section-capabilities">
                  Capability extensions
                </h3>
                <p>Attach the capabilities this Agent can use.</p>
              </div>
            </header>
            <div className="agent-capabilities">
              <div
                className="agent-capabilities__tabs"
                role="tablist"
                aria-label="Capability types"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={capabilitiesTab === "skills"}
                  className={capabilitiesTab === "skills" ? "is-active" : undefined}
                  onClick={() => setCapabilitiesTab("skills")}
                >
                  Skills
                  <span className="agent-capabilities__count">
                    {value.skillIds.length}
                  </span>
                </button>
                {["Tools", "Custom tools", "Multi Agents", "MCPs"].map(
                  (capability) => (
                    <button
                      key={capability}
                      type="button"
                      role="tab"
                      aria-selected={false}
                      disabled
                      title={`${capability} are not available in this release.`}
                    >
                      {capability}
                    </button>
                  ),
                )}
              </div>
              <div className="agent-capabilities__pane">
                {agent?.isAutoDefault ? (
                  <Alert tone="info">
                    This is your default Agent. It automatically carries every
                    Skill in your library, so the list is managed for you.
                  </Alert>
                ) : skills === null ? (
                  <div className="skills-loading" aria-busy="true">
                    <Spinner label="Loading skills" />
                  </div>
                ) : skills.length === 0 ? (
                  <p className="agent-capabilities__empty">
                    You have not uploaded any Skills yet. Skills you upload on
                    the Skills page can be attached here.
                  </p>
                ) : capabilitiesTab === "skills" ? (
                  <SkillPickList
                    available={skills}
                    selected={value.skillIds}
                    onToggle={toggleSkill}
                  />
                ) : null}
                {selectedSkills.length > 0 && !agent?.isAutoDefault ? (
                  <p className="agent-capabilities__summary">
                    {selectedSkills.length} Skill
                    {selectedSkills.length === 1 ? "" : "s"} attached.
                  </p>
                ) : null}
              </div>
            </div>
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

import { Lock, Pencil, Plus, Trash2 } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ApiClientError,
  apiClient,
  type AgentList,
  type AgentSummary,
} from "./api.js";
import {
  Alert,
  Badge,
  Button,
  Dialog,
  EmptyState,
  PageHeader,
  SectionHeader,
} from "./ui/index.js";

interface AgentPageProps {
  agents: AgentList;
  models: string[];
  onAgentsChanged: (agents: AgentSummary[]) => void;
  onAuthRequired: () => void;
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
          {agent.isAutoDefault ? (
            <Badge tone="info">
              <Lock size={11} aria-hidden="true" />
              Default for you
            </Badge>
          ) : null}
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
          {personal && (agent.skills ?? []).length > 0 ? (
            <span>
              {(agent.skills ?? []).length} Skill
              {(agent.skills ?? []).length === 1 ? "" : "s"}
            </span>
          ) : null}
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
  const navigate = useNavigate();
  const [deleteTarget, setDeleteTarget] = useState<AgentSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const pageHeadingRef = useRef<HTMLHeadingElement>(null);
  const platformAgents = agents.agents.filter(
    (agent) => agent.kind === "platform",
  );
  const personalAgents = agents.agents.filter(
    (agent) => agent.kind === "personal",
  );

  async function deleteAgent() {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
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
      setDeleting(false);
    }
  }

  return (
    <div className="page page--wide">
      <PageHeader
        title="Agents"
        headingRef={pageHeadingRef}
        description="Your default Agent stays in sync with your Skills automatically. Create additional Agents to give tasks a different model, prompt, or Skill set."
        actions={
          <Button
            onClick={() => navigate("/agents/new")}
            disabled={models.length === 0}
          >
            <Plus size={16} aria-hidden="true" />
            New personal Agent
          </Button>
        }
      />

      {feedback ? (
        <Alert className="agent-feedback" tone="danger">
          {feedback}
        </Alert>
      ) : null}

      <section className="agent-section" aria-label="Platform provided">
        <SectionHeader
          title="Platform provided"
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
          actions={<Badge>{personalAgents.length}</Badge>}
        />
        {personalAgents.length === 0 ? (
          <EmptyState
            title="You have not created a personal Agent."
            description="Upload a Skill and a default personal Agent is created for you automatically."
          />
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
                      onClick={() => navigate(`/agents/${agent.id}/edit`)}
                    >
                      <Pencil size={14} aria-hidden="true" />
                      Edit
                    </Button>
                    <Button
                      size="compact"
                      variant="text"
                      className="agent-record__delete"
                      aria-label={`Delete ${agent.name}`}
                      disabled={agent.isAutoDefault}
                      title={
                        agent.isAutoDefault
                          ? "Your default Agent is managed automatically and cannot be deleted."
                          : undefined
                      }
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
        open={deleteTarget !== null}
        title="Delete personal Agent?"
        onClose={() => setDeleteTarget(null)}
        closeDisabled={deleting}
        hideCloseButton
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
                Cancel
              </Button>
              <Button
                variant="danger"
                loading={deleting}
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

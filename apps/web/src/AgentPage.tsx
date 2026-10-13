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
              默认助手
            </Badge>
          ) : null}
          <Badge tone={personal ? "warning" : "neutral"}>
            {personal ? "个人" : "平台"}
          </Badge>
        </div>
        <p className="agent-record__description">
          {agent.description || "暂无描述"}
        </p>
        <div className="agent-record__metadata">
          <span>{agent.modelId}</span>
          <span>版本 {agent.version}</span>
          {personal && (agent.skills ?? []).length > 0 ? (
            <span>{(agent.skills ?? []).length} 个技能</span>
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
            ? "后台正在核对删除结果，请稍后重试。"
            : "助手无法删除，请重试。",
        );
        setDeleteTarget(null);
      }
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="page page--wide agents-page">
      <PageHeader
        title="助手配置"
        headingRef={pageHeadingRef}
        description="默认助手会同步你的技能。按需创建其他助手，设置不同模型、提示词和技能。"
        actions={
          <Button
            onClick={() => navigate("/settings/agents/new")}
            disabled={models.length === 0}
          >
            <Plus size={16} aria-hidden="true" />
            创建个人助手
          </Button>
        }
      />

      {feedback ? (
        <Alert className="agent-feedback" tone="danger">
          {feedback}
        </Alert>
      ) : null}

      <section className="agent-section" aria-label="平台助手">
        <SectionHeader
          title="平台助手"
          actions={<Badge>{platformAgents.length}</Badge>}
        />
        {platformAgents.length === 0 ? (
          <EmptyState
            title="暂无可用的平台助手"
            description="管理员配置后，你可以在新任务中选择使用。"
          />
        ) : (
          <ul className="agent-records" aria-label="平台助手">
            {platformAgents.map((agent) => (
              <AgentRecord agent={agent} key={agent.id} />
            ))}
          </ul>
        )}
      </section>

      <section className="agent-section" aria-label="我的助手">
        <SectionHeader
          title="我的助手"
          actions={<Badge>{personalAgents.length}</Badge>}
        />
        {personalAgents.length === 0 ? (
          <EmptyState
            title="还没有个人助手"
            description="上传技能可自动准备默认助手，也可以自行创建。"
          />
        ) : (
          <ul className="agent-records" aria-label="个人助手">
            {personalAgents.map((agent) => (
              <AgentRecord
                agent={agent}
                key={agent.id}
                actions={
                  <>
                    <Button
                      size="compact"
                      variant="secondary"
                      aria-label={`编辑 ${agent.name}`}
                      onClick={() =>
                        navigate(`/settings/agents/${agent.id}/edit`)
                      }
                    >
                      <Pencil size={14} aria-hidden="true" />
                      编辑
                    </Button>
                    <Button
                      size="compact"
                      variant="text"
                      className="agent-record__delete"
                      aria-label={`删除 ${agent.name}`}
                      disabled={agent.isAutoDefault}
                      title={
                        agent.isAutoDefault
                          ? "默认助手由系统管理，无法删除。"
                          : undefined
                      }
                      onClick={() => setDeleteTarget(agent)}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                      删除
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
        title="删除个人助手？"
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
                取消
              </Button>
              <Button
                variant="danger"
                loading={deleting}
                onClick={() => void deleteAgent()}
              >
                删除助手
              </Button>
            </>
          ) : null
        }
      >
        {deleteTarget ? (
          <p className="agent-dialog-copy">
            删除 <strong>{deleteTarget.name}</strong>
            。已有任务仍保留原助手配置。
          </p>
        ) : null}
      </Dialog>
    </div>
  );
}

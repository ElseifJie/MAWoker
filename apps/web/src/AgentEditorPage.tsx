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
      return "助手配置已在其他位置变更，请返回并重新打开编辑页。";
    }
    if (error.code === "QUOTA_EXCEEDED") {
      return "个人助手数量已达上限。";
    }
    if (error.code === "SKILL_NOT_AVAILABLE") {
      return "部分已选技能不可用，请重新选择。";
    }
    if (error.retryable) {
      return "助手服务暂不可用，请重试。";
    }
  }
  return "助手无法保存，请检查配置后重试。";
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
    <ul className="skill-pick-list" aria-label="可用技能">
      {available.map((skill) => {
        const picked = selected.includes(skill.id);
        return (
          <li key={skill.id} className={picked ? "is-selected" : undefined}>
            <div className="skill-pick-list__label">
              <Puzzle size={14} aria-hidden="true" />
              <span>{skill.displayTitle || skill.fileName}</span>
              {skill.preset ? <Badge tone="info">预置</Badge> : null}
            </div>
            <Button
              size="compact"
              variant={picked ? "secondary" : "text"}
              aria-pressed={picked}
              aria-label={
                picked
                  ? `移除 ${skill.displayTitle}`
                  : `添加 ${skill.displayTitle}`
              }
              onClick={() => onToggle(skill.id, !picked)}
            >
              {picked ? (
                <X size={14} aria-hidden="true" />
              ) : (
                <Check size={14} aria-hidden="true" />
              )}
              {picked ? "移除" : "添加"}
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
    if (!agentId)
      return () => {
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
    navigate("/settings/agents");
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
        <PageHeader title="助手暂不可用" />
        <Alert tone="danger">无法加载助手，请返回列表后重试。</Alert>
        <Button variant="secondary" onClick={goBack}>
          返回助手列表
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
        返回助手列表
      </button>
      <PageHeader
        title={editing ? "编辑助手" : "创建个人助手"}
        headingRef={headingRef}
        description={
          editing
            ? "调整助手配置。已有任务仍保留原来的配置。"
            : "设置名称、模型与工作方式，再选择助手可使用的技能。"
        }
        actions={
          <>
            <Button variant="secondary" onClick={goBack} disabled={pending}>
              取消
            </Button>
            <Button
              type="submit"
              form="agent-editor-page-form"
              loading={pending}
              disabled={loading || !value.name.trim() || !value.modelId}
            >
              {editing ? "保存修改" : "创建助手"}
            </Button>
          </>
        }
      />

      {loading ? (
        <div className="skills-loading" aria-busy="true">
          <Spinner label="正在加载助手" />
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
                <h3 id="agent-section-basic">基本信息</h3>
                <p>用于在工作区识别与选择助手。</p>
              </div>
            </header>
            <div className="agent-form-section__body">
              <Field label="名称" hint="必填">
                <Input
                  value={value.name}
                  maxLength={80}
                  required
                  onChange={(event) =>
                    setValue({ ...value, name: event.target.value })
                  }
                />
              </Field>
              <Field label="描述" hint="说明助手适合处理的任务和范围。">
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
                <h3 id="agent-section-model">模型配置</h3>
                <p>只能使用工作区允许的模型。</p>
              </div>
            </header>
            <div className="agent-form-section__body">
              <Field label="模型">
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
                      {model === offAllowlistModel ? "（当前不可用）" : ""}
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
                <h3 id="agent-section-prompt">工作指令</h3>
                <p>定义助手的角色、工作方式与边界，以及回答时应遵守的要求。</p>
              </div>
            </header>
            <div className="agent-form-section__body">
              <Field
                label="系统提示词"
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
                <h3 id="agent-section-capabilities">技能配置</h3>
                <p>选择助手执行任务时可用的技能。</p>
              </div>
            </header>
            <div className="agent-capabilities">
              <div
                className="agent-capabilities__tabs"
                role="tablist"
                aria-label="能力类型"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={capabilitiesTab === "skills"}
                  className={
                    capabilitiesTab === "skills" ? "is-active" : undefined
                  }
                  onClick={() => setCapabilitiesTab("skills")}
                >
                  技能
                  <span className="agent-capabilities__count">
                    {value.skillIds.length}
                  </span>
                </button>
              </div>
              <div className="agent-capabilities__pane">
                {agent?.isAutoDefault ? (
                  <Alert tone="info">
                    默认助手会自动同步你的技能库，此处无需手动选择。
                  </Alert>
                ) : skills === null ? (
                  <div className="skills-loading" aria-busy="true">
                    <Spinner label="正在加载技能" />
                  </div>
                ) : skills.length === 0 ? (
                  <p className="agent-capabilities__empty">
                    还没有可用技能。上传到技能库后，可在这里添加。
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
                    已添加 {selectedSkills.length} 个技能。
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

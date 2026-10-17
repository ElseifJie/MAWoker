import { useEffect, useState } from "react";
import {
  ApiClientError,
  apiClient,
  type AdminPlatformAgent,
  type AdminUserAgent,
} from "../api.js";
import {
  Button,
  Badge,
  DataTable,
  EmptyState,
  PageHeader,
  Spinner,
  type BadgeTone,
} from "../ui/index.js";

import { AdminTabs } from "./AdminTabs.js";
import { statusLabel } from "./presentation.js";

function platformAgentStatusTone(
  status: AdminPlatformAgent["status"],
): BadgeTone {
  if (status === "active") return "success";
  if (status === "failed") return "danger";
  if (status === "provisioning" || status === "deleting") return "warning";
  return "neutral";
}

function userAgentStatusTone(status: AdminUserAgent["status"]): BadgeTone {
  if (status === "active") return "success";
  if (status === "failed") return "danger";
  if (status === "provisioning" || status === "deleting") return "warning";
  return "neutral";
}

function UserAgentsPanel({ onAuthRequired }: { onAuthRequired: () => void }) {
  const [agents, setAgents] = useState<AdminUserAgent[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    setFailed(false);
    setAgents(null);
    apiClient
      .listAdminUserAgents()
      .then((result) => {
        if (active) setAgents(result.agents);
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof ApiClientError && error.isAuthRequired) {
          onAuthRequired();
        } else {
          setFailed(true);
        }
      });
    return () => {
      active = false;
    };
  }, [onAuthRequired, revision]);

  if (failed) {
    return (
      <EmptyState
        title="个人助手暂时无法加载"
        description="加载失败，请重试。"
        action={
          <Button
            variant="secondary"
            onClick={() => setRevision((value) => value + 1)}
          >
            重试
          </Button>
        }
      />
    );
  }
  if (agents === null) {
    return (
      <div className="skills-loading" aria-busy="true">
        <Spinner label="正在加载个人助手" />
      </div>
    );
  }
  if (agents.length === 0) {
    return <EmptyState title="还没有个人助手" />;
  }
  return (
    <DataTable caption="个人助手" className="admin-agent-table" minWidth="wide">
      <thead>
        <tr>
          <th scope="col">助手</th>
          <th scope="col">所属账号</th>
          <th scope="col">类型</th>
          <th scope="col">技能</th>
          <th scope="col">状态</th>
        </tr>
      </thead>
      <tbody>
        {agents.map((agent) => (
          <tr key={agent.id}>
            <th scope="row" data-label="助手">
              <div className="admin-agent-summary">
                <strong>{agent.name}</strong>
                <span>{agent.description || "暂无说明"}</span>
                <span>{agent.modelId}</span>
              </div>
            </th>
            <td data-label="所属账号">{agent.ownerEmail}</td>
            <td data-label="类型">
              {agent.isAutoDefault ? (
                <Badge tone="info">账号默认助手</Badge>
              ) : (
                <Badge tone="neutral">个人助手</Badge>
              )}
            </td>
            <td data-label="技能">
              {agent.skills.length === 0 ? (
                <span className="admin-agent-model">—</span>
              ) : (
                <div className="admin-status-stack">
                  {agent.skills.map((skill) => (
                    <Badge key={skill.id} tone="neutral">
                      {skill.displayTitle}
                    </Badge>
                  ))}
                </div>
              )}
            </td>
            <td data-label="状态">
              <Badge tone={userAgentStatusTone(agent.status)}>
                {statusLabel(agent.status)}
              </Badge>
            </td>
          </tr>
        ))}
      </tbody>
    </DataTable>
  );
}

export function AdminPlatformAgentsPage({
  agents,
  onAuthRequired,
  loading,
  loadError,
  onRetry,
}: {
  loading: boolean;
  loadError: boolean;
  onRetry: () => void;
  agents: AdminPlatformAgent[];
  onAuthRequired: () => void;
}) {
  const [tab, setTab] = useState<"system" | "user">("system");

  return (
    <div className="page admin-page">
      <PageHeader
        title="助手管理"
        description={
          tab === "system"
            ? "查看平台助手的模型、版本与可用状态。"
            : "查看个人助手的所属账号、技能和可用状态。"
        }
      />

      <AdminTabs
        label="助手范围"
        tabs={[
          { id: "system", label: "平台助手" },
          { id: "user", label: "个人助手" },
        ]}
        value={tab}
        onChange={setTab}
      >
        {tab === "user" ? (
          <UserAgentsPanel onAuthRequired={onAuthRequired} />
        ) : loading ? (
          <div className="admin-loading" aria-busy="true">
            <Spinner label="正在加载平台助手" />
            正在加载平台助手…
          </div>
        ) : loadError ? (
          <EmptyState
            title="平台助手暂时无法加载"
            description="请重试，其他管理页面仍可使用。"
            action={
              <Button variant="secondary" onClick={onRetry}>
                重试
              </Button>
            }
          />
        ) : agents.length === 0 ? (
          <EmptyState
            title="还没有配置平台助手"
            description="配置平台助手后，才能为个人账号分配默认助手。"
          />
        ) : (
          <DataTable
            caption="平台助手列表"
            className="admin-agent-table"
            minWidth="wide"
          >
            <thead>
              <tr>
                <th scope="col">助手</th>
                <th scope="col">模型</th>
                <th scope="col">当前版本</th>
                <th scope="col">状态</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((agent) => (
                <tr key={agent.id}>
                  <th scope="row" data-label="助手">
                    <div className="admin-agent-summary">
                      <strong>{agent.name}</strong>
                      <span>{agent.description || "暂无说明"}</span>
                    </div>
                  </th>
                  <td className="admin-agent-model" data-label="模型">
                    <span>{agent.modelId}</span>
                  </td>
                  <td data-label="当前版本">
                    <span>{agent.arkVersion}</span>
                  </td>
                  <td data-label="状态">
                    <div className="admin-status-stack">
                      <Badge tone={platformAgentStatusTone(agent.status)}>
                        {statusLabel(agent.status)}
                      </Badge>
                      {agent.lastErrorCode ? (
                        <Badge tone="danger">同步异常</Badge>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
        {tab === "system" ? (
          <details className="admin-configuration-note">
            <summary>如何配置平台助手</summary>
            <p>
              平台助手通过 .env 中的 SYSTEM_AGENT_IDS 配置。修改后需重启 API
              服务。
            </p>
          </details>
        ) : null}
      </AdminTabs>
    </div>
  );
}

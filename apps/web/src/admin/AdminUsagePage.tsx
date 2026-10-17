import { Download } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  ApiClientError,
  apiClient,
  type AdminDimensionStatus,
  type AdminUsageByAgents,
} from "../api.js";
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  PageHeader,
  Spinner,
  type BadgeTone,
} from "../ui/index.js";
import { AdminPagination } from "./AdminPagination.js";
import { useAdminCollection } from "./useAdminCollection.js";
import { statusLabel } from "./presentation.js";
import { formatCount, formatUsagePeriod } from "./format.js";

const PAGE_SIZE = 50;

function dimensionTone(status: AdminDimensionStatus): BadgeTone {
  if (status === "exhausted") return "danger";
  if (status === "near") return "warning";
  return "neutral";
}

export function AdminUsagePage({
  onAuthRequired,
}: {
  onAuthRequired: () => void;
}) {
  const [agents, setAgents] = useState<AdminUsageByAgents | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(false);
    Promise.all([apiClient.getAdminUsageByAgents()])
      .then(([agentsResult]) => {
        if (!active) return;
        setAgents(agentsResult);
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof ApiClientError && error.isAuthRequired) {
          onAuthRequired();
          return;
        }
        setLoadError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [onAuthRequired, reloadKey]);

  const fetchUsage = useCallback(async (cursor?: string) => {
    const page = await apiClient.getAdminUsageOverview({
      limit: PAGE_SIZE,
      cursor,
    });
    return { items: page.users, nextCursor: page.nextCursor, context: page };
  }, []);
  const collection = useAdminCollection(fetchUsage, onAuthRequired);
  const overview = collection.context;

  function exportCsv() {
    if (!overview) return;
    const header = [
      "email",
      "role",
      "status",
      "personal_agents",
      "personal_agent_limit",
      "concurrent_sessions",
      "concurrent_session_limit",
      "daily_sessions",
      "daily_session_limit",
      "input_tokens",
      "output_tokens",
      "tokens",
      "monthly_token_limit",
      "tool_calls",
      "token_dimension_status",
    ];
    const lines = collection.items.map((row) =>
      [
        row.email,
        row.role,
        row.status,
        row.usage.personalAgents,
        row.quota.personalAgentLimit,
        row.usage.concurrentSessions,
        row.quota.concurrentSessionLimit,
        row.usage.dailySessions,
        row.quota.dailySessionLimit,
        row.usage.inputTokens,
        row.usage.outputTokens,
        row.usage.tokens,
        row.quota.monthlyTokenLimit,
        row.usage.toolCalls,
        row.dimensionStatus.monthlyTokens,
      ]
        .map((cell) => escapeCsvCell(String(cell)))
        .join(","),
    );
    const blob = new Blob([[header.join(","), ...lines].join("\n")], {
      type: "text/csv",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `mawork-usage-${overview.period.startsAt.slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  if (loading || collection.loading) {
    return (
      <div className="page admin-page" aria-busy="true">
        <Spinner label="正在加载用量" />
        <p className="admin-dimmed">正在加载用量…</p>
      </div>
    );
  }

  if (loadError || collection.loadError || !overview || !agents) {
    return (
      <div className="page admin-page">
        <EmptyState
          title="用量暂时无法加载"
          description="用量数据加载失败，请重试。"
          action={
            <Button
              variant="secondary"
              onClick={() => {
                setReloadKey((key) => key + 1);
                collection.reload();
              }}
            >
              重试
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="page admin-page">
      <PageHeader
        title="用量"
        description={`${formatUsagePeriod(overview.period.startsAt)} 平台用量概览。`}
        actions={
          <Button
            variant="secondary"
            onClick={exportCsv}
            disabled={collection.items.length === 0}
          >
            <Download size={16} aria-hidden="true" />
            导出已加载数据
          </Button>
        }
      />

      <div className="admin-stat-grid">
        <StatCard
          label="本月 Token"
          value={formatCount(overview.totals.tokens)}
          hint={`输入 ${formatCount(overview.totals.inputTokens)} · 输出 ${formatCount(overview.totals.outputTokens)}`}
        />
        <StatCard
          label="活跃用户"
          value={formatCount(overview.totals.activeUsers)}
          hint="本月产生 Token 用量的用户"
        />
        <StatCard
          label="新增任务"
          value={formatCount(overview.totals.sessions)}
          hint="本月创建的任务"
        />
        <StatCard
          label="达到配额上限"
          value={formatCount(overview.totals.exhaustedUsers)}
          hint="至少一项配额已用尽"
          tone={overview.totals.exhaustedUsers > 0 ? "danger" : undefined}
        />
      </div>

      <section className="admin-section" aria-label="用户用量明细">
        <h2 className="admin-section__title">用户用量明细</h2>
        <p className="admin-dimmed admin-section__hint">
          每项展示已用量与上限；点击邮箱进入账号详情。导出包含当前已加载的账号。
        </p>
        {collection.items.length === 0 ? (
          <EmptyState
            title="暂无用户用量"
            description="账号产生用量后将在这里显示。"
            action={
              <Link
                className="ui-button ui-button--secondary"
                to="/admin/users"
              >
                管理用户
              </Link>
            }
          />
        ) : (
          <DataTable caption="用户用量明细" minWidth="wide">
            <thead>
              <tr>
                <th scope="col">个人用户</th>
                <th scope="col">状态</th>
                <th scope="col">个人助手</th>
                <th scope="col">同时运行</th>
                <th scope="col">今日任务</th>
                <th scope="col">Token 用量</th>
                <th scope="col">工具调用</th>
              </tr>
            </thead>
            <tbody>
              {collection.items.map((row) => (
                <tr key={row.userId}>
                  <th scope="row" data-label="个人用户">
                    <div className="admin-user-cell">
                      <Link
                        className="admin-user-cell__link"
                        to={`/admin/users/${row.userId}`}
                      >
                        {row.email}
                      </Link>
                      <Badge
                        tone={dimensionTone(row.dimensionStatus.monthlyTokens)}
                      >
                        {statusLabel(row.dimensionStatus.monthlyTokens)}
                      </Badge>
                    </div>
                  </th>
                  <td data-label="状态">
                    <Badge
                      tone={row.status === "active" ? "success" : "neutral"}
                    >
                      {statusLabel(row.status)}
                    </Badge>
                  </td>
                  <td data-label="个人助手">
                    <DimensionValue
                      label="助手管理"
                      consumed={row.usage.personalAgents}
                      limit={row.quota.personalAgentLimit}
                      status={row.dimensionStatus.personalAgents}
                    />
                  </td>
                  <td data-label="同时运行">
                    <DimensionValue
                      label="同时运行"
                      consumed={row.usage.concurrentSessions}
                      limit={row.quota.concurrentSessionLimit}
                      status={row.dimensionStatus.concurrentSessions}
                    />
                  </td>
                  <td data-label="今日任务">
                    <DimensionValue
                      label="每日任务"
                      consumed={row.usage.dailySessions}
                      limit={row.quota.dailySessionLimit}
                      status={row.dimensionStatus.dailySessions}
                    />
                  </td>
                  <td data-label="Token 用量">
                    <span className="admin-mono">
                      {formatCount(row.usage.tokens)}
                    </span>
                    <span className="admin-dimmed admin-quota-of">
                      {" "}
                      / {formatCount(row.quota.monthlyTokenLimit)}
                    </span>
                  </td>
                  <td data-label="工具调用">
                    <span className="admin-mono">
                      {formatCount(row.usage.toolCalls)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
        <AdminPagination {...collection} count={collection.items.length} />
      </section>

      <section className="admin-section" aria-label="助手用量">
        <h2 className="admin-section__title">按助手汇总</h2>
        <DataTable caption="平台助手用量" minWidth="wide">
          <thead>
            <tr>
              <th scope="col">平台助手</th>
              <th scope="col">默认分配</th>
              <th scope="col">Token 用量</th>
            </tr>
          </thead>
          <tbody>
            {agents.platform.map((agent) => (
              <tr key={agent.platformAgentId}>
                <th scope="row" data-label="平台助手">
                  <div className="admin-user-cell">
                    <span>{agent.name}</span>
                    <Badge
                      tone={agent.status === "active" ? "success" : "neutral"}
                    >
                      {statusLabel(agent.status)}
                    </Badge>
                  </div>
                </th>
                <td data-label="默认分配">
                  <span className="admin-mono">
                    {agent.defaultAssignments} 个账号
                  </span>
                </td>
                <td data-label="Token 用量">
                  <span className="admin-mono">
                    {formatCount(agent.tokens)}
                  </span>
                  <span className="admin-dimmed admin-quota-of">
                    {" "}
                    输入 {formatCount(agent.inputTokens)} · 输出{" "}
                    {formatCount(agent.outputTokens)}
                  </span>
                </td>
              </tr>
            ))}
            {agents.platform.length === 0 ? (
              <tr>
                <td colSpan={3}>
                  <span className="admin-dimmed">暂无平台助手。</span>
                </td>
              </tr>
            ) : null}
          </tbody>
        </DataTable>
        <p className="admin-dimmed admin-personal-summary">
          使用中的个人助手：{" "}
          <span className="admin-mono">{agents.personal.personalAgents}</span> ·
          本月 Token：{" "}
          <span className="admin-mono">
            {formatCount(agents.personal.tokens)}
          </span>
        </p>
      </section>
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone?: BadgeTone | undefined;
}) {
  return (
    <div className="admin-stat-card">
      <span className="admin-stat-card__label">{label}</span>
      <span
        className={`admin-stat-card__value${tone === "danger" ? " admin-stat-card__value--danger" : ""}`}
      >
        {value}
      </span>
      <span className="admin-stat-card__hint">{hint}</span>
    </div>
  );
}

function DimensionValue({
  label,
  consumed,
  limit,
  status,
}: {
  label: string;
  consumed: number;
  limit: number;
  status: AdminDimensionStatus;
}) {
  return (
    <span className="admin-dimension">
      <span className="admin-mono">
        {formatCount(consumed)}
        <span className="admin-dimmed admin-quota-of">
          {" "}
          / {formatCount(limit)}
        </span>
      </span>
      {status !== "ok" ? (
        <Badge tone={dimensionTone(status)}>
          <span className="sr-only">{label}: </span>
          {statusLabel(status)}
        </Badge>
      ) : null}
    </span>
  );
}

function escapeCsvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

import { Download } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ApiClientError,
  apiClient,
  type AdminDimensionStatus,
  type AdminUsageByAgents,
  type AdminUsageOverview,
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
  const navigate = useNavigate();
  const [overview, setOverview] = useState<AdminUsageOverview | null>(null);
  const [agents, setAgents] = useState<AdminUsageByAgents | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(false);
    Promise.all([
      apiClient.getAdminUsageOverview({ limit: PAGE_SIZE }),
      apiClient.getAdminUsageByAgents(),
    ])
      .then(([overviewResult, agentsResult]) => {
        if (!active) return;
        setOverview(overviewResult);
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

  function loadMore() {
    if (!overview?.nextCursor) return;
    apiClient
      .getAdminUsageOverview({
        limit: PAGE_SIZE,
        cursor: overview.nextCursor,
      })
      .then((page) => {
        setOverview((current) =>
          current
            ? {
                ...current,
                users: [...current.users, ...page.users],
                nextCursor: page.nextCursor,
              }
            : page,
        );
      })
      .catch((error: unknown) => {
        if (error instanceof ApiClientError && error.isAuthRequired) {
          onAuthRequired();
        }
      });
  }

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
    const lines = overview.users.map((row) =>
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

  if (loading) {
    return (
      <div className="page admin-page" aria-busy="true">
        <Spinner label="Loading usage" />
        <p className="admin-dimmed">Loading usage…</p>
      </div>
    );
  }

  if (loadError || !overview || !agents) {
    return (
      <div className="page admin-page">
        <EmptyState
          title="Usage unavailable"
          description="Usage data could not be loaded."
          action={
            <Button
              variant="secondary"
              onClick={() => setReloadKey((key) => key + 1)}
            >
              Retry
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="page admin-page">
      <PageHeader
        eyebrow="Administration"
        title="Usage"
        description={`Platform consumption for ${formatUsagePeriod(overview.period.startsAt)}, matching the quota enforcement window.`}
        actions={
          <Button variant="secondary" onClick={exportCsv}>
            <Download size={16} aria-hidden="true" />
            Export CSV
          </Button>
        }
      />

      <div className="admin-stat-grid">
        <StatCard
          label="Monthly tokens"
          value={formatCount(overview.totals.tokens)}
          hint={`${formatCount(overview.totals.inputTokens)} in · ${formatCount(overview.totals.outputTokens)} out`}
        />
        <StatCard
          label="Active users"
          value={formatCount(overview.totals.activeUsers)}
          hint="consumed tokens this month"
        />
        <StatCard
          label="New sessions"
          value={formatCount(overview.totals.sessions)}
          hint="created this month"
        />
        <StatCard
          label="Users at limit"
          value={formatCount(overview.totals.exhaustedUsers)}
          hint="any quota dimension exhausted"
          tone={overview.totals.exhaustedUsers > 0 ? "danger" : undefined}
        />
      </div>

      <DataTable caption="Per-user monthly usage" minWidth="wide">
        <thead>
          <tr>
            <th scope="col">User</th>
            <th scope="col">Status</th>
            <th scope="col">Personal Agents</th>
            <th scope="col">Concurrent</th>
            <th scope="col">Sessions today</th>
            <th scope="col">Tokens</th>
            <th scope="col">Tool calls</th>
          </tr>
        </thead>
        <tbody>
          {overview.users.map((row) => (
            <tr
              key={row.userId}
              onClick={() => navigate(`/admin/users/${row.userId}`)}
              className="admin-clickable-row"
            >
              <th scope="row" data-label="User">
                <div className="admin-user-cell">
                  <span className="admin-user-cell__link">{row.email}</span>
                  <Badge
                    tone={dimensionTone(row.dimensionStatus.monthlyTokens)}
                  >
                    {row.dimensionStatus.monthlyTokens}
                  </Badge>
                </div>
              </th>
              <td data-label="Status">
                <Badge tone={row.status === "active" ? "success" : "neutral"}>
                  {row.status}
                </Badge>
              </td>
              <td data-label="Personal Agents">
                <DimensionValue
                  label="Agents"
                  consumed={row.usage.personalAgents}
                  limit={row.quota.personalAgentLimit}
                  status={row.dimensionStatus.personalAgents}
                />
              </td>
              <td data-label="Concurrent">
                <DimensionValue
                  label="Concurrent"
                  consumed={row.usage.concurrentSessions}
                  limit={row.quota.concurrentSessionLimit}
                  status={row.dimensionStatus.concurrentSessions}
                />
              </td>
              <td data-label="Sessions today">
                <DimensionValue
                  label="Daily sessions"
                  consumed={row.usage.dailySessions}
                  limit={row.quota.dailySessionLimit}
                  status={row.dimensionStatus.dailySessions}
                />
              </td>
              <td data-label="Tokens">
                <span className="admin-mono">
                  {formatCount(row.usage.tokens)}
                </span>
                <span className="admin-dimmed admin-quota-of">
                  {" "}
                  of {formatCount(row.quota.monthlyTokenLimit)}
                </span>
              </td>
              <td data-label="Tool calls">
                <span className="admin-mono">
                  {formatCount(row.usage.toolCalls)}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </DataTable>
      {overview.nextCursor ? (
        <div className="admin-load-more">
          <Button variant="secondary" onClick={loadMore}>
            Load more
          </Button>
        </div>
      ) : (
        <p className="admin-table-end">End of accounts</p>
      )}

      <section className="admin-section" aria-label="Usage by Agent">
        <h2 className="admin-section__title">By Agent</h2>
        <DataTable caption="Platform Agent usage" minWidth="wide">
          <thead>
            <tr>
              <th scope="col">Platform Agent</th>
              <th scope="col">Default for</th>
              <th scope="col">Tokens</th>
            </tr>
          </thead>
          <tbody>
            {agents.platform.map((agent) => (
              <tr key={agent.platformAgentId}>
                <th scope="row" data-label="Platform Agent">
                  <div className="admin-user-cell">
                    <span>{agent.name}</span>
                    <Badge
                      tone={agent.status === "active" ? "success" : "neutral"}
                    >
                      {agent.status}
                    </Badge>
                  </div>
                </th>
                <td data-label="Default for">
                  <span className="admin-mono">
                    {agent.defaultAssignments} user
                    {agent.defaultAssignments === 1 ? "" : "s"}
                  </span>
                </td>
                <td data-label="Tokens">
                  <span className="admin-mono">
                    {formatCount(agent.tokens)}
                  </span>
                  <span className="admin-dimmed admin-quota-of">
                    {" "}
                    {formatCount(agent.inputTokens)} in ·{" "}
                    {formatCount(agent.outputTokens)} out
                  </span>
                </td>
              </tr>
            ))}
            {agents.platform.length === 0 ? (
              <tr>
                <td colSpan={3}>
                  <span className="admin-dimmed">No platform Agents yet.</span>
                </td>
              </tr>
            ) : null}
          </tbody>
        </DataTable>
        <p className="admin-dimmed admin-personal-summary">
          Personal Agents in use:{" "}
          <span className="admin-mono">{agents.personal.personalAgents}</span> ·
          Tokens this month:{" "}
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
          {status}
        </Badge>
      ) : null}
    </span>
  );
}

function escapeCsvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiClientError,
  apiClient,
  type AdminAuditLogQuery,
  type AdminUserSummary,
} from "../api.js";
import {
  Alert,
  Badge,
  Button,
  DataTable,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  Spinner,
} from "../ui/index.js";
import { AdminPagination } from "./AdminPagination.js";
import { useAdminCollection } from "./useAdminCollection.js";
import { actionLabel, resourceLabel, statusLabel } from "./presentation.js";
import { formatDateTime } from "./format.js";

const PAGE_SIZE = 50;
const DEFAULT_WINDOW_DAYS = 7;

const RESOURCE_TYPES = [
  "platform_agent",
  "user",
  "user_password",
  "user_default_agent",
  "user_quota",
  "user_session",
  "authentication",
  "quota_policy",
  "quota_interrupt",
] as const;

const ACTIONS = [
  "auth.login",
  "platform_agent.create",
  "platform_agent.update",
  "platform_agent.enable",
  "platform_agent.disable",
  "platform_agent.delete",
  "user.create",
  "user.view",
  "user.status.update",
  "user.role.update",
  "user_password.reset",
  "user_sessions.revoke",
  "user_default_agent.assign",
  "user_quota.update",
  "quota_policy.update",
  "quota_interrupt.enqueue",
  "session.create",
  "session.message",
  "session.interrupt",
] as const;

function isoDaysAgo(days: number): string {
  const date = new Date(Date.now() - days * 24 * 60 * 60_000);
  return date.toISOString().slice(0, 10);
}

export function AdminAuditPage({
  onAuthRequired,
}: {
  onAuthRequired: () => void;
}) {
  const [since, setSince] = useState(isoDaysAgo(DEFAULT_WINDOW_DAYS));
  const [until, setUntil] = useState("");
  const [action, setAction] = useState("");
  const [resourceType, setResourceType] = useState("");
  const [result, setResult] = useState("");
  const [actorId, setActorId] = useState("");
  const [admins, setAdmins] = useState<AdminUserSummary[]>([]);

  useEffect(() => {
    let active = true;
    apiClient
      .listAdminUsers({ limit: 100 })
      .then((page) => {
        if (active)
          setAdmins(page.users.filter((user) => user.role === "admin"));
      })
      .catch((error: unknown) => {
        if (active && error instanceof ApiClientError && error.isAuthRequired)
          onAuthRequired();
      });
    return () => {
      active = false;
    };
  }, [onAuthRequired]);

  const validDates =
    (!since || !Number.isNaN(new Date(`${since}T00:00:00Z`).getTime())) &&
    (!until || !Number.isNaN(new Date(`${until}T00:00:00Z`).getTime())) &&
    (!since || !until || since <= until);
  const query = useMemo<AdminAuditLogQuery>(
    () => ({
      since:
        validDates && since
          ? new Date(`${since}T00:00:00Z`).toISOString()
          : undefined,
      until:
        validDates && until
          ? new Date(`${until}T23:59:59.999Z`).toISOString()
          : undefined,
      action: action || undefined,
      resourceType: resourceType || undefined,
      result: (result || undefined) as AdminAuditLogQuery["result"],
      actorId: actorId || undefined,
    }),
    [since, until, action, resourceType, result, actorId, validDates],
  );

  const fetchEntries = useCallback(
    async (cursor?: string) => {
      if (!validDates) return { items: [], nextCursor: undefined };
      const page = await apiClient.listAdminAuditLogs({
        ...query,
        limit: PAGE_SIZE,
        cursor,
      });
      return { items: page.entries, nextCursor: page.nextCursor };
    },
    [query, validDates],
  );
  const collection = useAdminCollection(fetchEntries, onAuthRequired);
  const { items: entries, loading, loadError, reload } = collection;

  function resetFilters() {
    setSince(isoDaysAgo(DEFAULT_WINDOW_DAYS));
    setUntil("");
    setAction("");
    setResourceType("");
    setResult("");
    setActorId("");
  }

  return (
    <div className="page admin-page">
      <PageHeader
        title="审计记录"
        description="默认查看最近 7 天的操作，日期筛选按 UTC 计算。"
      />

      <div className="admin-filter-grid">
        <Field label="开始日期">
          <Input
            type="date"
            value={since}
            max="2100-12-31"
            onChange={(event) => setSince(event.target.value)}
          />
        </Field>
        <Field label="结束日期">
          <Input
            type="date"
            value={until}
            min={since || undefined}
            max="2100-12-31"
            onChange={(event) => setUntil(event.target.value)}
          />
        </Field>
        <Field label="操作类型">
          <Select
            value={action}
            onChange={(event) => setAction(event.target.value)}
          >
            <option value="">全部操作</option>
            {ACTIONS.map((value) => (
              <option key={value} value={value}>
                {actionLabel(value)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="资源类型">
          <Select
            value={resourceType}
            onChange={(event) => setResourceType(event.target.value)}
          >
            <option value="">全部资源</option>
            {RESOURCE_TYPES.map((value) => (
              <option key={value} value={value}>
                {resourceLabel(value)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="操作人">
          <Select
            value={actorId}
            onChange={(event) => setActorId(event.target.value)}
          >
            <option value="">全部操作人</option>
            {admins.map((admin) => (
              <option key={admin.id} value={admin.id}>
                {admin.email}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="结果">
          <Select
            value={result}
            onChange={(event) => setResult(event.target.value)}
          >
            <option value="">全部结果</option>
            <option value="succeeded">成功</option>
            <option value="failed">失败</option>
          </Select>
        </Field>
        <div className="admin-filter-actions">
          <Button variant="secondary" onClick={resetFilters}>
            重置筛选
          </Button>
        </div>
      </div>

      {!validDates ? (
        <Alert tone="danger">请选择有效日期，结束日期不能早于开始日期。</Alert>
      ) : loading ? (
        <div className="admin-loading" aria-busy="true">
          <Spinner label="正在加载审计记录" />
        </div>
      ) : loadError ? (
        <EmptyState
          title="审计记录暂时无法加载"
          description="审计记录加载失败，请重试。"
          action={
            <Button variant="secondary" onClick={reload}>
              重试
            </Button>
          }
        />
      ) : entries.length === 0 ? (
        <EmptyState
          title="没有匹配的审计记录"
          description="所选时间内没有符合筛选条件的操作记录。"
          action={
            <Button variant="secondary" onClick={resetFilters}>
              重置筛选
            </Button>
          }
        />
      ) : (
        <>
          <DataTable caption="操作审计记录" minWidth="wide">
            <thead>
              <tr>
                <th scope="col">时间</th>
                <th scope="col">操作人</th>
                <th scope="col">操作类型</th>
                <th scope="col">关联资源</th>
                <th scope="col">结果</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td data-label="时间">
                    <span className="admin-dimmed admin-time">
                      {formatDateTime(entry.createdAt)}
                    </span>
                  </td>
                  <td data-label="操作人">
                    <span>{entry.actorEmail ?? "系统"}</span>
                    {entry.ownerEmail &&
                    entry.ownerEmail !== entry.actorEmail ? (
                      <span className="admin-dimmed admin-quota-of">
                        {" "}
                        → {entry.ownerEmail}
                      </span>
                    ) : null}
                  </td>
                  <td data-label="操作类型">
                    <span className="admin-mono admin-action">
                      {actionLabel(entry.action)}
                    </span>
                    <details className="admin-technical-details">
                      <summary>操作标识</summary>
                      <code>{entry.action}</code>
                      <p>请求编号：{entry.requestId}</p>
                    </details>
                  </td>
                  <td data-label="关联资源">
                    <span>
                      {resourceLabel(entry.resourceType)}
                      {entry.resourceId ? (
                        <span className="admin-dimmed admin-mono admin-resource-id">
                          {" "}
                          <details className="admin-technical-details">
                            <summary>查看编号</summary>
                            <code>{entry.resourceId}</code>
                          </details>
                        </span>
                      ) : null}
                    </span>
                  </td>
                  <td data-label="结果">
                    <div className="admin-status-stack">
                      <Badge
                        tone={
                          entry.result === "succeeded" ? "success" : "danger"
                        }
                      >
                        {statusLabel(entry.result)}
                      </Badge>
                      {entry.errorCode ? (
                        <span className="admin-mono admin-dimmed">
                          {entry.errorCode}
                        </span>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </>
      )}
      {!loading && !loadError && validDates ? (
        <AdminPagination {...collection} count={entries.length} />
      ) : null}
    </div>
  );
}

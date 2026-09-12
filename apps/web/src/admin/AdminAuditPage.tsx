import { useEffect, useMemo, useState } from "react";
import {
  ApiClientError,
  apiClient,
  type AdminAuditEntry,
  type AdminAuditLogQuery,
  type AdminUserSummary,
} from "../api.js";
import {
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
  const [entries, setEntries] = useState<AdminAuditEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [since, setSince] = useState(isoDaysAgo(DEFAULT_WINDOW_DAYS));
  const [until, setUntil] = useState("");
  const [action, setAction] = useState("");
  const [resourceType, setResourceType] = useState("");
  const [result, setResult] = useState("");
  const [actorId, setActorId] = useState("");
  const [admins, setAdmins] = useState<AdminUserSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    apiClient
      .listAdminUsers({ limit: 100 })
      .then((page) =>
        setAdmins(page.users.filter((user) => user.role === "admin")),
      )
      .catch(() => undefined);
  }, []);

  const query = useMemo<AdminAuditLogQuery>(
    () => ({
      since: since ? new Date(`${since}T00:00:00Z`).toISOString() : undefined,
      until: until
        ? new Date(`${until}T23:59:59.999Z`).toISOString()
        : undefined,
      action: action || undefined,
      resourceType: resourceType || undefined,
      result: (result || undefined) as AdminAuditLogQuery["result"],
      actorId: actorId || undefined,
    }),
    [since, until, action, resourceType, result, actorId],
  );

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(false);
    apiClient
      .listAdminAuditLogs({ ...query, limit: PAGE_SIZE })
      .then((page) => {
        if (!active) return;
        setEntries(page.entries);
        setNextCursor(page.nextCursor);
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
  }, [query, onAuthRequired, reloadKey]);

  function loadMore() {
    if (!nextCursor) return;
    apiClient
      .listAdminAuditLogs({ ...query, limit: PAGE_SIZE, cursor: nextCursor })
      .then((page) => {
        setEntries((current) => [...current, ...page.entries]);
        setNextCursor(page.nextCursor);
      })
      .catch((error: unknown) => {
        if (error instanceof ApiClientError && error.isAuthRequired) {
          onAuthRequired();
        }
      });
  }

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
      <PageHeader title="Audit" description="Last 7 days by default." />

      <div className="admin-filter-grid">
        <Field label="From">
          <Input
            type="date"
            value={since}
            max="2100-12-31"
            onChange={(event) => setSince(event.target.value)}
          />
        </Field>
        <Field label="To">
          <Input
            type="date"
            value={until}
            min={since || undefined}
            max="2100-12-31"
            onChange={(event) => setUntil(event.target.value)}
          />
        </Field>
        <Field label="Action">
          <Select
            value={action}
            onChange={(event) => setAction(event.target.value)}
          >
            <option value="">All actions</option>
            {ACTIONS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Resource type">
          <Select
            value={resourceType}
            onChange={(event) => setResourceType(event.target.value)}
          >
            <option value="">All resources</option>
            {RESOURCE_TYPES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Operator">
          <Select
            value={actorId}
            onChange={(event) => setActorId(event.target.value)}
          >
            <option value="">Anyone</option>
            {admins.map((admin) => (
              <option key={admin.id} value={admin.id}>
                {admin.email}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Result">
          <Select
            value={result}
            onChange={(event) => setResult(event.target.value)}
          >
            <option value="">Any result</option>
            <option value="succeeded">Succeeded</option>
            <option value="failed">Failed</option>
          </Select>
        </Field>
        <div className="admin-filter-actions">
          <Button variant="secondary" onClick={resetFilters}>
            Reset
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="admin-loading" aria-busy="true">
          <Spinner label="Loading audit log" />
        </div>
      ) : loadError ? (
        <EmptyState
          title="Audit log unavailable"
          description="Audit entries could not be loaded."
          action={
            <Button
              variant="secondary"
              onClick={() => setReloadKey((key) => key + 1)}
            >
              Retry
            </Button>
          }
        />
      ) : entries.length === 0 ? (
        <EmptyState
          title="No matching entries"
          description="No audit entries match these filters in the selected window."
        />
      ) : (
        <>
          <DataTable caption="Audit log" minWidth="wide">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Operator</th>
                <th scope="col">Action</th>
                <th scope="col">Resource</th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td data-label="Time">
                    <span className="admin-dimmed admin-time">
                      {formatDateTime(entry.createdAt)}
                    </span>
                  </td>
                  <td data-label="Operator">
                    <span>{entry.actorEmail ?? "System"}</span>
                    {entry.ownerEmail &&
                    entry.ownerEmail !== entry.actorEmail ? (
                      <span className="admin-dimmed admin-quota-of">
                        {" "}
                        → {entry.ownerEmail}
                      </span>
                    ) : null}
                  </td>
                  <td data-label="Action">
                    <span className="admin-mono admin-action">
                      {entry.action}
                    </span>
                  </td>
                  <td data-label="Resource">
                    <span>
                      {entry.resourceType}
                      {entry.resourceId ? (
                        <span className="admin-dimmed admin-mono admin-resource-id">
                          {" "}
                          {truncateId(entry.resourceId)}
                        </span>
                      ) : null}
                    </span>
                  </td>
                  <td data-label="Result">
                    <div className="admin-status-stack">
                      <Badge
                        tone={
                          entry.result === "succeeded" ? "success" : "danger"
                        }
                      >
                        {entry.result}
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
          {nextCursor ? (
            <div className="admin-load-more">
              <Button variant="secondary" onClick={loadMore}>
                Load more
              </Button>
            </div>
          ) : (
            <p className="admin-table-end">End of entries</p>
          )}
        </>
      )}
    </div>
  );
}

function truncateId(value: string): string {
  return value.length > 13 ? `${value.slice(0, 13)}…` : value;
}

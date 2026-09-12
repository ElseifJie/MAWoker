import {
  ArrowLeft,
  KeyRound,
  LogOut,
  Power,
  ShieldCheck,
  ShieldOff,
} from "lucide-react";
import { type SyntheticEvent, useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { PASSWORD_MIN_LENGTH } from "@pwa/contracts";
import {
  ApiClientError,
  apiClient,
  type AdminAuditEntry,
  type AdminPlatformAgent,
  type AdminQuota,
  type AdminUserDetail,
  type AdminUserSession,
} from "../api.js";
import {
  Alert,
  Badge,
  Button,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  Input,
  PageHeader,
  PasswordInput,
  Select,
  Spinner,
  type BadgeTone,
} from "../ui/index.js";
import { formatCount, formatDate, formatDateTime } from "./format.js";
import { userAdminErrorMessage } from "./AdminUsersPage.js";

const PAGE_SIZE = 25;

const QUOTA_FIELDS: Array<{ key: keyof AdminQuota; label: string }> = [
  { key: "personalAgentLimit", label: "Personal Agent limit" },
  { key: "concurrentSessionLimit", label: "Concurrent Session limit" },
  { key: "dailySessionLimit", label: "Daily Session limit" },
  { key: "monthlyTokenLimit", label: "Monthly token limit" },
];

type Tab = "overview" | "usage" | "sessions" | "audit";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "usage", label: "Usage" },
  { id: "sessions", label: "Sessions" },
  { id: "audit", label: "Audit" },
];

type QuotaDraft = Record<keyof AdminQuota, string>;

/** Empty input = inherit the default policy on that dimension. */
function draftFromDetail(detail: AdminUserDetail): QuotaDraft {
  return {
    personalAgentLimit: detail.inherited.personalAgentLimit
      ? ""
      : String(detail.quota.personalAgentLimit),
    concurrentSessionLimit: detail.inherited.concurrentSessionLimit
      ? ""
      : String(detail.quota.concurrentSessionLimit),
    dailySessionLimit: detail.inherited.dailySessionLimit
      ? ""
      : String(detail.quota.dailySessionLimit),
    monthlyTokenLimit: detail.inherited.monthlyTokenLimit
      ? ""
      : String(detail.quota.monthlyTokenLimit),
  };
}

function parseDraft(
  draft: QuotaDraft,
): Partial<Record<keyof AdminQuota, number | null>> | null {
  const values: Partial<Record<keyof AdminQuota, number | null>> = {};
  for (const { key } of QUOTA_FIELDS) {
    const raw = draft[key].trim();
    if (raw === "") {
      values[key] = null;
      continue;
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) return null;
    values[key] = value;
  }
  return values;
}

function dimensionTone(exhausted: boolean, near: boolean): BadgeTone {
  if (exhausted) return "danger";
  if (near) return "warning";
  return "neutral";
}

export function AdminUserDetailPage({
  agents,
  onAuthRequired,
}: {
  agents: AdminPlatformAgent[];
  onAuthRequired: () => void;
}) {
  const { userId } = useParams<{ userId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const tab: Tab = TABS.some(({ id }) => id === tabParam)
    ? (tabParam as Tab)
    : "overview";

  const [detail, setDetail] = useState<AdminUserDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [feedback, setFeedback] = useState<{
    tone: "success" | "danger";
    message: string;
  } | null>(null);

  const [quotaDraft, setQuotaDraft] = useState<QuotaDraft | null>(null);
  const [quotaPending, setQuotaPending] = useState(false);
  const [agentSelection, setAgentSelection] = useState("");
  const [agentPending, setAgentPending] = useState(false);

  const [resetOpen, setResetOpen] = useState(false);
  const [resetDraft, setResetDraft] = useState({
    password: "",
    confirmPassword: "",
  });
  const [resetPending, setResetPending] = useState(false);
  const [resetFeedback, setResetFeedback] = useState<string | null>(null);
  const resetPasswordRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const [action, setAction] = useState<
    "disable" | "enable" | "signout" | "role" | null
  >(null);
  const [actionPending, setActionPending] = useState(false);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);

  useEffect(() => {
    if (!userId) return;
    let active = true;
    setLoading(true);
    setNotFound(false);
    apiClient
      .getAdminUser(userId)
      .then((result) => {
        if (!active) return;
        setDetail(result);
        setQuotaDraft(draftFromDetail(result));
        setAgentSelection(result.defaultAgentId ?? "");
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof ApiClientError && error.isAuthRequired) {
          onAuthRequired();
          return;
        }
        setNotFound(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [userId, onAuthRequired]);

  async function refreshDetail() {
    if (!userId) return;
    // Preserve an unsaved Default Agent selection across quota refreshes.
    const previousDefault = detail?.defaultAgentId ?? null;
    const result = await apiClient.getAdminUser(userId);
    setDetail(result);
    setQuotaDraft(draftFromDetail(result));
    setAgentSelection((current) =>
      current === (previousDefault ?? "")
        ? (result.defaultAgentId ?? "")
        : current,
    );
  }

  async function saveQuota() {
    if (!userId || !quotaDraft || quotaPending) return;
    const parsed = parseDraft(quotaDraft);
    if (!parsed) {
      setFeedback({
        tone: "danger",
        message: "Overrides must be non-negative whole numbers.",
      });
      return;
    }
    setQuotaPending(true);
    setFeedback(null);
    try {
      await apiClient.updateAdminUserQuota(userId, parsed);
      await refreshDetail();
      setFeedback({ tone: "success", message: "Quotas saved." });
    } catch (error) {
      if (error instanceof ApiClientError && error.isAuthRequired) {
        onAuthRequired();
        return;
      }
      setFeedback({
        tone: "danger",
        message:
          error instanceof ApiClientError && error.retryable
            ? "The service is temporarily unavailable. Try again."
            : "Quotas could not be saved. Review the values and try again.",
      });
    } finally {
      setQuotaPending(false);
    }
  }

  async function saveDefaultAgent() {
    if (!userId || agentPending) return;
    setAgentPending(true);
    setFeedback(null);
    try {
      const assignment = await apiClient.assignAdminDefaultAgent(
        userId,
        agentSelection,
      );
      setDetail((current) =>
        current
          ? { ...current, defaultAgentId: assignment.platformAgentId }
          : current,
      );
      setFeedback({ tone: "success", message: "Default Agent saved." });
    } catch (error) {
      if (error instanceof ApiClientError && error.isAuthRequired) {
        onAuthRequired();
        return;
      }
      setFeedback({
        tone: "danger",
        message: "The default Agent could not be saved.",
      });
    } finally {
      setAgentPending(false);
    }
  }

  async function submitReset(
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ) {
    event.preventDefault();
    if (!userId || resetPending) return;
    if (resetDraft.password !== resetDraft.confirmPassword) {
      setResetFeedback("The passwords do not match.");
      return;
    }
    setResetPending(true);
    setResetFeedback(null);
    try {
      await apiClient.resetAdminUserPassword(userId, resetDraft.password);
      setDetail((current) =>
        current ? { ...current, hasPassword: true } : current,
      );
      setResetOpen(false);
      setFeedback({ tone: "success", message: "Password reset." });
    } catch (error) {
      if (error instanceof ApiClientError && error.isAuthRequired) {
        onAuthRequired();
        return;
      }
      setResetFeedback(
        userAdminErrorMessage(error, "The password could not be reset."),
      );
    } finally {
      setResetPending(false);
    }
  }

  async function runAction() {
    if (!detail || !action || actionPending) return;
    setActionPending(true);
    setActionFeedback(null);
    try {
      if (action === "disable" || action === "enable") {
        await apiClient.setAdminUserStatus(
          detail.id,
          action === "disable" ? "disabled" : "active",
        );
      } else if (action === "signout") {
        await apiClient.revokeAdminUserSessions(detail.id);
      } else {
        await apiClient.setAdminUserRole(
          detail.id,
          detail.role === "admin" ? "user" : "admin",
        );
      }
      setAction(null);
      await refreshDetail();
      setFeedback({
        tone: "success",
        message: "Change applied.",
      });
    } catch (error) {
      if (error instanceof ApiClientError && error.isAuthRequired) {
        onAuthRequired();
        return;
      }
      setActionFeedback(
        error instanceof ApiClientError
          ? lifecycleMessage(error)
          : "The change could not be applied. Try again.",
      );
    } finally {
      setActionPending(false);
    }
  }

  if (loading) {
    return (
      <div className="page admin-page" aria-busy="true">
        <Spinner label="Loading account" />
        <p className="admin-dimmed">Loading account…</p>
      </div>
    );
  }

  if (notFound || !detail || !quotaDraft) {
    return (
      <div className="page admin-page">
        <EmptyState
          title="Account not found"
          description="This account does not exist or is no longer available."
          action={
            <Button variant="secondary">
              <Link to="/admin/users">Back to users</Link>
            </Button>
          }
        />
      </div>
    );
  }

  const quotaDirty =
    JSON.stringify(quotaDraft) !== JSON.stringify(draftFromDetail(detail));

  return (
    <div className="page admin-page">
      <Link className="admin-back-link" to="/admin/users">
        <ArrowLeft size={14} aria-hidden="true" />
        Users
      </Link>
      <PageHeader
        eyebrow="User account"
        title={detail.email}
        description={`Created ${formatDate(detail.createdAt)} · Member ID ${detail.id}`}
        headingRef={headingRef}
        actions={
          <>
            <Button
              variant="secondary"
              aria-label={`Reset password for ${detail.email}`}
              onClick={() => {
                setResetDraft({ password: "", confirmPassword: "" });
                setResetFeedback(null);
                setResetOpen(true);
              }}
            >
              <KeyRound size={15} aria-hidden="true" />
              Reset password
            </Button>
            <Button variant="secondary" onClick={() => setAction("signout")}>
              <LogOut size={15} aria-hidden="true" />
              Force sign-out
            </Button>
            <Button
              variant="secondary"
              onClick={() =>
                setAction(detail.status === "active" ? "disable" : "enable")
              }
            >
              <Power size={15} aria-hidden="true" />
              {detail.status === "active" ? "Disable" : "Enable"}
            </Button>
            <Button variant="secondary" onClick={() => setAction("role")}>
              {detail.role === "admin" ? (
                <ShieldOff size={15} aria-hidden="true" />
              ) : (
                <ShieldCheck size={15} aria-hidden="true" />
              )}
              {detail.role === "admin" ? "Revoke admin" : "Make admin"}
            </Button>
          </>
        }
      />

      <div className="admin-user-cell admin-user-badges">
        <Badge tone={detail.role === "admin" ? "info" : "neutral"}>
          {detail.role === "admin" ? "Administrator" : "User"}
        </Badge>
        <Badge tone={detail.status === "active" ? "success" : "neutral"}>
          {detail.status}
        </Badge>
        <Badge tone={detail.hasPassword ? "neutral" : "warning"}>
          {detail.hasPassword ? "Password set" : "No password"}
        </Badge>
      </div>

      <div className="admin-tabs" role="tablist" aria-label="Account detail">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`admin-tab${tab === id ? " admin-tab--active" : ""}`}
            onClick={() =>
              setSearchParams(id === "overview" ? {} : { tab: id }, {
                replace: true,
              })
            }
          >
            {label}
          </button>
        ))}
      </div>

      {feedback ? (
        <Alert
          className="admin-page-feedback"
          tone={feedback.tone}
          role={feedback.tone === "success" ? "status" : "alert"}
        >
          {feedback.message}
        </Alert>
      ) : null}

      {tab === "overview" ? (
        <div className="admin-detail-grid">
          <section className="admin-section" aria-label="Identity">
            <h2 className="admin-section__title">Identity</h2>
            <dl className="admin-definition-list">
              <div>
                <dt>Email</dt>
                <dd>{detail.email}</dd>
              </div>
              <div>
                <dt>Role</dt>
                <dd>{detail.role === "admin" ? "Administrator" : "User"}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{detail.status}</dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{formatDateTime(detail.createdAt)}</dd>
              </div>
              <div>
                <dt>Updated</dt>
                <dd>{formatDateTime(detail.updatedAt)}</dd>
              </div>
            </dl>
            {detail.role === "user" ? (
              <>
                <h3 className="admin-section__subtitle">Default Agent</h3>
                <div className="admin-default-agent-controls">
                  <Select
                    aria-label={`Default Agent for ${detail.email}`}
                    value={agentSelection}
                    onChange={(event) => setAgentSelection(event.target.value)}
                    disabled={agentPending || detail.status !== "active"}
                  >
                    <option value="" disabled>
                      Select Agent
                    </option>
                    {agents.map((agent) => (
                      <option
                        key={agent.id}
                        value={agent.id}
                        disabled={agent.status !== "active"}
                      >
                        {agent.name}
                      </option>
                    ))}
                  </Select>
                  <Button
                    size="compact"
                    variant="secondary"
                    aria-label={`Save default Agent for ${detail.email}`}
                    onClick={() => void saveDefaultAgent()}
                    loading={agentPending}
                    disabled={
                      detail.status !== "active" ||
                      agentSelection === (detail.defaultAgentId ?? "")
                    }
                  >
                    <span
                      className="admin-loading-icon-slot"
                      aria-hidden="true"
                    >
                      {agentPending ? <Spinner size={14} /> : null}
                    </span>
                    Save
                  </Button>
                </div>
                {agents.length === 0 ? (
                  <p className="form-note">
                    No Platform Agent exists yet.{" "}
                    <Link to="/admin/platform-agents">Create one</Link> before
                    assigning a default.
                  </p>
                ) : null}
              </>
            ) : null}
          </section>

          {detail.role === "user" ? (
            <section className="admin-section" aria-label="Quotas">
              <h2 className="admin-section__title">Quotas</h2>
              <p className="admin-dimmed admin-section__hint">
                Empty fields inherit the default policy; a value overrides just
                that dimension for this account.
              </p>
              <div className="admin-quota-fields">
                {QUOTA_FIELDS.map(({ key, label }) => (
                  <Field
                    label={label}
                    key={key}
                    hint={
                      detail.inherited[key]
                        ? `Inheriting default (${formatCount(detail.quota[key])})`
                        : `Override · effective ${formatCount(detail.quota[key])}`
                    }
                  >
                    <Input
                      aria-label={`${label} for ${detail.email}`}
                      type="number"
                      min={0}
                      max={Number.MAX_SAFE_INTEGER}
                      step={1}
                      placeholder={String(detail.quota[key])}
                      value={quotaDraft[key]}
                      disabled={quotaPending || detail.status !== "active"}
                      onChange={(event) =>
                        setQuotaDraft((current) =>
                          current
                            ? { ...current, [key]: event.target.value }
                            : current,
                        )
                      }
                    />
                  </Field>
                ))}
              </div>
              <Button
                size="compact"
                variant="secondary"
                className="admin-save-quotas"
                aria-label={`Save quotas for ${detail.email}`}
                onClick={() => void saveQuota()}
                loading={quotaPending}
                disabled={
                  detail.status !== "active" ||
                  !quotaDirty ||
                  parseDraft(quotaDraft) === null
                }
              >
                <span className="admin-loading-icon-slot" aria-hidden="true">
                  {quotaPending ? <Spinner size={14} /> : null}
                </span>
                Save quotas
              </Button>
            </section>
          ) : null}
        </div>
      ) : null}

      {tab === "usage" ? <UsageTab detail={detail} /> : null}
      {tab === "sessions" ? (
        <SessionsTab userId={detail.id} onAuthRequired={onAuthRequired} />
      ) : null}
      {tab === "audit" ? (
        <AuditTab userId={detail.id} onAuthRequired={onAuthRequired} />
      ) : null}

      <Dialog
        open={resetOpen}
        title="Reset password"
        eyebrow="User account"
        onClose={() => {
          if (resetPending) return;
          setResetOpen(false);
          setResetFeedback(null);
        }}
        closeLabel="Close password reset dialog"
        closeDisabled={resetPending}
        initialFocusRef={resetPasswordRef}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setResetOpen(false);
                setResetFeedback(null);
              }}
              disabled={resetPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              form={`admin-user-password-form-${detail.id}`}
              loading={resetPending}
              disabled={
                resetDraft.password.length < PASSWORD_MIN_LENGTH ||
                resetDraft.password !== resetDraft.confirmPassword
              }
            >
              <span className="admin-loading-icon-slot" aria-hidden="true">
                {resetPending ? <Spinner size={15} /> : null}
              </span>
              Reset password
            </Button>
          </>
        }
      >
        <p className="admin-dialog-copy">
          Set a new password for <strong>{detail.email}</strong>. Existing
          sessions for this account are signed out.
        </p>
        <form
          id={`admin-user-password-form-${detail.id}`}
          className="admin-agent-editor-form"
          onSubmit={submitReset}
        >
          <Field
            label="New password"
            hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
          >
            <PasswordInput
              ref={resetPasswordRef}
              autoComplete="new-password"
              value={resetDraft.password}
              minLength={PASSWORD_MIN_LENGTH}
              maxLength={200}
              required
              disabled={resetPending}
              onChange={(event) =>
                setResetDraft((current) => ({
                  ...current,
                  password: event.target.value,
                }))
              }
            />
          </Field>
          <Field label="Confirm password">
            <PasswordInput
              autoComplete="new-password"
              value={resetDraft.confirmPassword}
              minLength={PASSWORD_MIN_LENGTH}
              maxLength={200}
              required
              disabled={resetPending}
              onChange={(event) =>
                setResetDraft((current) => ({
                  ...current,
                  confirmPassword: event.target.value,
                }))
              }
            />
          </Field>
        </form>
        {resetFeedback ? (
          <Alert className="admin-dialog-feedback" tone="danger">
            {resetFeedback}
          </Alert>
        ) : null}
      </Dialog>

      <Dialog
        open={action !== null}
        title={
          action === "disable"
            ? "Disable account"
            : action === "enable"
              ? "Enable account"
              : action === "signout"
                ? "Force sign-out"
                : "Change role"
        }
        eyebrow="User account"
        onClose={() => {
          if (actionPending) return;
          setAction(null);
          setActionFeedback(null);
        }}
        closeLabel="Close confirmation dialog"
        closeDisabled={actionPending}
        fallbackFocusRef={headingRef}
        footer={
          <>
            <Button
              data-dialog-initial-focus
              variant="secondary"
              onClick={() => {
                setAction(null);
                setActionFeedback(null);
              }}
              disabled={actionPending}
            >
              Cancel
            </Button>
            <Button
              variant={
                action === "disable" || action === "role" ? "danger" : "primary"
              }
              onClick={() => void runAction()}
              loading={actionPending}
            >
              <span className="admin-loading-icon-slot" aria-hidden="true">
                {actionPending ? <Spinner size={15} /> : null}
              </span>
              Confirm
            </Button>
          </>
        }
      >
        <p className="admin-dialog-copy">
          {action === "disable"
            ? `Disabling ${detail.email} signs out all of its active sessions immediately. Its data is kept.`
            : action === "enable"
              ? `${detail.email} will be able to sign in again with its existing password.`
              : action === "signout"
                ? `All active sessions for ${detail.email} are revoked immediately.`
                : detail.role === "admin"
                  ? `${detail.email} loses administrator access. Its sessions are revoked so the change applies immediately.`
                  : `${detail.email} becomes an administrator with full console access. Its sessions are revoked so the change applies immediately.`}
        </p>
        {actionFeedback ? (
          <Alert className="admin-dialog-feedback" tone="danger">
            {actionFeedback}
          </Alert>
        ) : null}
      </Dialog>
    </div>
  );
}

function lifecycleMessage(error: ApiClientError): string {
  if (error.code === "SELF_TARGET_FORBIDDEN") {
    return "You cannot target your own account with this action.";
  }
  if (error.code === "LAST_ACTIVE_ADMIN") {
    return "You cannot disable or demote the last active administrator.";
  }
  if (error.retryable) {
    return "The service is temporarily unavailable. Try again.";
  }
  return "The change could not be applied. Try again.";
}

function UsageTab({ detail }: { detail: AdminUserDetail }) {
  const exhausted = detail.exhausted;
  const near = (
    exhaustedKey: keyof AdminUserDetail["exhausted"],
    consumed: number,
    limit: number,
  ) => !exhausted[exhaustedKey] && limit > 0 && consumed >= limit * 0.8;
  const dimension = (
    label: string,
    consumed: number,
    limit: number,
    isExhausted: boolean,
    isNear: boolean,
  ) => (
    <div className="admin-usage-dimension">
      <div className="admin-usage-dimension__head">
        <span>{label}</span>
        <Badge tone={dimensionTone(isExhausted, isNear)}>
          {isExhausted ? "exhausted" : isNear ? "near" : "ok"}
        </Badge>
      </div>
      <span className="admin-mono">
        {formatCount(consumed)}
        <span className="admin-dimmed"> / {formatCount(limit)}</span>
      </span>
    </div>
  );
  return (
    <section className="admin-section" aria-label="Monthly usage">
      <h2 className="admin-section__title">This month</h2>
      <div className="admin-usage-grid">
        {dimension(
          "Personal Agents",
          detail.usage.personalAgents,
          detail.quota.personalAgentLimit,
          exhausted.personalAgents,
          near(
            "personalAgents",
            detail.usage.personalAgents,
            detail.quota.personalAgentLimit,
          ),
        )}
        {dimension(
          "Concurrent Sessions",
          detail.usage.concurrentSessions,
          detail.quota.concurrentSessionLimit,
          exhausted.concurrentSessions,
          near(
            "concurrentSessions",
            detail.usage.concurrentSessions,
            detail.quota.concurrentSessionLimit,
          ),
        )}
        {dimension(
          "Sessions today",
          detail.usage.dailySessions,
          detail.quota.dailySessionLimit,
          exhausted.dailySessions,
          near(
            "dailySessions",
            detail.usage.dailySessions,
            detail.quota.dailySessionLimit,
          ),
        )}
        {dimension(
          "Tokens",
          detail.usage.tokens,
          detail.quota.monthlyTokenLimit,
          exhausted.monthlyTokens,
          near(
            "monthlyTokens",
            detail.usage.tokens,
            detail.quota.monthlyTokenLimit,
          ),
        )}
      </div>
      <dl className="admin-definition-list admin-usage-extra">
        <div>
          <dt>Input tokens</dt>
          <dd className="admin-mono">
            {formatCount(detail.usage.inputTokens)}
          </dd>
        </div>
        <div>
          <dt>Output tokens</dt>
          <dd className="admin-mono">
            {formatCount(detail.usage.outputTokens)}
          </dd>
        </div>
        <div>
          <dt>Tool calls</dt>
          <dd className="admin-mono">{formatCount(detail.usage.toolCalls)}</dd>
        </div>
        <div>
          <dt>Runtime</dt>
          <dd className="admin-mono">
            {formatCount(detail.usage.runtimeMs)} ms
          </dd>
        </div>
      </dl>
    </section>
  );
}

function SessionsTab({
  userId,
  onAuthRequired,
}: {
  userId: string;
  onAuthRequired: () => void;
}) {
  const [sessions, setSessions] = useState<AdminUserSession[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(false);
    apiClient
      .listAdminUserSessions(userId, { limit: PAGE_SIZE })
      .then((page) => {
        if (!active) return;
        setSessions(page.sessions);
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
  }, [userId, onAuthRequired, reloadKey]);

  if (loading) {
    return (
      <div className="admin-loading" aria-busy="true">
        <Spinner label="Loading sessions" />
      </div>
    );
  }
  if (loadError) {
    return (
      <EmptyState
        title="Sessions unavailable"
        description="Session metadata could not be loaded."
        action={
          <Button
            variant="secondary"
            onClick={() => setReloadKey((key) => key + 1)}
          >
            Retry
          </Button>
        }
      />
    );
  }
  return (
    <section className="admin-section" aria-label="Sessions">
      <h2 className="admin-section__title">Sessions</h2>
      <p className="admin-dimmed admin-section__hint">
        Metadata only — transcripts and artifacts stay with the account owner.
      </p>
      {sessions.length === 0 ? (
        <EmptyState
          title="No sessions"
          description="This account has not created any Session yet."
        />
      ) : (
        <>
          <DataTable caption="Account sessions" minWidth="wide">
            <thead>
              <tr>
                <th scope="col">Title</th>
                <th scope="col">Status</th>
                <th scope="col">Agent</th>
                <th scope="col">Created</th>
                <th scope="col">Last event</th>
                <th scope="col">Tokens</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <tr key={session.id}>
                  <th scope="row" data-label="Title">
                    {session.title || "Untitled"}
                    {session.archivedAt ? (
                      <Badge tone="neutral">archived</Badge>
                    ) : null}
                  </th>
                  <td data-label="Status">
                    <Badge
                      tone={
                        session.status === "terminated" ? "neutral" : "success"
                      }
                    >
                      {session.status}
                    </Badge>
                  </td>
                  <td data-label="Agent">
                    <span>
                      {session.agentName}
                      <span className="admin-dimmed">
                        {" "}
                        · {session.agentKind} · v{session.agentVersion}
                      </span>
                    </span>
                  </td>
                  <td data-label="Created">
                    <span className="admin-dimmed">
                      {formatDateTime(session.createdAt)}
                    </span>
                  </td>
                  <td data-label="Last event">
                    <span className="admin-dimmed">
                      {session.lastEventAt
                        ? formatDateTime(session.lastEventAt)
                        : "—"}
                    </span>
                  </td>
                  <td data-label="Tokens">
                    <span className="admin-mono">
                      {formatCount(session.tokens)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
          {nextCursor ? (
            <div className="admin-load-more">
              <Button
                variant="secondary"
                onClick={() =>
                  apiClient
                    .listAdminUserSessions(userId, {
                      limit: PAGE_SIZE,
                      cursor: nextCursor,
                    })
                    .then((page) => {
                      setSessions((current) => [...current, ...page.sessions]);
                      setNextCursor(page.nextCursor);
                    })
                    .catch(() => undefined)
                }
              >
                Load more
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

function AuditTab({
  userId,
  onAuthRequired,
}: {
  userId: string;
  onAuthRequired: () => void;
}) {
  const [entries, setEntries] = useState<AdminAuditEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(false);
    apiClient
      .listAdminUserAudit(userId, { limit: PAGE_SIZE })
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
  }, [userId, onAuthRequired, reloadKey]);

  if (loading) {
    return (
      <div className="admin-loading" aria-busy="true">
        <Spinner label="Loading audit entries" />
      </div>
    );
  }
  if (loadError) {
    return (
      <EmptyState
        title="Audit unavailable"
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
    );
  }
  return (
    <section className="admin-section" aria-label="Related audit">
      <h2 className="admin-section__title">Related audit</h2>
      {entries.length === 0 ? (
        <EmptyState
          title="No audit entries"
          description="No recorded operations involve this account."
        />
      ) : (
        <DataTable caption="Related audit entries" minWidth="wide">
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Action</th>
              <th scope="col">Operator</th>
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
                <td data-label="Action">
                  <span className="admin-mono admin-action">
                    {entry.action}
                  </span>
                </td>
                <td data-label="Operator">
                  <span>{entry.actorEmail ?? "System"}</span>
                </td>
                <td data-label="Result">
                  <Badge
                    tone={entry.result === "succeeded" ? "success" : "danger"}
                  >
                    {entry.result}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
      {nextCursor ? (
        <div className="admin-load-more">
          <Button
            variant="secondary"
            onClick={() =>
              apiClient
                .listAdminUserAudit(userId, {
                  limit: PAGE_SIZE,
                  cursor: nextCursor,
                })
                .then((page) => {
                  setEntries((current) => [...current, ...page.entries]);
                  setNextCursor(page.nextCursor);
                })
                .catch(() => undefined)
            }
          >
            Load more
          </Button>
        </div>
      ) : null}
    </section>
  );
}

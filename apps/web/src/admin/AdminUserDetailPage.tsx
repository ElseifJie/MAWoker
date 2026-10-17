import {
  ArrowLeft,
  KeyRound,
  LogOut,
  Power,
  ShieldCheck,
  ShieldOff,
} from "lucide-react";
import {
  type SyntheticEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { PASSWORD_MIN_LENGTH } from "@pwa/contracts";
import {
  ApiClientError,
  apiClient,
  type AdminPlatformAgent,
  type AdminQuota,
  type AdminUserDetail,
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
import { AdminTabs } from "./AdminTabs.js";
import { AdminPagination } from "./AdminPagination.js";
import { useAdminCollection } from "./useAdminCollection.js";
import { useAdminLifetime } from "./useAdminLifetime.js";
import { statusLabel, actionLabel } from "./presentation.js";
import { formatCount, formatDate, formatDateTime } from "./format.js";
import { userAdminErrorMessage } from "./AdminUsersPage.js";

const PAGE_SIZE = 25;

const QUOTA_FIELDS: Array<{ key: keyof AdminQuota; label: string }> = [
  { key: "personalAgentLimit", label: "个人助手上限" },
  { key: "concurrentSessionLimit", label: "同时运行任务上限" },
  { key: "dailySessionLimit", label: "每日任务上限" },
  { key: "monthlyTokenLimit", label: "每月 Token 上限" },
];

type Tab = "overview" | "usage" | "sessions" | "audit";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "概览" },
  { id: "usage", label: "用量" },
  { id: "sessions", label: "任务" },
  { id: "audit", label: "审计记录" },
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

export function AdminUserDetailPage(props: {
  agents: AdminPlatformAgent[];
  onAuthRequired: () => void;
}) {
  const { userId } = useParams<{ userId: string }>();
  return <AdminUserDetail key={userId} {...props} />;
}

function AdminUserDetail({
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
  const [loadError, setLoadError] = useState(false);
  const [revision, setRevision] = useState(0);
  const capture = useAdminLifetime();
  const mutationLock = useRef(false);
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
    setLoadError(false);
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
        if (error instanceof ApiClientError && error.status === 404)
          setNotFound(true);
        else setLoadError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [userId, onAuthRequired, revision]);

  async function refreshDetail(resetQuota = false) {
    if (!userId) return;
    // Preserve an unsaved Default Agent selection across quota refreshes.
    const previousDefault = detail?.defaultAgentId ?? null;
    const previousQuota = detail ? draftFromDetail(detail) : null;
    const isCurrent = capture();
    const result = await apiClient.getAdminUser(userId);
    if (!isCurrent()) return;
    setDetail(result);
    setQuotaDraft((current) =>
      resetQuota || JSON.stringify(current) === JSON.stringify(previousQuota)
        ? draftFromDetail(result)
        : current,
    );
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
        message: "配额必须为非负整数。",
      });
      return;
    }
    if (mutationLock.current) return;
    mutationLock.current = true;
    const isCurrent = capture();
    setQuotaPending(true);
    setFeedback(null);
    try {
      await apiClient.updateAdminUserQuota(userId, parsed);
      if (!isCurrent()) return;
      await refreshDetail(true);
      if (!isCurrent()) return;
      setFeedback({ tone: "success", message: "配额已保存。" });
    } catch (error) {
      if (!isCurrent()) return;
      if (error instanceof ApiClientError && error.isAuthRequired) {
        onAuthRequired();
        return;
      }
      setFeedback({
        tone: "danger",
        message:
          error instanceof ApiClientError && error.retryable
            ? "服务暂时不可用，请稍后重试。"
            : "配额保存失败，请检查输入后重试。",
      });
    } finally {
      mutationLock.current = false;
      if (isCurrent()) setQuotaPending(false);
    }
  }

  async function saveDefaultAgent() {
    if (!userId || agentPending) return;
    if (mutationLock.current) return;
    mutationLock.current = true;
    const isCurrent = capture();
    setAgentPending(true);
    setFeedback(null);
    try {
      const assignment = await apiClient.assignAdminDefaultAgent(
        userId,
        agentSelection,
      );
      if (!isCurrent()) return;
      setDetail((current) =>
        current
          ? { ...current, defaultAgentId: assignment.platformAgentId }
          : current,
      );
      setFeedback({ tone: "success", message: "默认助手已保存。" });
    } catch (error) {
      if (!isCurrent()) return;
      if (error instanceof ApiClientError && error.isAuthRequired) {
        onAuthRequired();
        return;
      }
      setFeedback({
        tone: "danger",
        message: "默认助手保存失败，请重试。",
      });
    } finally {
      mutationLock.current = false;
      if (isCurrent()) setAgentPending(false);
    }
  }

  async function submitReset(
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ) {
    event.preventDefault();
    if (!userId || resetPending) return;
    if (resetDraft.password !== resetDraft.confirmPassword) {
      setResetFeedback("两次输入的密码不一致。");
      return;
    }
    if (mutationLock.current) return;
    mutationLock.current = true;
    const isCurrent = capture();
    setResetPending(true);
    setResetFeedback(null);
    try {
      await apiClient.resetAdminUserPassword(userId, resetDraft.password);
      if (!isCurrent()) return;
      setDetail((current) =>
        current ? { ...current, hasPassword: true } : current,
      );
      setResetOpen(false);
      setResetDraft({ password: "", confirmPassword: "" });
      setFeedback({ tone: "success", message: "密码已重置。" });
    } catch (error) {
      if (!isCurrent()) return;
      if (error instanceof ApiClientError && error.isAuthRequired) {
        onAuthRequired();
        return;
      }
      setResetFeedback(userAdminErrorMessage(error, "密码重置失败，请重试。"));
    } finally {
      mutationLock.current = false;
      if (isCurrent()) setResetPending(false);
    }
  }

  async function runAction() {
    if (!detail || !action || actionPending) return;
    if (mutationLock.current) return;
    mutationLock.current = true;
    const isCurrent = capture();
    setActionPending(true);
    setActionFeedback(null);
    let applied = false;
    try {
      if (action === "disable" || action === "enable") {
        await apiClient.setAdminUserStatus(
          detail.id,
          action === "disable" ? "disabled" : "active",
        );
        if (!isCurrent()) return;
      } else if (action === "signout") {
        await apiClient.revokeAdminUserSessions(detail.id);
        if (!isCurrent()) return;
      } else {
        await apiClient.setAdminUserRole(
          detail.id,
          detail.role === "admin" ? "user" : "admin",
        );
        if (!isCurrent()) return;
      }
      applied = true;
      setAction(null);
      await refreshDetail();
      if (!isCurrent()) return;
      setFeedback({
        tone: "success",
        message: "操作已完成。",
      });
    } catch (error) {
      if (!isCurrent()) return;
      if (error instanceof ApiClientError && error.isAuthRequired) {
        onAuthRequired();
        return;
      }
      if (applied) {
        setFeedback({
          tone: "danger",
          message: "操作已完成，但账号信息刷新失败。请重新打开账号详情。",
        });
        return;
      }
      setActionFeedback(
        error instanceof ApiClientError
          ? lifecycleMessage(error)
          : "操作未完成，请重试。",
      );
    } finally {
      mutationLock.current = false;
      if (isCurrent()) setActionPending(false);
    }
  }

  if (loading) {
    return (
      <div className="page admin-page" aria-busy="true">
        <Spinner label="正在加载账号" />
        <p className="admin-dimmed">正在加载账号…</p>
      </div>
    );
  }

  if (loadError)
    return (
      <div className="page admin-page">
        <PageHeader title="账号详情" />
        <EmptyState
          title="账号暂时无法加载"
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
        <Link className="admin-back-link" to="/admin/users">
          返回用户管理
        </Link>
      </div>
    );

  if (notFound || !detail || !quotaDraft) {
    return (
      <div className="page admin-page">
        <EmptyState
          title="账号不存在"
          description="该账号不存在或已不可用。"
          action={
            <Link
              className="ui-button ui-button--secondary ui-button--default"
              to="/admin/users"
            >
              返回用户管理
            </Link>
          }
        />
      </div>
    );
  }

  const mutating =
    quotaPending || agentPending || resetPending || actionPending;
  const quotaDirty =
    JSON.stringify(quotaDraft) !== JSON.stringify(draftFromDetail(detail));

  return (
    <div className="page admin-page">
      <Link className="admin-back-link" to="/admin/users">
        <ArrowLeft size={14} aria-hidden="true" />
        用户管理
      </Link>
      <PageHeader
        eyebrow="用户账号"
        title={detail.email}
        description={`创建于 ${formatDate(detail.createdAt)}`}
        headingRef={headingRef}
      />

      <div className="admin-user-cell admin-user-badges">
        <Badge tone={detail.role === "admin" ? "info" : "neutral"}>
          {detail.role === "admin" ? "管理员" : "个人用户"}
        </Badge>
        <Badge tone={detail.status === "active" ? "success" : "neutral"}>
          {statusLabel(detail.status)}
        </Badge>
        <Badge tone={detail.hasPassword ? "neutral" : "warning"}>
          {detail.hasPassword ? "已设置密码" : "未设置密码"}
        </Badge>
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

      <AdminTabs
        label="账号详情"
        tabs={TABS}
        value={tab}
        onChange={(value) =>
          setSearchParams(value === "overview" ? {} : { tab: value }, {
            replace: true,
          })
        }
      >
        {tab === "overview" ? (
          <div className="admin-detail-grid">
            <section
              className="admin-section admin-panel"
              aria-label="账号信息"
            >
              <h2 className="admin-section__title">账号信息</h2>
              <dl className="admin-definition-list">
                <div>
                  <dt>邮箱</dt>
                  <dd>{detail.email}</dd>
                </div>
                <div>
                  <dt>账号编号</dt>
                  <dd>
                    <details className="admin-technical-details">
                      <summary>查看编号</summary>
                      <code>{detail.id}</code>
                    </details>
                  </dd>
                </div>
                <div>
                  <dt>角色</dt>
                  <dd>{detail.role === "admin" ? "管理员" : "个人用户"}</dd>
                </div>
                <div>
                  <dt>状态</dt>
                  <dd>{statusLabel(detail.status)}</dd>
                </div>
                <div>
                  <dt>创建时间</dt>
                  <dd>{formatDateTime(detail.createdAt)}</dd>
                </div>
                <div>
                  <dt>更新时间</dt>
                  <dd>{formatDateTime(detail.updatedAt)}</dd>
                </div>
              </dl>
              {detail.role === "user" ? (
                <>
                  <h3 className="admin-section__subtitle">默认助手</h3>
                  <div className="admin-default-agent-controls">
                    <Select
                      aria-label={`${detail.email} 的默认助手`}
                      value={agentSelection}
                      onChange={(event) =>
                        setAgentSelection(event.target.value)
                      }
                      disabled={mutating || detail.status !== "active"}
                    >
                      <option value="" disabled>
                        选择默认助手
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
                      aria-label={`保存 ${detail.email} 的默认助手`}
                      onClick={() => void saveDefaultAgent()}
                      loading={agentPending}
                      disabled={
                        mutating ||
                        !agentSelection ||
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
                      保存
                    </Button>
                  </div>
                  {agents.length === 0 ? (
                    <p className="form-note">
                      暂无可用平台助手，请先
                      <Link to="/admin/platform-agents">查看平台助手配置</Link>
                      ，再分配默认助手。
                    </p>
                  ) : null}
                </>
              ) : null}
            </section>

            {detail.role === "user" ? (
              <section
                className="admin-section admin-panel"
                aria-label="使用配额"
              >
                <h2 className="admin-section__title">使用配额</h2>
                <p className="admin-dimmed admin-section__hint">
                  留空表示沿用平台默认配额；填写数值后，仅覆盖该账号对应的配额。
                </p>
                <div className="admin-quota-fields">
                  {QUOTA_FIELDS.map(({ key, label }) => (
                    <Field
                      label={label}
                      key={key}
                      error={
                        quotaDraft[key].trim() !== "" &&
                        (!Number.isSafeInteger(Number(quotaDraft[key])) ||
                          Number(quotaDraft[key]) < 0)
                          ? "请输入非负整数，或留空沿用默认值。"
                          : undefined
                      }
                      hint={
                        detail.inherited[key]
                          ? `沿用默认值（${formatCount(detail.quota[key])}）`
                          : `自定义 · 当前生效 ${formatCount(detail.quota[key])}`
                      }
                    >
                      <Input
                        aria-label={`${detail.email} 的${label}`}
                        type="number"
                        min={0}
                        max={Number.MAX_SAFE_INTEGER}
                        step={1}
                        placeholder={String(detail.quota[key])}
                        value={quotaDraft[key]}
                        disabled={mutating || detail.status !== "active"}
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
                  aria-label={`保存 ${detail.email} 的配额`}
                  onClick={() => void saveQuota()}
                  loading={quotaPending}
                  disabled={
                    mutating ||
                    detail.status !== "active" ||
                    !quotaDirty ||
                    parseDraft(quotaDraft) === null
                  }
                >
                  <span className="admin-loading-icon-slot" aria-hidden="true">
                    {quotaPending ? <Spinner size={14} /> : null}
                  </span>
                  保存配额
                </Button>
              </section>
            ) : null}
            <section
              className="admin-section admin-account-actions"
              aria-label="账号操作"
            >
              <h2 className="admin-section__title">账号操作</h2>
              <p className="admin-dimmed admin-section__hint">
                更改状态、角色或密码会使现有登录失效。操作前会再次确认。
              </p>
              <div className="admin-account-actions__buttons">
                <Button
                  variant="secondary"
                  aria-label={`重置 ${detail.email} 的密码`}
                  disabled={mutating}
                  onClick={() => {
                    setResetDraft({ password: "", confirmPassword: "" });
                    setResetFeedback(null);
                    setResetOpen(true);
                  }}
                >
                  <KeyRound size={15} aria-hidden="true" />
                  重置密码
                </Button>
                <Button
                  variant="secondary"
                  disabled={mutating}
                  onClick={() => setAction("signout")}
                >
                  <LogOut size={15} aria-hidden="true" />
                  强制退出登录
                </Button>
                <Button
                  variant="secondary"
                  disabled={mutating}
                  onClick={() =>
                    setAction(detail.status === "active" ? "disable" : "enable")
                  }
                >
                  <Power size={15} aria-hidden="true" />
                  {detail.status === "active" ? "停用" : "启用"}
                </Button>
                <Button
                  variant="secondary"
                  disabled={mutating}
                  onClick={() => setAction("role")}
                >
                  {detail.role === "admin" ? (
                    <ShieldOff size={15} aria-hidden="true" />
                  ) : (
                    <ShieldCheck size={15} aria-hidden="true" />
                  )}
                  {detail.role === "admin" ? "撤销管理员权限" : "设为管理员"}
                </Button>
              </div>
            </section>
          </div>
        ) : null}

        {tab === "usage" ? <UsageTab detail={detail} /> : null}
        {tab === "sessions" ? (
          <SessionsTab userId={detail.id} onAuthRequired={onAuthRequired} />
        ) : null}
        {tab === "audit" ? (
          <AuditTab userId={detail.id} onAuthRequired={onAuthRequired} />
        ) : null}
      </AdminTabs>

      <Dialog
        open={resetOpen}
        title="重置密码"
        eyebrow="用户账号"
        onClose={() => {
          if (resetPending) return;
          setResetOpen(false);
          setResetFeedback(null);
        }}
        closeLabel="关闭重置密码窗口"
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
              取消
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
              重置密码
            </Button>
          </>
        }
      >
        <p className="admin-dialog-copy">
          为 <strong>{detail.email}</strong> 设置新密码，现有登录将立即失效。
        </p>
        <form
          id={`admin-user-password-form-${detail.id}`}
          className="admin-agent-editor-form"
          onSubmit={submitReset}
        >
          <Field label="新密码" hint={`至少 ${PASSWORD_MIN_LENGTH} 个字符。`}>
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
          <Field
            label="确认密码"
            error={
              resetDraft.confirmPassword &&
              resetDraft.confirmPassword !== resetDraft.password
                ? "两次输入的密码不一致。"
                : undefined
            }
          >
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
            ? "停用账号"
            : action === "enable"
              ? "启用账号"
              : action === "signout"
                ? "强制退出登录"
                : "更改角色"
        }
        eyebrow="用户账号"
        onClose={() => {
          if (actionPending) return;
          setAction(null);
          setActionFeedback(null);
        }}
        closeLabel="关闭确认窗口"
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
              取消
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
              确认操作
            </Button>
          </>
        }
      >
        <p className="admin-dialog-copy">
          {action === "disable"
            ? `停用 ${detail.email} 将立即退出该账号的所有登录，账号数据会保留。`
            : action === "enable"
              ? `${detail.email} 将可以使用现有密码重新登录。`
              : action === "signout"
                ? `${detail.email} 的所有登录将立即失效。`
                : detail.role === "admin"
                  ? `${detail.email} 将失去管理权限，现有登录将失效。`
                  : `${detail.email} 将获得全部管理权限，现有登录将失效。`}
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
    return "此操作不能用于当前登录账号。";
  }
  if (error.code === "LAST_ACTIVE_ADMIN") {
    return "不能停用或降级最后一位已启用的管理员。";
  }
  if (error.retryable) {
    return "服务暂时不可用，请稍后重试。";
  }
  return "操作未完成，请重试。";
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
          {isExhausted ? "已用尽" : isNear ? "接近上限" : "正常"}
        </Badge>
      </div>
      <span className="admin-mono">
        {formatCount(consumed)}
        <span className="admin-dimmed"> / {formatCount(limit)}</span>
      </span>
    </div>
  );
  return (
    <section className="admin-section" aria-label="本月用量">
      <h2 className="admin-section__title">本月用量</h2>
      <div className="admin-usage-grid">
        {dimension(
          "个人助手",
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
          "同时运行任务",
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
          "今日任务",
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
          "Token 用量",
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
          <dt>输入 Token</dt>
          <dd className="admin-mono">
            {formatCount(detail.usage.inputTokens)}
          </dd>
        </div>
        <div>
          <dt>输出 Token</dt>
          <dd className="admin-mono">
            {formatCount(detail.usage.outputTokens)}
          </dd>
        </div>
        <div>
          <dt>工具调用</dt>
          <dd className="admin-mono">{formatCount(detail.usage.toolCalls)}</dd>
        </div>
        <div>
          <dt>运行时长</dt>
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
  const fetchPage = useCallback(
    async (cursor?: string) => {
      const page = await apiClient.listAdminUserSessions(userId, {
        limit: PAGE_SIZE,
        cursor,
      });
      return { items: page.sessions, nextCursor: page.nextCursor };
    },
    [userId],
  );
  const collection = useAdminCollection(fetchPage, onAuthRequired);
  const { items: sessions, loading, loadError, reload } = collection;

  if (loading) {
    return (
      <div className="admin-loading" aria-busy="true">
        <Spinner label="正在加载任务" />
      </div>
    );
  }
  if (loadError) {
    return (
      <EmptyState
        title="任务暂时无法加载"
        description="任务信息加载失败，请重试。"
        action={
          <Button variant="secondary" onClick={reload}>
            重试
          </Button>
        }
      />
    );
  }
  return (
    <section className="admin-section" aria-label="任务">
      <h2 className="admin-section__title">任务</h2>
      <p className="admin-dimmed admin-section__hint">
        仅展示任务元信息；对话正文和文件由账号本人查看。
      </p>
      {sessions.length === 0 ? (
        <EmptyState title="还没有任务" description="该账号尚未创建任务。" />
      ) : (
        <>
          <DataTable caption="账号任务列表" minWidth="wide">
            <thead>
              <tr>
                <th scope="col">任务标题</th>
                <th scope="col">状态</th>
                <th scope="col">助手</th>
                <th scope="col">创建时间</th>
                <th scope="col">最近活动</th>
                <th scope="col">Token 用量</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <tr key={session.id}>
                  <th scope="row" data-label="任务标题">
                    {session.title || "未命名任务"}
                    {session.archivedAt ? (
                      <Badge tone="neutral">已归档</Badge>
                    ) : null}
                  </th>
                  <td data-label="状态">
                    <Badge
                      tone={
                        session.status === "terminated" ? "neutral" : "success"
                      }
                    >
                      {statusLabel(session.status)}
                    </Badge>
                  </td>
                  <td data-label="助手">
                    <span>
                      {session.agentName}
                      <span className="admin-dimmed">
                        {" "}
                        ·{" "}
                        {session.agentKind === "platform"
                          ? "平台助手"
                          : "个人助手"}{" "}
                        · v{session.agentVersion}
                      </span>
                    </span>
                  </td>
                  <td data-label="创建时间">
                    <span className="admin-dimmed">
                      {formatDateTime(session.createdAt)}
                    </span>
                  </td>
                  <td data-label="最近活动">
                    <span className="admin-dimmed">
                      {session.lastEventAt
                        ? formatDateTime(session.lastEventAt)
                        : "—"}
                    </span>
                  </td>
                  <td data-label="Token 用量">
                    <span className="admin-mono">
                      {formatCount(session.tokens)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </>
      )}
      <AdminPagination {...collection} count={sessions.length} />
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
  const fetchPage = useCallback(
    async (cursor?: string) => {
      const page = await apiClient.listAdminUserAudit(userId, {
        limit: PAGE_SIZE,
        cursor,
      });
      return { items: page.entries, nextCursor: page.nextCursor };
    },
    [userId],
  );
  const collection = useAdminCollection(fetchPage, onAuthRequired);
  const { items: entries, loading, loadError, reload } = collection;

  if (loading) {
    return (
      <div className="admin-loading" aria-busy="true">
        <Spinner label="正在加载审计记录" />
      </div>
    );
  }
  if (loadError) {
    return (
      <EmptyState
        title="审计记录暂时无法加载"
        description="审计记录加载失败，请重试。"
        action={
          <Button variant="secondary" onClick={reload}>
            重试
          </Button>
        }
      />
    );
  }
  return (
    <section className="admin-section" aria-label="相关审计记录">
      <h2 className="admin-section__title">相关审计记录</h2>
      {entries.length === 0 ? (
        <EmptyState
          title="暂无审计记录"
          description="尚无涉及该账号的操作记录。"
        />
      ) : (
        <DataTable caption="账号相关审计记录" minWidth="wide">
          <thead>
            <tr>
              <th scope="col">时间</th>
              <th scope="col">操作类型</th>
              <th scope="col">操作人</th>
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
                <td data-label="操作类型">
                  <span>{actionLabel(entry.action)}</span>
                  <details className="admin-technical-details">
                    <summary>操作标识</summary>
                    <code>{entry.action}</code>
                  </details>
                </td>
                <td data-label="操作人">
                  <span>{entry.actorEmail ?? "系统"}</span>
                </td>
                <td data-label="结果">
                  <Badge
                    tone={entry.result === "succeeded" ? "success" : "danger"}
                  >
                    {statusLabel(entry.result)}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
      <AdminPagination {...collection} count={entries.length} />
    </section>
  );
}

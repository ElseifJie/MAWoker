import { LogOut, Power, ShieldCheck, ShieldOff, UserRound } from "lucide-react";
import { type SyntheticEvent, useCallback, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PASSWORD_MIN_LENGTH } from "@pwa/contracts";
import {
  ApiClientError,
  apiClient,
  type AdminPlatformAgent,
  type AdminUserSummary,
  type AdminUserRole,
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
  RowActionsMenu,
  Select,
  Spinner,
  type BadgeTone,
} from "../ui/index.js";
import { AdminPagination } from "./AdminPagination.js";
import { useAdminCollection } from "./useAdminCollection.js";
import { useAdminLifetime } from "./useAdminLifetime.js";
import { statusLabel } from "./presentation.js";
import { formatDate } from "./format.js";

const PAGE_SIZE = 50;

interface CreateUserDraft {
  email: string;
  password: string;
  confirmPassword: string;
  role: AdminUserRole;
}

const emptyUserDraft: CreateUserDraft = {
  email: "",
  password: "",
  confirmPassword: "",
  role: "user",
};

type LifecycleAction =
  | { kind: "disable"; user: AdminUserSummary }
  | { kind: "enable"; user: AdminUserSummary }
  | { kind: "signout"; user: AdminUserSummary }
  | { kind: "role"; user: AdminUserSummary; role: AdminUserRole };

function roleBadgeTone(role: AdminUserRole): BadgeTone {
  return role === "admin" ? "info" : "neutral";
}

function statusBadgeTone(status: AdminUserSummary["status"]): BadgeTone {
  return status === "active" ? "success" : "neutral";
}

function lifecycleCopy(action: LifecycleAction): {
  title: string;
  body: string;
  confirm: string;
} {
  switch (action.kind) {
    case "disable":
      return {
        title: "停用账号",
        body: `停用 ${action.user.email} 将立即退出该账号的所有登录。重新启用后才能登录，任务、助手和文件会保留。`,
        confirm: "停用账号",
      };
    case "enable":
      return {
        title: "启用账号",
        body: `${action.user.email} 将可以使用现有密码重新登录。`,
        confirm: "启用账号",
      };
    case "signout":
      return {
        title: "强制退出登录",
        body: `${action.user.email} 的所有登录将立即失效，账号状态保持不变。`,
        confirm: "强制退出登录",
      };
    case "role":
      return {
        title: "更改角色",
        body:
          action.role === "admin"
            ? `${action.user.email} 将获得全部管理权限，现有登录将失效。`
            : `${action.user.email} 将失去管理权限，保留个人用户能力，现有登录将失效。`,
        confirm: action.role === "admin" ? "授予管理员权限" : "撤销管理员权限",
      };
  }
}

export function AdminUsersPage({
  agents,
  onAuthRequired,
  onUserMutated,
}: {
  agents: AdminPlatformAgent[];
  onAuthRequired: () => void;
  onUserMutated: () => void;
}) {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<
    "all" | "active" | "disabled"
  >("all");
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<CreateUserDraft>(emptyUserDraft);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [action, setAction] = useState<LifecycleAction | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const capture = useAdminLifetime();
  const mutationLock = useRef(false);
  const [success, setSuccess] = useState<string | null>(null);

  const fetchUsers = useCallback(
    async (cursor?: string) => {
      const page = await apiClient.listAdminUsers({
        limit: PAGE_SIZE,
        q: search.trim() || undefined,
        cursor,
      });
      return { items: page.users, nextCursor: page.nextCursor };
    },
    [search],
  );
  const collection = useAdminCollection(
    fetchUsers,
    onAuthRequired,
    search ? 300 : 0,
  );
  const { loading, loadError, reload } = collection;
  const users =
    statusFilter === "all"
      ? collection.items
      : collection.items.filter((user) => user.status === statusFilter);
  const filtered = search.trim() !== "" || statusFilter !== "all";
  function clearFilters() {
    setSearch("");
    setStatusFilter("all");
  }

  function closeDialog() {
    if (pending) return;
    setCreating(false);
    setDraft(emptyUserDraft);
    setFeedback(null);
  }

  async function createUser(
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ) {
    event.preventDefault();
    if (pending) return;
    if (draft.password !== draft.confirmPassword) {
      setFeedback("两次输入的密码不一致。");
      return;
    }
    if (mutationLock.current) return;
    mutationLock.current = true;
    const isCurrent = capture();
    setSuccess(null);
    setPending(true);
    setFeedback(null);
    try {
      await apiClient.createAdminUser({
        email: draft.email.trim().toLowerCase(),
        password: draft.password,
        role: draft.role,
      });
      if (!isCurrent()) return;
      setSuccess("账号已创建。点击账号可分配默认助手和设置配额。");
      setCreating(false);
      setDraft(emptyUserDraft);
      onUserMutated();
      reload();
    } catch (error) {
      if (!isCurrent()) return;
      if (error instanceof ApiClientError && error.isAuthRequired) {
        onAuthRequired();
        return;
      }
      setFeedback(userAdminErrorMessage(error, "账号创建失败，请重试。"));
    } finally {
      mutationLock.current = false;
      if (isCurrent()) setPending(false);
    }
  }

  async function runAction() {
    if (!action || actionPending) return;
    if (mutationLock.current) return;
    mutationLock.current = true;
    const isCurrent = capture();
    setSuccess(null);
    setActionPending(true);
    setActionFeedback(null);
    try {
      const target = action.user;
      if (action.kind === "disable" || action.kind === "enable") {
        await apiClient.setAdminUserStatus(
          target.id,
          action.kind === "disable" ? "disabled" : "active",
        );
      } else if (action.kind === "signout") {
        await apiClient.revokeAdminUserSessions(target.id);
      } else {
        await apiClient.setAdminUserRole(target.id, action.role);
      }
      if (!isCurrent()) return;
      setSuccess("账号操作已完成。");
      setAction(null);
      onUserMutated();
      reload();
    } catch (error) {
      if (!isCurrent()) return;
      if (error instanceof ApiClientError && error.isAuthRequired) {
        onAuthRequired();
        return;
      }
      setActionFeedback(
        error instanceof ApiClientError
          ? lifecycleErrorMessage(error)
          : "操作未完成，请重试。",
      );
    } finally {
      mutationLock.current = false;
      if (isCurrent()) setActionPending(false);
    }
  }

  const actionCopy = action ? lifecycleCopy(action) : null;

  return (
    <div className="page admin-page">
      <PageHeader
        title="用户管理"
        description="管理账号、登录状态与默认助手，点击账号查看配额和使用情况。"
        headingRef={headingRef}
        actions={
          <Button onClick={() => setCreating(true)}>
            <UserRound size={16} aria-hidden="true" />
            新建账号
          </Button>
        }
      />

      <div className="admin-toolbar" role="search" aria-label="筛选用户账号">
        <div className="admin-toolbar__search-field">
          <Field label="搜索账号">
            <Input
              type="search"
              className="admin-toolbar__search"
              aria-label="搜索账号邮箱"
              placeholder="搜索邮箱…"
              value={search}
              maxLength={320}
              onChange={(event) => setSearch(event.target.value)}
            />
          </Field>
        </div>
        <Field label="账号状态">
          <Select
            aria-label="账号状态"
            className="admin-toolbar__filter"
            value={statusFilter}
            onChange={(event) =>
              setStatusFilter(event.target.value as typeof statusFilter)
            }
          >
            <option value="all">全部状态</option>
            <option value="active">已启用</option>
            <option value="disabled">已停用</option>
          </Select>
        </Field>
        {filtered && users.length > 0 ? (
          <Button variant="text" onClick={clearFilters}>
            清除筛选
          </Button>
        ) : null}
      </div>

      {success ? (
        <Alert className="admin-page-feedback" tone="success">
          {success}
        </Alert>
      ) : null}
      {feedback && !creating && !action ? (
        <Alert className="admin-page-feedback" tone="danger">
          {feedback}
        </Alert>
      ) : null}

      {loading ? (
        <div className="admin-loading" aria-busy="true">
          <Spinner label="正在加载账号" />
        </div>
      ) : loadError ? (
        <EmptyState
          title="账号暂时无法加载"
          description="账号列表加载失败，请重试。"
          action={
            <Button variant="secondary" onClick={reload}>
              重试
            </Button>
          }
        />
      ) : users.length === 0 ? (
        <EmptyState
          title={filtered ? "没有匹配的账号" : "还没有账号"}
          description={
            filtered
              ? collection.nextCursor
                ? "已加载的账号没有匹配项，可继续加载更多或清除筛选。"
                : "没有符合当前筛选条件的账号。"
              : "创建个人账号并分配默认助手，即可开始使用工作区。"
          }
          action={
            filtered ? (
              <Button variant="secondary" onClick={clearFilters}>
                清除筛选
              </Button>
            ) : (
              <Button onClick={() => setCreating(true)}>新建账号</Button>
            )
          }
        />
      ) : (
        <>
          <DataTable caption="用户账号列表" minWidth="wide">
            <thead>
              <tr>
                <th scope="col">个人用户</th>
                <th scope="col">角色</th>
                <th scope="col">状态</th>
                <th scope="col">默认助手</th>
                <th scope="col">创建时间</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => {
                const defaultAgent = agents.find(
                  (agent) => agent.id === user.defaultAgentId,
                );
                return (
                  <tr key={user.id}>
                    <th scope="row" data-label="个人用户">
                      <div className="admin-user-cell">
                        <Link
                          className="admin-user-cell__link"
                          to={`/admin/users/${user.id}`}
                        >
                          {user.email}
                        </Link>
                        <Badge tone={user.hasPassword ? "neutral" : "warning"}>
                          {user.hasPassword ? "已设置密码" : "未设置密码"}
                        </Badge>
                      </div>
                    </th>
                    <td data-label="角色">
                      <Badge tone={roleBadgeTone(user.role)}>
                        {user.role === "admin" ? "管理员" : "个人用户"}
                      </Badge>
                    </td>
                    <td data-label="状态">
                      <Badge tone={statusBadgeTone(user.status)}>
                        {statusLabel(user.status)}
                      </Badge>
                    </td>
                    <td data-label="默认助手">
                      <span className="admin-dimmed">
                        {defaultAgent
                          ? defaultAgent.name
                          : user.defaultAgentId
                            ? "助手信息暂不可用"
                            : "未分配"}
                      </span>
                    </td>
                    <td data-label="创建时间">
                      <span className="admin-dimmed">
                        {formatDate(user.createdAt)}
                      </span>
                    </td>
                    <td data-label="操作">
                      <div className="admin-row-actions">
                        <Button
                          size="compact"
                          variant="secondary"
                          aria-label={`查看 ${user.email}`}
                          onClick={() => navigate(`/admin/users/${user.id}`)}
                        >
                          查看
                        </Button>
                        <RowActionsMenu
                          label={`账号操作：${user.email}`}
                          items={[
                            {
                              icon: <Power size={14} aria-hidden="true" />,
                              text: user.status === "active" ? "停用" : "启用",
                              run: () =>
                                setAction({
                                  kind:
                                    user.status === "active"
                                      ? "disable"
                                      : "enable",
                                  user,
                                }),
                            },
                            ...(user.status === "active"
                              ? [
                                  {
                                    icon: (
                                      <LogOut size={14} aria-hidden="true" />
                                    ),
                                    text: "强制退出登录",
                                    run: () =>
                                      setAction({ kind: "signout", user }),
                                  },
                                ]
                              : []),
                            {
                              icon:
                                user.role === "admin" ? (
                                  <ShieldOff size={14} aria-hidden="true" />
                                ) : (
                                  <ShieldCheck size={14} aria-hidden="true" />
                                ),
                              text:
                                user.role === "admin"
                                  ? "撤销管理员权限"
                                  : "设为管理员",
                              run: () =>
                                setAction({
                                  kind: "role",
                                  user,
                                  role:
                                    user.role === "admin" ? "user" : "admin",
                                }),
                            },
                          ]}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
        </>
      )}

      {!loading && !loadError ? (
        <AdminPagination {...collection} count={collection.items.length} />
      ) : null}

      <Dialog
        open={creating}
        title="新建账号"
        eyebrow="用户账号"
        onClose={closeDialog}
        closeLabel="关闭新建账号窗口"
        closeDisabled={pending}
        initialFocusRef={emailRef}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={closeDialog}
              disabled={pending}
            >
              取消
            </Button>
            <Button
              type="submit"
              form="admin-user-create-form"
              loading={pending}
              disabled={!createUserReady(draft)}
            >
              <span className="admin-loading-icon-slot" aria-hidden="true">
                {pending ? <Spinner size={15} /> : null}
              </span>
              创建账号
            </Button>
          </>
        }
      >
        <form
          id="admin-user-create-form"
          className="admin-agent-editor-form"
          onSubmit={createUser}
        >
          <Field label="邮箱">
            <Input
              ref={emailRef}
              type="email"
              autoComplete="off"
              value={draft.email}
              maxLength={320}
              required
              disabled={pending}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  email: event.target.value,
                }))
              }
            />
          </Field>
          <Field
            label="密码"
            hint={`至少 ${PASSWORD_MIN_LENGTH} 个字符。`}
            error={passwordRequirementError(draft.password)}
          >
            <PasswordInput
              autoComplete="new-password"
              value={draft.password}
              minLength={PASSWORD_MIN_LENGTH}
              maxLength={200}
              required
              disabled={pending}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  password: event.target.value,
                }))
              }
            />
          </Field>
          <Field
            label="确认密码"
            error={passwordMatchError(draft.confirmPassword, draft.password)}
          >
            <PasswordInput
              autoComplete="new-password"
              value={draft.confirmPassword}
              minLength={PASSWORD_MIN_LENGTH}
              maxLength={200}
              required
              disabled={pending}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  confirmPassword: event.target.value,
                }))
              }
            />
          </Field>
          <Field
            label="角色"
            hint={
              draft.role === "admin"
                ? "管理员可访问全部管理功能；日常任务请使用个人用户账号。"
                : "个人用户可使用任务、文件、技能和个人记忆。"
            }
          >
            <Select
              value={draft.role}
              disabled={pending}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  role: event.target.value as AdminUserRole,
                }))
              }
            >
              <option value="user">个人用户</option>
              <option value="admin">管理员</option>
            </Select>
          </Field>
        </form>
        {feedback ? (
          <Alert className="admin-dialog-feedback" tone="danger">
            {feedback}
          </Alert>
        ) : null}
      </Dialog>

      <Dialog
        open={action !== null}
        title={actionCopy?.title ?? ""}
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
                action?.kind === "disable" || action?.kind === "role"
                  ? "danger"
                  : "primary"
              }
              onClick={() => void runAction()}
              loading={actionPending}
            >
              <span className="admin-loading-icon-slot" aria-hidden="true">
                {actionPending ? <Spinner size={15} /> : null}
              </span>
              {actionCopy?.confirm}
            </Button>
          </>
        }
      >
        {action && actionCopy ? (
          <>
            <p className="admin-dialog-copy">{actionCopy.body}</p>
            {actionFeedback ? (
              <Alert className="admin-dialog-feedback" tone="danger">
                {actionFeedback}
              </Alert>
            ) : null}
          </>
        ) : null}
      </Dialog>
    </div>
  );
}

function createUserReady(draft: CreateUserDraft): boolean {
  return (
    draft.email.trim().length > 0 &&
    draft.password.length >= PASSWORD_MIN_LENGTH &&
    draft.password === draft.confirmPassword
  );
}

function passwordRequirementError(value: string): string | undefined {
  if (value.length === 0) return undefined;
  return value.length < PASSWORD_MIN_LENGTH
    ? `密码长度不足，请至少输入 ${PASSWORD_MIN_LENGTH} 个字符。`
    : undefined;
}

function passwordMatchError(
  confirm: string,
  password: string,
): string | undefined {
  if (confirm.length === 0) return undefined;
  return confirm === password ? undefined : "两次输入的密码不一致。";
}

export function userAdminErrorMessage(
  error: unknown,
  fallback: string,
): string {
  if (error instanceof ApiClientError) {
    if (error.code === "USER_EMAIL_CONFLICT") {
      return "此邮箱已注册，请使用其他邮箱。";
    }
    if (error.code === "VALIDATION_FAILED") {
      return `请检查邮箱和密码（至少 ${PASSWORD_MIN_LENGTH} 个字符）。`;
    }
    if (error.retryable) {
      return "服务暂时不可用，请稍后重试。";
    }
  }
  return fallback;
}

function lifecycleErrorMessage(error: ApiClientError): string {
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

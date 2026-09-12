import { LogOut, Power, ShieldCheck, ShieldOff, UserRound } from "lucide-react";
import { type SyntheticEvent, useEffect, useRef, useState } from "react";
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
  Select,
  Spinner,
  type BadgeTone,
} from "../ui/index.js";
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
        title: "Disable account",
        body: `Disabling ${action.user.email} signs out all of its active sessions immediately. The account can no longer sign in until it is re-enabled. Its sessions, Agents, and artifacts are kept.`,
        confirm: "Disable account",
      };
    case "enable":
      return {
        title: "Enable account",
        body: `${action.user.email} will be able to sign in again with its existing password.`,
        confirm: "Enable account",
      };
    case "signout":
      return {
        title: "Force sign-out",
        body: `All active sessions for ${action.user.email} are revoked immediately. The account status is not changed.`,
        confirm: "Force sign-out",
      };
    case "role":
      return {
        title: "Change role",
        body:
          action.role === "admin"
            ? `${action.user.email} becomes an administrator with full console access. Its sessions are revoked so the new role applies immediately.`
            : `${action.user.email} loses administrator access and keeps regular user capabilities. Its sessions are revoked so the new role applies immediately.`,
        confirm:
          action.role === "admin"
            ? "Grant administrator"
            : "Revoke administrator",
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
  const [users, setUsers] = useState<AdminUserSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<
    "all" | "active" | "disabled"
  >("all");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<CreateUserDraft>(emptyUserDraft);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [action, setAction] = useState<LifecycleAction | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let active = true;
    const timer = setTimeout(
      () => {
        setLoading(true);
        setLoadError(false);
        apiClient
          .listAdminUsers({ limit: PAGE_SIZE, q: search || undefined })
          .then((page) => {
            if (!active) return;
            const filtered =
              statusFilter === "all"
                ? page.users
                : page.users.filter((user) => user.status === statusFilter);
            setUsers(filtered);
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
      },
      search ? 300 : 0,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [search, statusFilter, reloadKey, onAuthRequired]);

  function loadMore() {
    if (!nextCursor) return;
    apiClient
      .listAdminUsers({
        limit: PAGE_SIZE,
        q: search || undefined,
        cursor: nextCursor,
      })
      .then((page) => {
        const filtered =
          statusFilter === "all"
            ? page.users
            : page.users.filter((user) => user.status === statusFilter);
        setUsers((current) => [...current, ...filtered]);
        setNextCursor(page.nextCursor);
      })
      .catch((error: unknown) => {
        if (error instanceof ApiClientError && error.isAuthRequired) {
          onAuthRequired();
        }
      });
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
      setFeedback("The passwords do not match.");
      return;
    }
    setPending(true);
    setFeedback(null);
    try {
      await apiClient.createAdminUser({
        email: draft.email.trim().toLowerCase(),
        password: draft.password,
        role: draft.role,
      });
      setCreating(false);
      setDraft(emptyUserDraft);
      onUserMutated();
      const page = await apiClient.listAdminUsers({
        limit: PAGE_SIZE,
        q: search || undefined,
      });
      const filtered =
        statusFilter === "all"
          ? page.users
          : page.users.filter((user) => user.status === statusFilter);
      setUsers(filtered);
      setNextCursor(page.nextCursor);
    } catch (error) {
      if (error instanceof ApiClientError && error.isAuthRequired) {
        onAuthRequired();
        return;
      }
      setFeedback(
        userAdminErrorMessage(error, "The user could not be created."),
      );
    } finally {
      setPending(false);
    }
  }

  async function runAction() {
    if (!action || actionPending) return;
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
      setAction(null);
      onUserMutated();
      const page = await apiClient.listAdminUsers({
        limit: PAGE_SIZE,
        q: search || undefined,
      });
      const filtered =
        statusFilter === "all"
          ? page.users
          : page.users.filter((user) => user.status === statusFilter);
      setUsers(filtered);
      setNextCursor(page.nextCursor);
    } catch (error) {
      if (error instanceof ApiClientError && error.isAuthRequired) {
        onAuthRequired();
        return;
      }
      setActionFeedback(
        error instanceof ApiClientError
          ? lifecycleErrorMessage(error)
          : "The change could not be applied. Try again.",
      );
    } finally {
      setActionPending(false);
    }
  }

  const actionCopy = action ? lifecycleCopy(action) : null;

  return (
    <div className="page admin-page">
      <PageHeader
        eyebrow="Administration"
        title="Users"
        description="Create accounts, manage lifecycle and roles. Users sign in with the email and password set here."
        headingRef={headingRef}
        actions={
          <Button onClick={() => setCreating(true)}>
            <UserRound size={16} aria-hidden="true" />
            New user
          </Button>
        }
      />

      <div className="admin-toolbar">
        <Input
          type="search"
          className="admin-toolbar__search"
          aria-label="Search accounts by email"
          placeholder="Search by email…"
          value={search}
          maxLength={320}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Select
          aria-label="Filter accounts by status"
          className="admin-toolbar__filter"
          value={statusFilter}
          onChange={(event) =>
            setStatusFilter(event.target.value as typeof statusFilter)
          }
        >
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="disabled">Disabled</option>
        </Select>
      </div>

      {feedback && !creating && !action ? (
        <Alert className="admin-page-feedback" tone="danger">
          {feedback}
        </Alert>
      ) : null}

      {loading ? (
        <div className="admin-loading" aria-busy="true">
          <Spinner label="Loading accounts" />
        </div>
      ) : loadError ? (
        <EmptyState
          title="Accounts unavailable"
          description="Accounts could not be loaded."
          action={
            <Button
              variant="secondary"
              onClick={() => setReloadKey((key) => key + 1)}
            >
              Retry
            </Button>
          }
        />
      ) : users.length === 0 ? (
        <EmptyState
          title={search ? "No matching accounts" : "No users yet"}
          description={
            search
              ? "No account matches this email search."
              : "Create the first account to let someone sign in."
          }
        />
      ) : (
        <>
          <DataTable caption="User accounts" minWidth="wide">
            <thead>
              <tr>
                <th scope="col">User</th>
                <th scope="col">Role</th>
                <th scope="col">Status</th>
                <th scope="col">Default Agent</th>
                <th scope="col">Created</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => {
                const defaultAgent = agents.find(
                  (agent) => agent.id === user.defaultAgentId,
                );
                return (
                  <tr key={user.id}>
                    <th scope="row" data-label="User">
                      <div className="admin-user-cell">
                        <Link
                          className="admin-user-cell__link"
                          to={`/admin/users/${user.id}`}
                        >
                          {user.email}
                        </Link>
                        <Badge tone={user.hasPassword ? "neutral" : "warning"}>
                          {user.hasPassword ? "Password set" : "No password"}
                        </Badge>
                      </div>
                    </th>
                    <td data-label="Role">
                      <Badge tone={roleBadgeTone(user.role)}>
                        {user.role === "admin" ? "Administrator" : "User"}
                      </Badge>
                    </td>
                    <td data-label="Status">
                      <Badge tone={statusBadgeTone(user.status)}>
                        {user.status}
                      </Badge>
                    </td>
                    <td data-label="Default Agent">
                      <span className="admin-dimmed">
                        {defaultAgent ? defaultAgent.name : "—"}
                      </span>
                    </td>
                    <td data-label="Created">
                      <span className="admin-dimmed">
                        {formatDate(user.createdAt)}
                      </span>
                    </td>
                    <td data-label="Actions">
                      <div className="admin-row-actions">
                        <Button
                          size="compact"
                          variant="secondary"
                          aria-label={`View ${user.email}`}
                          onClick={() => navigate(`/admin/users/${user.id}`)}
                        >
                          View
                        </Button>
                        <Button
                          size="compact"
                          variant="secondary"
                          aria-label={`${user.status === "active" ? "Disable" : "Enable"} ${user.email}`}
                          onClick={() =>
                            setAction({
                              kind:
                                user.status === "active" ? "disable" : "enable",
                              user,
                            })
                          }
                        >
                          <Power size={14} aria-hidden="true" />
                          {user.status === "active" ? "Disable" : "Enable"}
                        </Button>
                        {user.status === "active" ? (
                          <Button
                            size="compact"
                            variant="secondary"
                            aria-label={`Force sign-out for ${user.email}`}
                            onClick={() => setAction({ kind: "signout", user })}
                          >
                            <LogOut size={14} aria-hidden="true" />
                            Force sign-out
                          </Button>
                        ) : null}
                        <Button
                          size="compact"
                          variant="secondary"
                          aria-label={`Change role for ${user.email}`}
                          onClick={() =>
                            setAction({
                              kind: "role",
                              user,
                              role: user.role === "admin" ? "user" : "admin",
                            })
                          }
                        >
                          {user.role === "admin" ? (
                            <ShieldOff size={14} aria-hidden="true" />
                          ) : (
                            <ShieldCheck size={14} aria-hidden="true" />
                          )}
                          {user.role === "admin"
                            ? "Revoke admin"
                            : "Make admin"}
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
          {nextCursor ? (
            <div className="admin-load-more">
              <Button variant="secondary" onClick={loadMore}>
                Load more
              </Button>
            </div>
          ) : (
            <p className="admin-table-end">End of accounts</p>
          )}
        </>
      )}

      <Dialog
        open={creating}
        title="New user"
        eyebrow="User account"
        onClose={closeDialog}
        closeLabel="Close new user dialog"
        closeDisabled={pending}
        initialFocusRef={emailRef}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={closeDialog}
              disabled={pending}
            >
              Cancel
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
              Create user
            </Button>
          </>
        }
      >
        <form
          id="admin-user-create-form"
          className="admin-agent-editor-form"
          onSubmit={createUser}
        >
          <Field label="Email">
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
            label="Password"
            hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
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
            label="Confirm password"
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
          <Field label="Role">
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
              <option value="user">User</option>
              <option value="admin">Administrator</option>
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
    ? `Password does not meet the requirements — use at least ${PASSWORD_MIN_LENGTH} characters.`
    : undefined;
}

function passwordMatchError(
  confirm: string,
  password: string,
): string | undefined {
  if (confirm.length === 0) return undefined;
  return confirm === password ? undefined : "The passwords do not match.";
}

export function userAdminErrorMessage(
  error: unknown,
  fallback: string,
): string {
  if (error instanceof ApiClientError) {
    if (error.code === "USER_EMAIL_CONFLICT") {
      return "A user with this email already exists.";
    }
    if (error.code === "VALIDATION_FAILED") {
      return `Check the email and password (at least ${PASSWORD_MIN_LENGTH} characters).`;
    }
    if (error.retryable) {
      return "The service is temporarily unavailable. Try again.";
    }
  }
  return fallback;
}

function lifecycleErrorMessage(error: ApiClientError): string {
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

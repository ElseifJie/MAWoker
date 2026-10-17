import {
  Bot,
  ChartNoAxesColumn,
  MailPlus,
  ScrollText,
  Settings,
  Users,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link, Navigate, Route, Routes } from "react-router-dom";
import {
  ApiClientError,
  apiClient,
  type AdminPlatformAgent,
  type CurrentUser,
} from "../api.js";
import { AppShell, Button } from "../ui/index.js";
import { AdminAuditPage } from "./AdminAuditPage.js";
import { AdminInvitesPage } from "./AdminInvitesPage.js";
import { AdminPlatformAgentsPage } from "./AdminPlatformAgentsPage.js";
import { AdminSettingsPage } from "./AdminSettingsPage.js";
import { AdminUserDetailPage } from "./AdminUserDetailPage.js";
import { AdminUsagePage } from "./AdminUsagePage.js";
import { AdminUsersPage } from "./AdminUsersPage.js";

interface AdminWorkspaceProps {
  user: CurrentUser;
  onSignedOut: () => void;
  onAuthRequired: () => void;
}

/** Mirrors the workspace footer: strip the "local:"/"managed:" namespace. */
function adminHandle(authSubject: string): string {
  const separator = authSubject.indexOf(":");
  return separator >= 0 ? authSubject.slice(separator + 1) : authSubject;
}

/**
 * The shell loads shared System Agents; every page owns its paginated fetching.
 */
export function AdminWorkspace({
  user,
  onSignedOut,
  onAuthRequired,
}: AdminWorkspaceProps) {
  const [agents, setAgents] = useState<AdminPlatformAgent[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setLoadError(false);
    setAgents(null);
    apiClient
      .listAdminPlatformAgents()
      .then((agentsResult) => {
        if (!active) return;
        setAgents(agentsResult.agents);
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof ApiClientError && error.isAuthRequired) {
          onAuthRequired();
        } else {
          setLoadError(true);
        }
      });
    return () => {
      active = false;
    };
  }, [onAuthRequired, reloadKey]);

  async function signOut() {
    try {
      await apiClient.logout();
    } finally {
      onSignedOut();
    }
  }

  return (
    <AppShell
      brand="管理工作台"
      navigationLabel="管理工作台"
      navigation={[
        { to: "/admin/users", label: "用户管理", icon: Users },
        { to: "/admin/invites", label: "邀请", icon: MailPlus },
        { to: "/admin/usage", label: "用量", icon: ChartNoAxesColumn },
        { to: "/admin/audit", label: "审计记录", icon: ScrollText },
        {
          to: "/admin/platform-agents",
          label: "助手管理",
          icon: Bot,
        },
        { to: "/admin/settings", label: "设置", icon: Settings },
      ]}
      openNavigationLabel="打开管理导航"
      closeNavigationLabel="关闭管理导航"
      backdropLabel="关闭管理导航"
      user={{ handle: adminHandle(user.authSubject) }}
      onSignOut={() => void signOut()}
    >
      <Routes>
        <Route
          path="/admin/users"
          element={
            <AdminUsersPage
              agents={agents ?? []}
              onAuthRequired={onAuthRequired}
              onUserMutated={() => setReloadKey((key) => key + 1)}
            />
          }
        />
        <Route
          path="/admin/users/:userId"
          element={
            <AdminUserDetailPage
              agents={agents ?? []}
              onAuthRequired={onAuthRequired}
            />
          }
        />
        <Route
          path="/admin/invites"
          element={<AdminInvitesPage onAuthRequired={onAuthRequired} />}
        />
        <Route
          path="/admin/usage"
          element={<AdminUsagePage onAuthRequired={onAuthRequired} />}
        />
        <Route
          path="/admin/audit"
          element={<AdminAuditPage onAuthRequired={onAuthRequired} />}
        />
        <Route
          path="/admin/platform-agents"
          element={
            <AdminPlatformAgentsPage
              agents={agents ?? []}
              onAuthRequired={onAuthRequired}
              loading={agents === null && !loadError}
              loadError={loadError}
              onRetry={() => setReloadKey((key) => key + 1)}
            />
          }
        />
        <Route
          path="/admin/platform-agents/new"
          element={<Navigate to="/admin/platform-agents" replace />}
        />
        <Route
          path="/admin/platform-agents/:agentId/edit"
          element={<Navigate to="/admin/platform-agents" replace />}
        />
        <Route
          path="/admin/settings"
          element={<AdminSettingsPage onAuthRequired={onAuthRequired} />}
        />
        <Route path="*" element={<Navigate to="/admin/users" replace />} />
      </Routes>
      <section
        className="admin-workspace-guide"
        aria-label="个人工作区使用指引"
      >
        <details>
          <summary>开始使用个人工作区</summary>
          <p>
            管理员账户用于配置。完成平台助手配置后，请创建个人使用账户并分配默认助手，
            再返回登录，以个人账户发起任务。
          </p>
          <p>
            <Link to="/admin/platform-agents">配置平台助手</Link>
            {" · "}
            <Link to="/admin/users">创建个人账户并分配默认助手</Link>
          </p>
          <Button variant="secondary" onClick={() => void signOut()}>
            返回登录
          </Button>
        </details>
      </section>
    </AppShell>
  );
}

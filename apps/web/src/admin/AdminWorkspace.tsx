import {
  Bot,
  ChartNoAxesColumn,
  ScrollText,
  Settings,
  Users,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import {
  ApiClientError,
  apiClient,
  type AdminPlatformAgent,
  type CurrentUser,
} from "../api.js";
import { AppShell, EmptyState, Spinner } from "../ui/index.js";
import { AdminAgentEditorPage } from "./AdminAgentEditorPage.js";
import { AdminAuditPage } from "./AdminAuditPage.js";
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
 * The shell loads only the slow-changing shared data (Platform Agents and the
 * model allowlist); every page owns its own paginated fetching.
 */
export function AdminWorkspace({
  user,
  onSignedOut,
  onAuthRequired,
}: AdminWorkspaceProps) {
  const [agents, setAgents] = useState<AdminPlatformAgent[] | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setLoadError(false);
    Promise.all([
      apiClient.listAdminPlatformAgents(),
      apiClient.getCapabilities(),
    ])
      .then(([agentsResult, capabilities]) => {
        if (!active) return;
        setAgents(agentsResult.agents);
        setModels(capabilities.personalAgentModels);
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

  if (loadError) {
    return (
      <main className="centered-page">
        <EmptyState
          title="Administration unavailable"
          description="Administrator data could not be loaded."
          action={
            <button
              type="button"
              className="ui-button ui-button--secondary ui-button--default"
              onClick={() => setReloadKey((key) => key + 1)}
            >
              Retry
            </button>
          }
        />
      </main>
    );
  }

  if (agents === null) {
    return (
      <main className="centered-page" aria-busy="true">
        <Spinner label="Loading administration" />
        <p>Loading administration…</p>
      </main>
    );
  }

  return (
    <AppShell
      brand="Administration"
      navigationLabel="Administration"
      navigation={[
        { to: "/admin/users", label: "Users", icon: Users },
        { to: "/admin/usage", label: "Usage", icon: ChartNoAxesColumn },
        { to: "/admin/audit", label: "Audit", icon: ScrollText },
        {
          to: "/admin/platform-agents",
          label: "Agents",
          icon: Bot,
        },
        { to: "/admin/settings", label: "Settings", icon: Settings },
      ]}
      openNavigationLabel="Open administration navigation"
      closeNavigationLabel="Close administration navigation"
      backdropLabel="Close administration navigation"
      user={{ handle: adminHandle(user.authSubject) }}
      onSignOut={() => void signOut()}
    >
      <Routes>
        <Route
          path="/admin/users"
          element={
            <AdminUsersPage
              agents={agents}
              onAuthRequired={onAuthRequired}
              onUserMutated={() => setReloadKey((key) => key + 1)}
            />
          }
        />
        <Route
          path="/admin/users/:userId"
          element={
            <AdminUserDetailPage
              agents={agents}
              onAuthRequired={onAuthRequired}
            />
          }
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
              agents={agents}
              onAgentsChanged={(updated) => setAgents(updated)}
              onAuthRequired={onAuthRequired}
            />
          }
        />
        <Route
          path="/admin/platform-agents/new"
          element={
            <AdminAgentEditorPage
              models={models}
              onAuthRequired={onAuthRequired}
              onAgentSaved={(agent) => {
                setAgents((current) =>
                  current?.some((item) => item.id === agent.id)
                    ? current.map((item) => (item.id === agent.id ? agent : item))
                    : [...(current ?? []), agent],
                );
              }}
            />
          }
        />
        <Route
          path="/admin/platform-agents/:agentId/edit"
          element={
            <AdminAgentEditorPage
              models={models}
              onAuthRequired={onAuthRequired}
              onAgentSaved={(agent) => {
                setAgents(
                  (current) =>
                    current?.map((item) => (item.id === agent.id ? agent : item)) ??
                    null,
                );
              }}
            />
          }
        />
        <Route
          path="/admin/settings"
          element={<AdminSettingsPage onAuthRequired={onAuthRequired} />}
        />
        <Route path="*" element={<Navigate to="/admin/users" replace />} />
      </Routes>
    </AppShell>
  );
}

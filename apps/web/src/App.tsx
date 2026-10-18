import { AccountDeletion } from "./AccountDeletion.js";
import { AccountExportButton } from "./AccountExportButton.js";
import { AccountSessions } from "./AccountSessions.js";
import { McpServers } from "./McpServers.js";
import { NotificationChannels } from "./NotificationChannels.js";
import { PrivacyConsents } from "./PrivacyConsents.js";
import { useAccountSync } from "./useAccountSync.js";
import { AutomationsPage } from "./AutomationsPage.js";
import { usePwaInstall } from "./usePwaInstall.js";
import { clearSubmissionDrafts } from "./submission-drafts.js";
import {
  Bot,
  Database,
  FolderOpen,
  History,
  KeyRound,
  Plus,
  Puzzle,
  Search,
  Server,
  Settings as SettingsIcon,
  CalendarClock,
  Shield,
} from "lucide-react";
import {
  Suspense,
  lazy,
  type ReactNode,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Navigate,
  Link,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import {
  ApiClientError,
  apiClient,
  type AgentList,
  type ClientCapabilities,
  type CurrentUser,
  type SessionSummary,
  type SyncChange,
  type UsageSummary,
} from "./api.js";
import { AgentEditorPage } from "./AgentEditorPage.js";
import { AgentPage } from "./AgentPage.js";
import { ArtifactPanel } from "./components/ArtifactPanel.js";
import { SessionIntro } from "./components/SessionIntro.js";
import { CommandPalette, type Command } from "./components/CommandPalette.js";
import { SessionList } from "./components/SessionList.js";
import { SessionSearch } from "./components/SessionSearch.js";
import { TaskNotifications } from "./components/TaskNotifications.js";
import { FilesPage } from "./FilesPage.js";
import { HistoryPage } from "./HistoryPage.js";
import { MemoryPage, clearMemoryCache } from "./MemoryPage.js";
import { SessionPage } from "./SessionPage.js";
import { SkillsPage } from "./SkillsPage.js";
import { WorkspaceFrame, useShellLayout } from "./shell/index.js";
import type { PanelDescriptor } from "./shell/index.js";
import { WorkspaceNav } from "./shell/WorkspaceNav.js";
import {
  isThemePreference,
  useThemePreference,
  type ThemeState,
} from "./theme.js";
import {
  Alert,
  Button,
  EmptyState,
  Field,
  Input,
  PageHeader,
  PasswordInput,
  Select,
  Spinner,
  type NavigationItem,
} from "./ui/index.js";

type AuthState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "unauthenticated" }
  | { status: "authenticated"; user: CurrentUser };

/**
 * How long a first message waits for the event stream to open before it is
 * reported as failed. Long enough to cover a slow reconnect, short enough that
 * the user is not left staring at "waiting" with no way to act.
 */

function isAuthError(error: unknown): boolean {
  return error instanceof ApiClientError && error.isAuthRequired;
}

/**
 * `authSubject` is namespaced ("local:user@example.com"); the part after the
 * colon is what identifies the person in the sidebar footer.
 */
function accountHandle(authSubject: string): string {
  const separator = authSubject.indexOf(":");
  return separator >= 0 ? authSubject.slice(separator + 1) : authSubject;
}

function LoadingScreen({ label = "加载工作区" }: { label?: string } = {}) {
  return (
    <main className="centered-page" aria-busy="true">
      <Spinner label={label} />
      <p>正在{label}...</p>
    </main>
  );
}

function BootstrapError({ onRetry }: { onRetry: () => void }) {
  return (
    <main className="centered-page">
      <h1>工作区暂不可用</h1>
      <Alert tone="danger">无法验证账号，请检查连接后重试。</Alert>
      <Button variant="secondary" onClick={onRetry}>
        重试
      </Button>
    </main>
  );
}

interface LoginProps {
  onAuthenticated: () => Promise<void>;
}

function loginErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.code === "RATE_LIMITED") {
      return "登录尝试过于频繁，请稍后重试。";
    }
    if (error.isAuthRequired) {
      return "邮箱或密码不正确。";
    }
    return "登录服务暂不可用，请稍后重试。";
  }
  return "无法连接工作区，请检查网络后重试。";
}

function Login({ onAuthenticated }: LoginProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await apiClient.login(email.trim().toLowerCase(), password);
      await onAuthenticated();
    } catch (signInError) {
      setError(loginErrorMessage(signInError));
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-panel" aria-labelledby="login-heading">
        <div className="brand-mark" aria-hidden="true">
          <Bot size={22} />
        </div>
        <p className="eyebrow">Work Agent</p>
        <h1 id="login-heading">登录你的工作区</h1>
        <p className="login-panel__lede">
          使用管理员为你创建的账户，继续任务与个人工作。
        </p>
        <form onSubmit={signIn}>
          <Field label="邮箱">
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              required
              disabled={pending}
            />
          </Field>
          <Field label="密码">
            <PasswordInput
              id="password"
              name="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="输入密码"
              required
              disabled={pending}
              aria-describedby={error ? "login-feedback" : undefined}
              aria-invalid={error ? true : undefined}
            />
          </Field>
          <Button type="submit" className="full-width" loading={pending}>
            {pending ? <Spinner size={17} aria-hidden="true" /> : null}
            登录
          </Button>
        </form>
        {error ? (
          <Alert id="login-feedback" className="login-feedback" tone="danger">
            {error}
          </Alert>
        ) : null}
      </section>
    </main>
  );
}

interface WorkspaceData {
  agents: AgentList;
  sessions: SessionSummary[];
  archivedSessions: SessionSummary[];
  capabilities: ClientCapabilities;
  usage: UsageSummary;
}

interface WorkspaceProps {
  user: CurrentUser;
  theme: ThemeState;
  onSignedOut: () => void;
  onAuthRequired: () => void;
}

interface ReservedNavigation {
  capability: "skills" | "mcpServers" | "vaults" | "memoryStores";
  to: string;
  label: string;
  icon: NavigationItem["icon"];
  hint: string;
}

const reservedNavigation: ReservedNavigation[] = [
  {
    capability: "memoryStores",
    to: "/context",
    label: "记忆",
    icon: Database,
    hint: "Memory stores are not available in this release.",
  },
  {
    capability: "skills",
    to: "/settings/skills",
    label: "技能",
    icon: Puzzle,
    hint: "Custom Skills are not available in this release.",
  },
  {
    capability: "mcpServers",
    to: "/settings/mcp",
    label: "MCP 服务",
    icon: Server,
    hint: "MCP server management is not available in this release.",
  },
  {
    capability: "vaults",
    to: "/settings/vault",
    label: "凭据",
    icon: KeyRound,
    hint: "Private credential storage is not available in this release.",
  },
];

function navigationFor(
  onSearch: () => void,
  isAdmin = false,
): NavigationItem[] {
  return [
    { to: "/", label: "新任务", icon: Plus },
    { to: "/history", label: "历史任务", icon: History },
    { to: "/files", label: "我的文件", icon: FolderOpen },
    { to: "/automations", label: "自动化", icon: CalendarClock },
    { to: "/search", label: "搜索", icon: Search, onSelect: onSearch },
    { to: "/settings", label: "设置", icon: SettingsIcon },
    ...(isAdmin
      ? [
          {
            to: "/admin",
            label: "管理后台",
            icon: Shield,
          } satisfies NavigationItem,
        ]
      : []),
  ];
}

function LegacyCapabilityRedirect() {
  const location = useLocation();
  const path = location.pathname.startsWith("/agents")
    ? `/settings${location.pathname}`
    : "/settings/skills";
  return <Navigate to={`${path}${location.search}${location.hash}`} replace />;
}

const ignoreStreamReady = () => {};

const AdminWorkspace = lazy(() =>
  import("./admin/AdminWorkspace.js").then((module) => ({
    default: module.AdminWorkspace,
  })),
);

function AdminRoute({
  user,
  onSignedOut,
  onAuthRequired,
}: {
  user: CurrentUser;
  onSignedOut: () => void;
  onAuthRequired: () => void;
}) {
  return (
    <Suspense fallback={<LoadingScreen label="加载管理工作台" />}>
      <AdminWorkspace
        user={user}
        onSignedOut={onSignedOut}
        onAuthRequired={onAuthRequired}
      />
    </Suspense>
  );
}

function Workspace({
  user,
  theme,
  onSignedOut,
  onAuthRequired,
}: WorkspaceProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const shell = useShellLayout();
  const currentSessionId = location.pathname.startsWith("/sessions/")
    ? decodeURIComponent(location.pathname.split("/")[2] ?? "")
    : null;
  const visiblePanels = shell.state.panels.filter(
    (panel) =>
      panel.type !== "artifact" ||
      !panel.conversationId ||
      panel.conversationId === currentSessionId,
  );
  const closeWorkspacePanel = useCallback(
    (panelId: string) => {
      const panel = shell.state.panels.find((item) => item.id === panelId);
      shell.closePanel(panelId);
      if (panel?.type !== "artifact" || !panel.resourceRef) return;
      const params = new URLSearchParams(location.search);
      if (params.get("artifact") !== panel.resourceRef) return;
      params.delete("artifact");
      navigate(
        { pathname: location.pathname, search: params.toString() },
        { replace: true },
      );
    },
    [
      location.pathname,
      location.search,
      navigate,
      shell.closePanel,
      shell.state.panels,
    ],
  );
  const renderWorkspacePanel = useCallback(
    (panel: PanelDescriptor) =>
      panel.type === "artifact" ? (
        <ArtifactPanel
          panel={panel}
          onClose={() => closeWorkspacePanel(panel.id)}
          onAuthRequired={onAuthRequired}
        />
      ) : null,
    [closeWorkspacePanel, onAuthRequired],
  );
  const closeOverlay = useCallback(() => {
    const activeId = shell.state.activePanelId;
    if (activeId) closeWorkspacePanel(activeId);
    else shell.setRightOpen(false);
  }, [closeWorkspacePanel, shell.setRightOpen, shell.state.activePanelId]);
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const mobile = shell.layout.mobile;
  const previousPathRef = useRef(location.pathname);
  const themeResolved = theme.resolved;
  const setThemePreference = theme.setPreference;

  useEffect(() => {
    if (previousPathRef.current === location.pathname) return;
    previousPathRef.current = location.pathname;
    if (!drawerOpen) return;
    setDrawerOpen(false);
    const focusMain = () =>
      document.querySelector<HTMLElement>(".ui-app-frame__center")?.focus();
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(focusMain);
    } else {
      focusMain();
    }
  }, [drawerOpen, location.pathname]);

  useEffect(() => {
    if (!mobile) setDrawerOpen(false);
  }, [mobile]);

  const commands = useMemo<Command[]>(() => {
    const next = themeResolved === "dark" ? "light" : "dark";
    const destinations: Command[] = [
      {
        id: "nav-new",
        label: "新任务",
        group: "前往",
        run: () => navigate("/"),
      },
      {
        id: "nav-history",
        label: "历史任务",
        group: "前往",
        run: () => navigate("/history"),
      },
      {
        id: "nav-files",
        label: "我的文件",
        group: "前往",
        run: () => navigate("/files"),
      },
      {
        id: "nav-settings",
        label: "设置",
        group: "前往",
        run: () => navigate("/settings"),
      },
      {
        id: "theme-toggle",
        label: next === "dark" ? "切换深色主题" : "切换浅色主题",
        group: "外观",
        run: () => setThemePreference(next),
      },
    ];
    if (!data) return destinations;
    const sessionCommands = (
      sessions: SessionSummary[],
      group: string,
      prefix: string,
    ): Command[] =>
      sessions.map((session) => ({
        id: `${prefix}-${session.id}`,
        label: session.title,
        group,
        run: () => navigate(`/sessions/${session.id}`),
      }));
    return [
      ...destinations,
      ...sessionCommands(data.sessions, "打开任务", "session"),
      ...sessionCommands(data.archivedSessions, "打开归档任务", "archived"),
    ];
  }, [data, navigate, setThemePreference, themeResolved]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    let active = true;
    setLoadError(null);
    Promise.all([
      apiClient.listAgents(),
      apiClient.listSessions(),
      apiClient.listSessions(true),
      apiClient.getCapabilities(),
      apiClient.getUsage(),
    ])
      .then(([agents, sessions, archivedSessions, capabilities, usage]) => {
        if (active) {
          setData({
            agents,
            sessions: sessions.sessions,
            archivedSessions: archivedSessions.sessions,
            capabilities,
            usage,
          });
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (isAuthError(error)) {
          onAuthRequired();
        } else {
          setLoadError("无法加载工作区数据，请重试。");
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
      clearSubmissionDrafts();
      onSignedOut();
    }
  }

  // Release-0 quota refresh (P0-04): refetch the usage snapshot when a task
  // ends or a session is created or removed, when the user returns to the home
  // page, and when the window regains focus. Requests are merged by epoch —
  // only the newest response may write state, so a stale reply can never
  // resurrect an exhausted-quota blocker.
  const usageRequestRef = useRef(0);
  const refreshUsage = useCallback(async () => {
    const requestEpoch = usageRequestRef.current + 1;
    usageRequestRef.current = requestEpoch;
    try {
      const usage = await apiClient.getUsage();
      if (usageRequestRef.current === requestEpoch) {
        setData((current) => (current ? { ...current, usage } : current));
      }
    } catch {
      // Keep the last snapshot; the next trigger retries.
    }
  }, []);

  const refreshSessions = useCallback(async () => {
    try {
      const [active, archived] = await Promise.all([
        apiClient.listSessions(),
        apiClient.listSessions(true),
      ]);
      setData((current) =>
        current
          ? {
              ...current,
              sessions: active.sessions,
              archivedSessions: archived.sessions,
            }
          : current,
      );
    } catch {
      // The next sync tick retries.
    }
  }, []);

  const syncRefreshRef = useRef<number | null>(null);
  const onSyncChanges = useCallback(
    (changes: SyncChange[]) => {
      if (!changes.some((change) => change.resourceType === "run")) return;
      if (syncRefreshRef.current !== null) {
        window.clearTimeout(syncRefreshRef.current);
      }
      syncRefreshRef.current = window.setTimeout(() => {
        syncRefreshRef.current = null;
        void refreshSessions();
      }, 600);
    },
    [refreshSessions],
  );
  useAccountSync({
    userId: user.userId,
    enabled: data !== null,
    onChange: onSyncChanges,
  });
  useEffect(
    () => () => {
      if (syncRefreshRef.current !== null) {
        window.clearTimeout(syncRefreshRef.current);
      }
    },
    [],
  );

  // Skip the home-page trigger on the initial mount: the workspace loader
  // already fetches usage as part of its first paint.
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    if (location.pathname === "/") void refreshUsage();
  }, [location.pathname, refreshUsage]);

  useEffect(() => {
    const onFocus = () => void refreshUsage();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshUsage]);

  const handleSessionCreated = useCallback(
    (session: SessionSummary) => {
      setData((current) =>
        current
          ? {
              ...current,
              sessions: [
                session,
                ...current.sessions.filter((item) => item.id !== session.id),
              ],
            }
          : current,
      );
      void refreshUsage();
      navigate(`/sessions/${session.id}`);
    },
    [navigate, refreshUsage],
  );

  // Session changes cover task ends (status transitions mirrored from the
  // stream) and accepted deletions. A delete must not free consumed quota
  // locally — this only refreshes the server's authoritative snapshot.
  const handleSessionChanged = useCallback(
    (session: SessionSummary) => {
      void refreshUsage();
      setData((current) => {
        if (!current) return current;
        const sessions = current.sessions.filter(
          (item) => item.id !== session.id,
        );
        const archivedSessions = current.archivedSessions.filter(
          (item) => item.id !== session.id,
        );
        if (session.deletionState === "deleted") {
          return { ...current, sessions, archivedSessions };
        }
        return session.archivedAt
          ? {
              ...current,
              sessions,
              archivedSessions: [session, ...archivedSessions],
            }
          : {
              ...current,
              sessions: [session, ...sessions],
              archivedSessions,
            };
      });
    },
    [refreshUsage],
  );

  if (loadError) {
    return (
      <main className="centered-page">
        <EmptyState
          title={loadError}
          action={
            <Button
              variant="secondary"
              onClick={() => setReloadKey((key) => key + 1)}
            >
              重试
            </Button>
          }
        />
      </main>
    );
  }

  if (!data) return <LoadingScreen />;

  return (
    <WorkspaceFrame
      shell={shell}
      leftLabel="工作区导航"
      left={
        <WorkspaceNav
          brand="Work Agent"
          navigationLabel="工作区"
          navigation={navigationFor(
            () => setSearchOpen((open) => !open),
            user.role === "admin",
          )}
          brandActions={
            <TaskNotifications
              sessions={[...data.sessions, ...data.archivedSessions]}
              onAuthRequired={onAuthRequired}
            />
          }
          navigationExtra={
            <SessionList
              sessions={data.sessions}
              archivedSessions={data.archivedSessions}
              onSessionChanged={handleSessionChanged}
              onAuthRequired={onAuthRequired}
            />
          }
          user={{ handle: accountHandle(user.authSubject) }}
          onSignOut={signOut}
          collapsed={
            shell.layout.leftMode === "collapsed" && !(mobile && drawerOpen)
          }
          {...(mobile ? { onOpenDrawer: () => setDrawerOpen(true) } : {})}
          {...(mobile && drawerOpen
            ? { onCloseDrawer: () => setDrawerOpen(false) }
            : {})}
        />
      }
      panels={visiblePanels}
      activePanelId={shell.state.activePanelId}
      onSelectPanel={shell.setActivePanel}
      onClosePanel={closeWorkspacePanel}
      onReorderPanels={shell.reorderPanels}
      rightVisible={shell.state.rightOpen && visiblePanels.length > 0}
      renderPanel={renderWorkspacePanel}
      drawerOpen={mobile && drawerOpen}
      drawerLabel="关闭导航"
      onCloseDrawer={() => setDrawerOpen(false)}
      onCloseOverlay={closeOverlay}
      overlayCloseLabel="关闭面板"
      onLeftWidthChange={shell.setLeftWidth}
      onRightWidthChange={shell.setRightWidth}
    >
      <div className="workspace-main">
        <Routes>
          <Route path="/agents/*" element={<LegacyCapabilityRedirect />} />
          <Route path="/skills" element={<LegacyCapabilityRedirect />} />
          <Route
            path="/history"
            element={
              <HistoryPage
                sessions={data.sessions}
                archivedSessions={data.archivedSessions}
              />
            }
          />
          <Route
            path="/context"
            element={
              data.capabilities.memoryStores.available ? (
                <MemoryPage
                  onAuthRequired={onAuthRequired}
                  account={user.authSubject}
                />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/context/store"
            element={
              data.capabilities.memoryStores.available ? (
                <MemoryPage
                  onAuthRequired={onAuthRequired}
                  account={user.authSubject}
                />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/"
            element={
              <>
                {!data.agents.selection ? (
                  <Alert tone="info">
                    <p>
                      还没有可用的默认助手。请先配置任务助手，再开始新任务。
                    </p>
                    <Link to="/settings/agents">配置任务助手</Link>
                  </Alert>
                ) : null}
                <SessionIntro
                  draftKey={`${user.userId}:new`}
                  agents={data.agents}
                  usage={data.usage}
                  onAuthRequired={onAuthRequired}
                  onSessionCreated={handleSessionCreated}
                />
              </>
            }
          />
          <Route
            path="/settings/agents"
            element={
              <AgentPage
                agents={data.agents}
                models={data.capabilities.personalAgentModels}
                onAgentsChanged={(agents) =>
                  setData((current) =>
                    current
                      ? {
                          ...current,
                          agents: { ...current.agents, agents },
                        }
                      : current,
                  )
                }
                onAuthRequired={onAuthRequired}
              />
            }
          />
          <Route
            path="/settings/agents/new"
            element={
              <AgentEditorPage
                models={data.capabilities.personalAgentModels}
                onAuthRequired={onAuthRequired}
                onAgentSaved={(agent) => {
                  setData((current) => {
                    if (!current) return current;
                    const exists = current.agents.agents.some(
                      (item) => item.id === agent.id,
                    );
                    return {
                      ...current,
                      agents: {
                        ...current.agents,
                        agents: exists
                          ? current.agents.agents.map((item) =>
                              item.id === agent.id ? agent : item,
                            )
                          : [...current.agents.agents, agent],
                      },
                    };
                  });
                }}
              />
            }
          />
          <Route
            path="/settings/agents/:agentId/edit"
            element={
              <AgentEditorPage
                models={data.capabilities.personalAgentModels}
                onAuthRequired={onAuthRequired}
                onAgentSaved={(agent) => {
                  setData((current) =>
                    current
                      ? {
                          ...current,
                          agents: {
                            ...current.agents,
                            agents: current.agents.agents.map((item) =>
                              item.id === agent.id ? agent : item,
                            ),
                          },
                        }
                      : current,
                  );
                }}
              />
            }
          />
          <Route
            path="/settings/skills"
            element={
              data.capabilities.skills.available ? (
                <SkillsPage onAuthRequired={onAuthRequired} />
              ) : (
                <Navigate to="/settings" replace />
              )
            }
          />
          <Route
            path="/automations"
            element={<AutomationsPage onAuthRequired={onAuthRequired} />}
          />
          <Route
            path="/files"
            element={
              <FilesPage
                sessions={[...data.sessions, ...data.archivedSessions]}
                onAuthRequired={onAuthRequired}
              />
            }
          />
          <Route
            path="/settings"
            element={
              <SettingsPage
                user={user}
                theme={theme}
                capabilities={data.capabilities}
                onAuthRequired={onAuthRequired}
              />
            }
          />
          <Route
            path="/sessions/:sessionId"
            element={
              <SessionPage
                userId={user.userId}
                onStreamReady={ignoreStreamReady}
                onSessionChanged={handleSessionChanged}
                onAuthRequired={onAuthRequired}
                onOpenArtifactPanel={shell.openPanel}
              />
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
      <CommandPalette
        open={paletteOpen}
        commands={commands}
        onClose={() => setPaletteOpen(false)}
      />
      <SessionSearch
        open={searchOpen}
        sessions={data.sessions}
        archivedSessions={data.archivedSessions}
        onClose={() => setSearchOpen(false)}
        onSelect={(session) => navigate(`/sessions/${session.id}`)}
      />
    </WorkspaceFrame>
  );
}

function PageFrame({
  children,
  title,
  description,
}: {
  children?: ReactNode;
  title: string;
  description?: string;
}) {
  return (
    <div className="page">
      <PageHeader title={title} {...(description ? { description } : {})} />
      {children}
    </div>
  );
}

function SettingsPage({
  user,
  theme,
  capabilities,
  onAuthRequired,
}: {
  user: CurrentUser;
  theme: ThemeState;
  capabilities: ClientCapabilities;
  onAuthRequired: () => void;
}) {
  const pwa = usePwaInstall();
  return (
    <PageFrame
      title="设置"
      description="管理账户与外观，按需调整助手、记忆和技能。"
    >
      <dl className="settings-list">
        <div>
          <dt>账号</dt>
          <dd>{accountHandle(user.authSubject)}</dd>
        </div>
      </dl>

      <section
        className="settings-section"
        aria-labelledby="connectors-heading"
      >
        <h2 id="connectors-heading">连接器</h2>
        <McpServers />
      </section>

      <section className="settings-section" aria-labelledby="privacy-heading">
        <h2 id="privacy-heading">隐私与数据</h2>
        <PrivacyConsents onAuthRequired={onAuthRequired} />
      </section>

      <section className="settings-section" aria-labelledby="delete-heading">
        <h2 id="delete-heading">注销账号</h2>
        <AccountDeletion />
      </section>

      <section className="settings-section" aria-labelledby="channels-heading">
        <h2 id="channels-heading">通知渠道</h2>
        <NotificationChannels />
      </section>

      <section className="settings-section" aria-labelledby="sessions-heading">
        <h2 id="sessions-heading">登录设备</h2>
        <AccountSessions />
      </section>

      <section className="settings-section" aria-labelledby="export-heading">
        <h2 id="export-heading">我的数据</h2>
        <AccountExportButton />
      </section>

      <section className="settings-section" aria-labelledby="install-heading">
        <h2 id="install-heading">安装应用</h2>
        {pwa.installed ? (
          <p className="muted">已安装到桌面，可从应用列表直接打开。</p>
        ) : pwa.canInstall ? (
          <Button onClick={() => void pwa.install()}>安装到桌面</Button>
        ) : (
          <p className="muted">
            在浏览器菜单中选择“安装应用”或“添加到主屏幕”，即可像本地应用一样打开。
          </p>
        )}
      </section>

      <section
        className="settings-section"
        aria-labelledby="appearance-heading"
      >
        <h2 id="appearance-heading">外观</h2>
        <dl className="settings-list">
          <div>
            <dt>
              <label htmlFor="appearance">主题</label>
            </dt>
            <dd>
              <Select
                id="appearance"
                value={theme.preference}
                onChange={(event) => {
                  const next = event.target.value;
                  if (isThemePreference(next)) theme.setPreference(next);
                }}
              >
                <option value="light">浅色</option>
                <option value="dark">深色</option>
                <option value="system">跟随系统</option>
              </Select>
            </dd>
          </div>
        </dl>
      </section>

      <section
        className="settings-section"
        aria-labelledby="capabilities-heading"
      >
        <h2 id="capabilities-heading">工作区能力</h2>
        <p className="muted">
          按需调整助手、记忆与技能，日常任务无需修改这些配置。
        </p>
        <dl className="settings-list">
          <div>
            <dt>
              <Link to="/settings/agents">助手配置</Link>
            </dt>
            <dd>选择和管理任务助手</dd>
          </div>
          {reservedNavigation
            .filter(
              ({ capability }) =>
                capabilities[capability].available &&
                (capability === "memoryStores" || capability === "skills"),
            )
            .map(({ capability, label, to }) => (
              <div key={capability}>
                <dt>
                  <Link to={to}>{label}</Link>
                </dt>
                <dd>可用</dd>
              </div>
            ))}
        </dl>
      </section>
    </PageFrame>
  );
}

export function App() {
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });
  const theme = useThemePreference();
  const location = useLocation();
  // Mirrors the signed-in subject so the leave-authentication callback stays
  // referentially stable without capturing stale auth state.
  const signedInSubjectRef = useRef<string | null>(null);
  signedInSubjectRef.current =
    auth.status === "authenticated" ? auth.user.authSubject : null;

  // Leaving the authenticated state — signing out or an auth-required error —
  // drops every cached artifact bound to that account, so the next login
  // starts from a clean slate even if a late response is still in flight.
  const leaveAuthenticatedState = useCallback(() => {
    clearSubmissionDrafts();
    const subject = signedInSubjectRef.current;
    if (subject) clearMemoryCache(subject);
    setAuth({ status: "unauthenticated" });
  }, []);

  const loadCurrentUser = useCallback(async () => {
    setAuth({ status: "loading" });
    try {
      const { user } = await apiClient.getMe();
      setAuth({ status: "authenticated", user });
    } catch (error) {
      if (isAuthError(error)) leaveAuthenticatedState();
      else setAuth({ status: "error" });
    }
  }, [leaveAuthenticatedState]);

  useEffect(() => {
    void loadCurrentUser();
  }, [loadCurrentUser]);

  if (auth.status === "loading") return <LoadingScreen />;
  if (auth.status === "error") {
    return <BootstrapError onRetry={() => void loadCurrentUser()} />;
  }
  if (auth.status === "unauthenticated") {
    return <Login onAuthenticated={loadCurrentUser} />;
  }
  if (auth.user.role === "admin") {
    const adminPath =
      location.pathname === "/admin" || location.pathname.startsWith("/admin/");
    if (adminPath) {
      return (
        <AdminRoute
          user={auth.user}
          onSignedOut={leaveAuthenticatedState}
          onAuthRequired={leaveAuthenticatedState}
        />
      );
    }
    return (
      <Workspace
        user={auth.user}
        theme={theme}
        onSignedOut={leaveAuthenticatedState}
        onAuthRequired={leaveAuthenticatedState}
      />
    );
  }
  if (
    location.pathname === "/admin" ||
    location.pathname.startsWith("/admin/")
  ) {
    return <Navigate to="/" replace />;
  }
  return (
    <Workspace
      user={auth.user}
      theme={theme}
      onSignedOut={leaveAuthenticatedState}
      onAuthRequired={leaveAuthenticatedState}
    />
  );
}

import {
  Bot,
  Database,
  FolderOpen,
  KeyRound,
  Plus,
  Puzzle,
  Search,
  Server,
  Settings as SettingsIcon,
} from "lucide-react";
import {
  type ReactNode,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router-dom";
import {
  ApiClientError,
  apiClient,
  type AgentList,
  type ClientCapabilities,
  type CurrentUser,
  type SessionSummary,
  type UsageSummary,
} from "./api.js";
import { AdminWorkspace } from "./AdminPage.js";
import { AgentPage } from "./AgentPage.js";
import { SessionIntro } from "./components/SessionIntro.js";
import type { FirstMessageDelivery } from "./components/SessionComposer.js";
import { CommandPalette, type Command } from "./components/CommandPalette.js";
import { SessionList } from "./components/SessionList.js";
import { FilesPage } from "./FilesPage.js";
import { SessionPage } from "./SessionPage.js";
import {
  isThemePreference,
  useThemePreference,
  type ThemeState,
} from "./theme.js";
import {
  Alert,
  AppShell,
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
export const FIRST_MESSAGE_STREAM_TIMEOUT_MS = 15_000;

function isAuthError(error: unknown): boolean {
  return error instanceof ApiClientError && error.isAuthRequired;
}

function LoadingScreen() {
  return (
    <main className="centered-page" aria-busy="true">
      <Spinner label="Loading workspace" />
      <p>Loading workspace…</p>
    </main>
  );
}

function BootstrapError({ onRetry }: { onRetry: () => void }) {
  return (
    <main className="centered-page">
      <h1>Workspace unavailable</h1>
      <Alert tone="danger">
        We could not verify your account. Check your connection and retry.
      </Alert>
      <Button variant="secondary" onClick={onRetry}>
        Retry
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
      return "Too many sign-in attempts. Wait a moment and try again.";
    }
    if (error.isAuthRequired) {
      return "Email or password is incorrect.";
    }
    return "Sign-in is temporarily unavailable. Try again in a moment.";
  }
  return "We could not reach the workspace. Check your connection and try again.";
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
        <p className="eyebrow">Personal Work Agent</p>
        <h1 id="login-heading">Sign in to your workspace</h1>
        <p className="login-panel__lede">
          Use the email and password your administrator set up for you.
        </p>
        <form onSubmit={signIn}>
          <Field label="Email">
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
          <Field label="Password">
            <PasswordInput
              id="password"
              name="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Enter your password"
              required
              disabled={pending}
              aria-describedby={error ? "login-feedback" : undefined}
              aria-invalid={error ? true : undefined}
            />
          </Field>
          <Button type="submit" className="full-width" loading={pending}>
            {pending ? <Spinner size={17} aria-hidden="true" /> : null}
            Sign in
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
    label: "Context",
    icon: Database,
    hint: "Memory stores are not available in this release.",
  },
  {
    capability: "skills",
    to: "/settings/skills",
    label: "Skills",
    icon: Puzzle,
    hint: "Custom Skills are not available in this release.",
  },
  {
    capability: "mcpServers",
    to: "/settings/mcp",
    label: "MCP servers",
    icon: Server,
    hint: "MCP server management is not available in this release.",
  },
  {
    capability: "vaults",
    to: "/settings/vault",
    label: "Vault",
    icon: KeyRound,
    hint: "Private credential storage is not available in this release.",
  },
];

/**
 * Navigation follows the server's capability report. A reserved entry becomes a
 * link only when the server says the feature exists, and that change must add
 * the matching route; until then every reserved entry is disabled, so nothing
 * can navigate to a route that is not there.
 */
function navigationFor(
  capabilities: ClientCapabilities,
  onSearch: () => void,
): NavigationItem[] {
  return [
    { to: "/", label: "New task", icon: Plus },
    { to: "/search", label: "Search", icon: Search, onSelect: onSearch },
    { to: "/agents", label: "Agents", icon: Bot },
    { to: "/files", label: "My files", icon: FolderOpen },
    ...reservedNavigation.map(
      ({ capability, hint, icon, label, to }): NavigationItem =>
        capabilities[capability].available
          ? { to, label, icon }
          : { to, label, icon, disabled: true, hint },
    ),
    { to: "/settings", label: "Settings", icon: SettingsIcon },
  ];
}

function Workspace({
  user,
  theme,
  onSignedOut,
  onAuthRequired,
}: WorkspaceProps) {
  const navigate = useNavigate();
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [firstMessages, setFirstMessages] = useState<
    Record<string, FirstMessageDelivery>
  >({});
  const waitingFirstMessages = useRef(new Map<string, string>());
  const firstMessageTimers = useRef(new Map<string, number>());
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const themeResolved = theme.resolved;
  const setThemePreference = theme.setPreference;

  const commands = useMemo<Command[]>(() => {
    const next = themeResolved === "dark" ? "light" : "dark";
    const destinations: Command[] = [
      {
        id: "nav-new",
        label: "New task",
        group: "Go to",
        run: () => navigate("/"),
      },
      {
        id: "nav-agents",
        label: "Agents",
        group: "Go to",
        run: () => navigate("/agents"),
      },
      {
        id: "nav-files",
        label: "My files",
        group: "Go to",
        run: () => navigate("/files"),
      },
      {
        id: "nav-settings",
        label: "Settings",
        group: "Go to",
        run: () => navigate("/settings"),
      },
      {
        id: "theme-toggle",
        label:
          next === "dark"
            ? "Switch to the dark theme"
            : "Switch to the light theme",
        group: "Appearance",
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
      ...sessionCommands(data.sessions, "Open task", "session"),
      ...sessionCommands(
        data.archivedSessions,
        "Open archived task",
        "archived",
      ),
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
          setLoadError("Workspace data could not be loaded.");
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

  const deliverFirstMessage = useCallback(
    async (sessionId: string, content: string) => {
      setFirstMessages((current) => ({
        ...current,
        [sessionId]: { sessionId, content, status: "sending" },
      }));
      try {
        await apiClient.sendMessage(sessionId, content);
        setFirstMessages((current) => ({
          ...current,
          [sessionId]: { sessionId, content, status: "sent" },
        }));
      } catch (error) {
        if (isAuthError(error)) {
          onAuthRequired();
          return;
        }
        setFirstMessages((current) => ({
          ...current,
          [sessionId]: { sessionId, content, status: "failed" },
        }));
      }
    },
    [onAuthRequired],
  );

  const handleSessionCreated = useCallback(
    (session: SessionSummary, content: string) => {
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
      setFirstMessages((current) => ({
        ...current,
        [session.id]: {
          sessionId: session.id,
          content,
          status: "waiting",
        },
      }));
      waitingFirstMessages.current.set(session.id, content);
      // Without this the message waits forever if the stream never opens, and
      // the retry affordance only appears once the delivery has failed.
      const timer = setTimeout(() => {
        firstMessageTimers.current.delete(session.id);
        if (!waitingFirstMessages.current.has(session.id)) return;
        waitingFirstMessages.current.delete(session.id);
        setFirstMessages((current) => {
          const existing = current[session.id];
          if (!existing || existing.status !== "waiting") return current;
          return {
            ...current,
            [session.id]: { ...existing, status: "failed" },
          };
        });
      }, FIRST_MESSAGE_STREAM_TIMEOUT_MS);
      firstMessageTimers.current.set(session.id, timer);
      navigate(`/sessions/${session.id}`);
    },
    [navigate],
  );

  const handleSessionReady = useCallback(
    (sessionId: string) => {
      const timer = firstMessageTimers.current.get(sessionId);
      if (timer !== undefined) {
        clearTimeout(timer);
        firstMessageTimers.current.delete(sessionId);
      }
      const content = waitingFirstMessages.current.get(sessionId);
      if (content === undefined) return;
      waitingFirstMessages.current.delete(sessionId);
      void deliverFirstMessage(sessionId, content);
    },
    [deliverFirstMessage],
  );

  useEffect(
    () => () => {
      for (const timer of firstMessageTimers.current.values()) {
        clearTimeout(timer);
      }
      firstMessageTimers.current.clear();
    },
    [],
  );

  const handleSessionChanged = useCallback((session: SessionSummary) => {
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
  }, []);

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
              Retry
            </Button>
          }
        />
      </main>
    );
  }

  if (!data) return <LoadingScreen />;

  return (
    <AppShell
      brand="Work Agent"
      navigationLabel="Workspace"
      navigation={navigationFor(data.capabilities, () =>
        setSearchOpen((open) => !open),
      )}
      navigationExtra={
        <SessionList
          sessions={data.sessions}
          archivedSessions={data.archivedSessions}
          searchOpen={searchOpen}
          onSessionChanged={handleSessionChanged}
          onAuthRequired={onAuthRequired}
        />
      }
      backdropLabel="Close navigation"
      onSignOut={signOut}
    >
      <Routes>
        <Route
          path="/"
          element={
            <SessionIntro
              agents={data.agents}
              usage={data.usage}
              onAuthRequired={onAuthRequired}
              onSessionCreated={handleSessionCreated}
            />
          }
        />
        <Route
          path="/agents"
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
            />
          }
        />
        <Route
          path="/sessions/:sessionId"
          element={
            <SessionPage
              deliveries={firstMessages}
              onRetryFirstMessage={(sessionId, content) =>
                void deliverFirstMessage(sessionId, content)
              }
              onStreamReady={handleSessionReady}
              onSessionChanged={handleSessionChanged}
              onAuthRequired={onAuthRequired}
            />
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <CommandPalette
        open={paletteOpen}
        commands={commands}
        onClose={() => setPaletteOpen(false)}
      />
    </AppShell>
  );
}

function PageFrame({
  children,
  title,
  description,
}: {
  children?: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="page">
      <PageHeader eyebrow="Workspace" title={title} description={description} />
      {children}
    </div>
  );
}

function SettingsPage({
  user,
  theme,
  capabilities,
}: {
  user: CurrentUser;
  theme: ThemeState;
  capabilities: ClientCapabilities;
}) {
  return (
    <PageFrame
      title="Settings"
      description="Account details, appearance, and workspace capabilities."
    >
      <dl className="settings-list">
        <div>
          <dt>Account</dt>
          <dd>{user.authSubject}</dd>
        </div>
      </dl>

      <section
        className="settings-section"
        aria-labelledby="appearance-heading"
      >
        <h2 id="appearance-heading">Appearance</h2>
        <Field
          label="Theme"
          hint="Applies immediately and is remembered on this device."
        >
          <Select
            id="appearance"
            value={theme.preference}
            onChange={(event) => {
              const next = event.target.value;
              if (isThemePreference(next)) theme.setPreference(next);
            }}
          >
            <option value="light">Light</option>
            <option value="dark">Dark</option>
            <option value="system">Match system</option>
          </Select>
        </Field>
      </section>

      <section
        className="settings-section"
        aria-labelledby="capabilities-heading"
      >
        <h2 id="capabilities-heading">Workspace capabilities</h2>
        <dl className="settings-list">
          {reservedNavigation.map(({ capability, label }) => (
            <div key={capability}>
              <dt>{label}</dt>
              <dd>
                {capabilities[capability].available
                  ? "Available"
                  : "Not available in this release"}
              </dd>
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

  const loadCurrentUser = useCallback(async () => {
    setAuth({ status: "loading" });
    try {
      const { user } = await apiClient.getMe();
      setAuth({ status: "authenticated", user });
    } catch (error) {
      setAuth(
        isAuthError(error)
          ? { status: "unauthenticated" }
          : { status: "error" },
      );
    }
  }, []);

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
    return (
      <AdminWorkspace
        onSignedOut={() => setAuth({ status: "unauthenticated" })}
        onAuthRequired={() => setAuth({ status: "unauthenticated" })}
      />
    );
  }
  return (
    <Workspace
      user={auth.user}
      theme={theme}
      onSignedOut={() => setAuth({ status: "unauthenticated" })}
      onAuthRequired={() => setAuth({ status: "unauthenticated" })}
    />
  );
}

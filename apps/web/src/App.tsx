import {
  Bot,
  Database,
  FileText,
  FolderOpen,
  Paperclip,
  Plus,
  RotateCcw,
  Send,
  Settings as SettingsIcon,
  X,
} from "lucide-react";
import {
  type ChangeEvent,
  type ReactNode,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Link,
  Navigate,
  NavLink,
  Route,
  Routes,
  useNavigate,
} from "react-router-dom";
import {
  ApiClientError,
  apiClient,
  type AgentList,
  type ClientCapabilities,
  type CurrentUser,
  type SessionStatus,
  type SessionSummary,
  type UploadedInput,
  type UsageSummary,
} from "./api.js";
import { AdminWorkspace } from "./AdminPage.js";
import { AgentPage } from "./AgentPage.js";
import { FilesPage } from "./FilesPage.js";
import { SessionPage } from "./SessionPage.js";
import {
  Alert,
  AppShell,
  Button,
  EmptyState,
  Field,
  IconButton,
  Input,
  PageHeader,
  Select,
  Spinner,
  Textarea,
} from "./ui/index.js";

type AuthState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "unauthenticated" }
  | { status: "authenticated"; user: CurrentUser };

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

function Login({ onAuthenticated }: LoginProps) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{
    text: string;
    tone: "success" | "danger";
  } | null>(null);
  const normalizedEmail = email.trim().toLowerCase();

  async function requestCode(
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    try {
      await apiClient.requestEmailCode(normalizedEmail);
      setEmail(normalizedEmail);
      setStep("code");
      setMessage({
        text: `We sent a code to ${normalizedEmail}.`,
        tone: "success",
      });
    } catch {
      setMessage({
        text: "We could not send a code. Check the email address and try again.",
        tone: "danger",
      });
    } finally {
      setPending(false);
    }
  }

  async function verifyCode(
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    try {
      await apiClient.verifyEmailCode(normalizedEmail, code.trim());
      await onAuthenticated();
    } catch (error) {
      setMessage({
        text: isAuthError(error)
          ? "The code is invalid or expired. Request a new code and try again."
          : "Sign-in is temporarily unavailable. Try again.",
        tone: "danger",
      });
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

        {step === "email" ? (
          <form onSubmit={requestCode}>
            <Field
              label="Email"
              hint="Use your work email. No password is required."
            >
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                required
                disabled={pending}
              />
            </Field>
            <Button type="submit" className="full-width" loading={pending}>
              {pending ? <Spinner size={17} aria-hidden="true" /> : null}
              Send code
            </Button>
          </form>
        ) : (
          <form onSubmit={verifyCode}>
            <Field label="Verification code">
              <Input
                id="verification-code"
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="Enter the code"
                required
                disabled={pending}
                aria-describedby={message ? "login-feedback" : undefined}
                aria-invalid={message?.tone === "danger" || undefined}
              />
            </Field>
            <Button type="submit" className="full-width" loading={pending}>
              {pending ? <Spinner size={17} aria-hidden="true" /> : null}
              Verify and sign in
            </Button>
            <Button
              variant="text"
              className="full-width"
              onClick={() => {
                setStep("email");
                setCode("");
                setMessage(null);
              }}
              disabled={pending}
            >
              Use a different email
            </Button>
          </form>
        )}
        {message ? (
          <Alert
            id="login-feedback"
            className="login-feedback"
            tone={message.tone}
          >
            {message.text}
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
  onSignedOut: () => void;
  onAuthRequired: () => void;
}

const navigationItems = [
  { to: "/", label: "New task", icon: Plus },
  { to: "/agents", label: "Agents", icon: Bot },
  { to: "/files", label: "My files", icon: FolderOpen },
  { to: "/context", label: "Context", icon: Database },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
];

const statusLabels: Record<SessionStatus, string> = {
  idle: "Idle",
  running: "Running",
  rescheduled: "Rescheduled",
  terminated: "Terminated",
};

function SessionNavigation({
  sessions,
  archivedSessions,
}: {
  sessions: SessionSummary[];
  archivedSessions: SessionSummary[];
}) {
  return (
    <>
      <section className="session-navigation" aria-label="Active Sessions">
        <div className="section-label">
          <span>Sessions</span>
          <span>{sessions.length}</span>
        </div>
        {sessions.length === 0 ? (
          <p className="empty-navigation">No active Sessions</p>
        ) : (
          sessions.map((session) => (
            <NavLink
              key={session.id}
              to={`/sessions/${session.id}`}
              className={({ isActive }) =>
                `session-link${isActive ? " active" : ""}`
              }
            >
              <span className="session-title">{session.title}</span>
              <span className={`status status-${session.status}`}>
                {statusLabels[session.status]}
              </span>
            </NavLink>
          ))
        )}
      </section>
      <section
        className="session-navigation archived-navigation"
        aria-label="Archived Sessions"
      >
        <div className="section-label">
          <span>Archived</span>
          <span>{archivedSessions.length}</span>
        </div>
        {archivedSessions.length === 0 ? (
          <p className="empty-navigation">No archived Sessions</p>
        ) : (
          archivedSessions.map((session) => (
            <NavLink
              key={session.id}
              to={`/sessions/${session.id}`}
              className={({ isActive }) =>
                `session-link${isActive ? " active" : ""}`
              }
            >
              <span className="session-title">{session.title}</span>
              <span className="status">Archived</span>
            </NavLink>
          ))
        )}
      </section>
    </>
  );
}

function Workspace({ user, onSignedOut, onAuthRequired }: WorkspaceProps) {
  const navigate = useNavigate();
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [firstMessages, setFirstMessages] = useState<
    Record<string, FirstMessageDelivery>
  >({});
  const waitingFirstMessages = useRef(new Map<string, string>());

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
      navigate(`/sessions/${session.id}`);
    },
    [navigate],
  );

  const handleSessionReady = useCallback(
    (sessionId: string) => {
      const content = waitingFirstMessages.current.get(sessionId);
      if (content === undefined) return;
      waitingFirstMessages.current.delete(sessionId);
      void deliverFirstMessage(sessionId, content);
    },
    [deliverFirstMessage],
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
      navigation={navigationItems}
      navigationExtra={
        <SessionNavigation
          sessions={data.sessions}
          archivedSessions={data.archivedSessions}
        />
      }
      backdropLabel="Close navigation"
      onSignOut={signOut}
    >
      <Routes>
        <Route
          path="/"
          element={
            <NewTask
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
          path="/context"
          element={
            <UnavailablePage
              title="Context"
              description="Context management is planned for a later release."
            />
          }
        />
        <Route path="/settings" element={<SettingsPage user={user} />} />
        <Route
          path="/settings/skills"
          element={
            <UnavailablePage
              title="Skills"
              description="Custom Skills are planned for a later release."
            />
          }
        />
        <Route
          path="/settings/mcp"
          element={
            <UnavailablePage
              title="MCP"
              description="MCP server management is planned for a later release."
            />
          }
        />
        <Route
          path="/settings/vault"
          element={
            <UnavailablePage
              title="Vault"
              description="Private credential management is planned for a later release."
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

function UnavailablePage({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <PageFrame title={title} description={description}>
      <Alert className="availability-note" tone="info">
        <div>
          <strong>Not available yet</strong>
          <p>{description}</p>
        </div>
      </Alert>
    </PageFrame>
  );
}

function SettingsPage({ user }: { user: CurrentUser }) {
  const capabilities = [
    { label: "Skills", to: "/settings/skills" },
    { label: "MCP servers", to: "/settings/mcp" },
    { label: "Vault", to: "/settings/vault" },
  ];
  return (
    <PageFrame
      title="Settings"
      description="Account details and workspace capabilities."
    >
      <dl className="settings-list">
        <div>
          <dt>Account</dt>
          <dd>{user.authSubject}</dd>
        </div>
        {capabilities.map((capability) => (
          <div key={capability.label}>
            <dt>
              <Link to={capability.to}>{capability.label}</Link>
            </dt>
            <dd>Not available yet</dd>
          </div>
        ))}
      </dl>
    </PageFrame>
  );
}

type FirstMessageDelivery = {
  sessionId: string;
  content: string;
  status: "waiting" | "sending" | "failed" | "sent";
};

type UploadState =
  | { key: number; file: File; status: "uploading" }
  | { key: number; file: File; status: "ready"; upload: UploadedInput }
  | { key: number; file: File; status: "failed" };

function quotaBlocker(usage: UsageSummary): string | null {
  if (usage.exhausted.monthlyTokens) {
    return "Monthly token quota is exhausted. Existing work remains available.";
  }
  if (usage.exhausted.dailySessions) {
    return "Daily Session quota is exhausted. Try again tomorrow.";
  }
  if (usage.exhausted.concurrentSessions) {
    return "Concurrent Session quota is exhausted. Wait for a running task to finish.";
  }
  return null;
}

function NewTask({
  agents,
  usage,
  onAuthRequired,
  onSessionCreated,
}: {
  agents: AgentList;
  usage: UsageSummary;
  onAuthRequired: () => void;
  onSessionCreated: (session: SessionSummary, content: string) => void;
}) {
  const nextUploadKey = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const [selectedAgentId, setSelectedAgentId] = useState(
    agents.selection?.agentId ?? "",
  );
  const [message, setMessage] = useState("");
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [submissionStatus, setSubmissionStatus] = useState<string>("");
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const agentBlocker = agents.blocker
    ? "No default Agent is available. Contact an administrator to continue."
    : null;
  const blocker = agentBlocker ?? quotaBlocker(usage);
  const hasUnreadyUploads = uploads.some((upload) => upload.status !== "ready");

  async function uploadFile(item: UploadState) {
    setUploads((current) =>
      current.map((upload) =>
        upload.key === item.key
          ? { key: item.key, file: item.file, status: "uploading" }
          : upload,
      ),
    );
    try {
      const uploaded = await apiClient.upload(item.file);
      setUploads((current) =>
        current.map((upload) =>
          upload.key === item.key
            ? {
                key: item.key,
                file: item.file,
                status: "ready",
                upload: uploaded,
              }
            : upload,
        ),
      );
    } catch (error) {
      if (isAuthError(error)) {
        onAuthRequired();
        return;
      }
      setUploads((current) =>
        current.map((upload) =>
          upload.key === item.key
            ? { key: item.key, file: item.file, status: "failed" }
            : upload,
        ),
      );
    }
  }

  function addFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    const remaining = Math.max(0, 20 - uploads.length);
    const items: UploadState[] = files.slice(0, remaining).map((file) => ({
      key: nextUploadKey.current++,
      file,
      status: "uploading",
    }));
    if (items.length > 0) {
      setUploads((current) => [...current, ...items]);
      for (const item of items) void uploadFile(item);
    }
    event.target.value = "";
  }

  async function submitTask(
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ) {
    event.preventDefault();
    const content = message.trim();
    if (
      submitting ||
      blocker ||
      hasUnreadyUploads ||
      !selectedAgentId ||
      !content
    ) {
      return;
    }

    setSubmitting(true);
    setSubmissionError(null);
    setSubmissionStatus("Creating Session…");
    try {
      const session = await apiClient.createSession({
        agentId: selectedAgentId,
        uploadIds: uploads.flatMap((upload) =>
          upload.status === "ready" ? [upload.upload.id] : [],
        ),
        title: content.slice(0, 120),
      });
      onSessionCreated(session, content);
    } catch (error) {
      if (isAuthError(error)) {
        onAuthRequired();
        return;
      }
      const quotaError =
        error instanceof ApiClientError &&
        (error.code === "QUOTA_EXCEEDED" ||
          error.code === "CONCURRENCY_LIMITED");
      setSubmissionError(
        quotaError
          ? "Task execution quota is exhausted. Existing work remains available."
          : "The task could not be started. Try again.",
      );
      setSubmissionStatus("");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <PageFrame
      title="New task"
      description="Start focused work with an available Agent."
    >
      <form className="composer" onSubmit={submitTask}>
        <div className="composer-toolbar">
          <Field label="Agent">
            <Select
              className="agent-picker"
              value={selectedAgentId}
              onChange={(event) => setSelectedAgentId(event.target.value)}
              disabled={submitting || agents.agents.length === 0}
            >
              {agents.agents.length === 0 ? (
                <option value="">No Agent available</option>
              ) : null}
              {agents.agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                  {agent.kind === "platform" ? " · Platform" : ""}
                </option>
              ))}
            </Select>
          </Field>
          <IconButton
            className="attachment-button"
            label="Attach files"
            size="small"
            onClick={() => fileInput.current?.click()}
            disabled={submitting || uploads.length >= 20}
          >
            <Paperclip size={18} aria-hidden="true" />
          </IconButton>
          <input
            ref={fileInput}
            className="file-input"
            type="file"
            multiple
            aria-label="File picker"
            onChange={addFiles}
            disabled={submitting || uploads.length >= 20}
            tabIndex={-1}
          />
        </div>

        {uploads.length > 0 ? (
          <ul className="upload-list" aria-label="Attachments">
            {uploads.map((upload) => (
              <li key={upload.key}>
                <FileText size={16} aria-hidden="true" />
                <span className="upload-name">{upload.file.name}</span>
                {upload.status === "uploading" ? (
                  <span className="upload-state">
                    <Spinner size={14} aria-hidden="true" />
                    Uploading
                  </span>
                ) : null}
                {upload.status === "ready" ? (
                  <span className="upload-state ready">Ready</span>
                ) : null}
                {upload.status === "failed" ? (
                  <>
                    <span className="upload-error">
                      {upload.file.name} could not be uploaded.
                    </span>
                    <Button
                      variant="text"
                      size="compact"
                      onClick={() => void uploadFile(upload)}
                    >
                      <RotateCcw size={14} aria-hidden="true" />
                      Retry upload
                    </Button>
                  </>
                ) : null}
                <IconButton
                  className="small-control"
                  label={`Remove ${upload.file.name}`}
                  size="small"
                  onClick={() =>
                    setUploads((current) =>
                      current.filter((item) => item.key !== upload.key),
                    )
                  }
                  disabled={submitting}
                >
                  <X size={15} aria-hidden="true" />
                </IconButton>
              </li>
            ))}
          </ul>
        ) : null}

        <Field label="Task message">
          <Textarea
            id="task-message"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Describe what you need done…"
            rows={6}
            disabled={submitting}
          />
        </Field>

        <div className="composer-footer">
          <div className="composer-feedback" aria-live="polite">
            {blocker ? (
              <Alert tone="danger">{blocker}</Alert>
            ) : submissionError ? (
              <Alert tone="danger">{submissionError}</Alert>
            ) : submissionStatus ? (
              <span>
                <Spinner size={15} aria-hidden="true" />
                {submissionStatus}
              </span>
            ) : (
              <span className="muted">
                Enter to add a line. Use Send to run.
              </span>
            )}
          </div>
          <IconButton
            type="submit"
            className="send-button"
            label="Send task"
            disabled={
              submitting ||
              Boolean(blocker) ||
              hasUnreadyUploads ||
              !selectedAgentId ||
              message.trim().length === 0
            }
          >
            <Send size={18} aria-hidden="true" />
          </IconButton>
        </div>
      </form>
    </PageFrame>
  );
}

export function App() {
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });

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
      onSignedOut={() => setAuth({ status: "unauthenticated" })}
      onAuthRequired={() => setAuth({ status: "unauthenticated" })}
    />
  );
}

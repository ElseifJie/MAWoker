import type { FeatureCapabilities } from "@pwa/contracts";

export type UserRole = "user" | "admin";
export type SessionStatus = "idle" | "running" | "rescheduled" | "terminated";

export interface CurrentUser {
  userId: string;
  authSubject: string;
  role: UserRole;
}

export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  modelId: string;
  version: string;
  status: "provisioning" | "active" | "disabled" | "failed" | "deleting";
  kind: "platform" | "personal";
  editable: boolean;
}

export interface AgentDetail extends AgentSummary {
  systemPrompt?: string;
  lastErrorCode?: string | null;
}

export interface AgentList {
  agents: AgentSummary[];
  selection: {
    agentId: string;
    source: "recent" | "default";
  } | null;
  blocker: {
    code: "NO_DEFAULT_AGENT";
    message: string;
  } | null;
}

export interface ClientCapabilities extends FeatureCapabilities {
  personalAgentModels: string[];
}

export interface SessionSummary {
  id: string;
  title: string;
  status: SessionStatus;
  error: { code: string; recoverable: boolean } | null;
  deletionState: "none" | "pending" | "deletion_failed" | "deleted";
  archivedAt: string | null;
  lastEventAt: string | null;
  createdAt: string;
  updatedAt: string;
  agent: {
    id: string;
    kind: "platform" | "personal";
    name: string;
    version: string;
  };
}

export interface SessionInput {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  mountPath: string;
}

export interface SessionDetail extends SessionSummary {
  inputs: SessionInput[];
}

export type { UiEvent, UiEventType } from "@pwa/contracts";

export interface ArtifactSummary {
  id: string;
  sessionId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  generatedAt: string;
  deletionState: "none" | "pending" | "deletion_failed";
  error: { code: string; retryable: boolean } | null;
}

export interface UsageSummary {
  period: { startsAt: string; endsAt: string };
  quota: {
    personalAgentLimit: number;
    concurrentSessionLimit: number;
    dailySessionLimit: number;
    monthlyTokenLimit: number;
  };
  usage: {
    personalAgents: number;
    concurrentSessions: number;
    dailySessions: number;
    inputTokens: number;
    outputTokens: number;
    tokens: number;
    runtimeMs: number;
    toolCalls: number;
  };
  exhausted: {
    personalAgents: boolean;
    concurrentSessions: boolean;
    dailySessions: boolean;
    monthlyTokens: boolean;
  };
}

export type AdminPlatformAgentStatus =
  "provisioning" | "active" | "disabled" | "failed" | "deleting";

export interface AdminPlatformAgent {
  id: string;
  name: string;
  description: string;
  modelId: string;
  systemPrompt: string;
  arkVersion: string;
  status: AdminPlatformAgentStatus;
  lastErrorCode: string | null;
}

export interface AdminQuota {
  personalAgentLimit: number;
  concurrentSessionLimit: number;
  dailySessionLimit: number;
  monthlyTokenLimit: number;
}

export type AdminUserRole = "user" | "admin";

export interface AdminUserSummary {
  id: string;
  email: string;
  role: AdminUserRole;
  status: "active" | "disabled";
  hasPassword: boolean;
  defaultAgentId: string | null;
  quota: AdminQuota;
}

export interface AdminUserCreated {
  id: string;
  email: string;
  role: AdminUserRole;
  status: "active" | "disabled";
}

export interface UploadedInput {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  mountPath: string;
  status: "uploaded";
  expiresAt: string;
}

interface ApiErrorBody {
  error?: {
    code?: unknown;
    message?: unknown;
    requestId?: unknown;
    retryable?: unknown;
  };
}

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ApiClientError";
  }

  get isAuthRequired() {
    return this.status === 401 || this.status === 403;
  }
}

async function readError(response: Response): Promise<ApiClientError> {
  let body: ApiErrorBody | undefined;
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    body = undefined;
  }
  const error = body?.error;
  return new ApiClientError(
    response.status,
    typeof error?.code === "string" ? error.code : "REQUEST_FAILED",
    typeof error?.message === "string" ? error.message : "Request failed",
    typeof error?.requestId === "string" ? error.requestId : undefined,
    error?.retryable === true,
  );
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (
    init.body !== undefined &&
    init.body !== null &&
    !(init.body instanceof FormData)
  ) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(`/api/v1${path}`, {
    ...init,
    credentials: "same-origin",
    headers,
  });
  if (!response.ok) throw await readError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const apiClient = {
  getMe: () => request<{ user: CurrentUser }>("/me"),
  login: (email: string, password: string) =>
    request<void>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  logout: () => request<void>("/auth/logout", { method: "POST" }),
  listAdminPlatformAgents: () =>
    request<{ agents: AdminPlatformAgent[] }>("/admin/platform-agents"),
  createAdminPlatformAgent: (input: {
    name: string;
    description: string;
    modelId: string;
    systemPrompt: string;
  }) =>
    request<AdminPlatformAgent>("/admin/platform-agents", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateAdminPlatformAgent: (
    id: string,
    input:
      | {
          name: string;
          description: string;
          modelId: string;
          systemPrompt: string;
          arkVersion: string;
        }
      | { status: "active" | "disabled" },
  ) =>
    request<AdminPlatformAgent>(
      `/admin/platform-agents/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: JSON.stringify(input),
      },
    ),
  deleteAdminPlatformAgent: (id: string) =>
    request<void>(`/admin/platform-agents/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  listAdminUsers: () => request<{ users: AdminUserSummary[] }>("/admin/users"),
  createAdminUser: (input: {
    email: string;
    password: string;
    role: AdminUserRole;
  }) =>
    request<AdminUserCreated>("/admin/users", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  resetAdminUserPassword: (userId: string, password: string) =>
    request<void>(`/admin/users/${encodeURIComponent(userId)}/password`, {
      method: "POST",
      body: JSON.stringify({ password }),
    }),
  assignAdminDefaultAgent: (userId: string, platformAgentId: string) =>
    request<{
      userId: string;
      platformAgentId: string;
      assignedAt: string;
    }>(`/admin/users/${encodeURIComponent(userId)}/default-agent`, {
      method: "PUT",
      body: JSON.stringify({ platformAgentId }),
    }),
  updateAdminUserQuota: (userId: string, quota: AdminQuota) =>
    request<AdminQuota & { userId: string }>(
      `/admin/users/${encodeURIComponent(userId)}/quota`,
      {
        method: "PUT",
        body: JSON.stringify(quota),
      },
    ),
  getCapabilities: () => request<ClientCapabilities>("/capabilities"),
  listAgents: () => request<AgentList>("/agents"),
  getAgent: (id: string) => request<AgentDetail>(`/agents/${id}`),
  createAgent: (input: {
    name: string;
    description: string;
    modelId: string;
    systemPrompt: string;
  }) =>
    request<AgentDetail>("/agents", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateAgent: (
    id: string,
    input: {
      name: string;
      description: string;
      modelId: string;
      systemPrompt: string;
      arkVersion: string;
    },
  ) =>
    request<AgentDetail>(`/agents/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deleteAgent: (id: string) =>
    request<void>(`/agents/${id}`, { method: "DELETE" }),
  listSessions: (archived = false) =>
    request<{ sessions: SessionSummary[] }>(
      `/sessions${archived ? "?archived=true" : ""}`,
    ),
  getSession: (id: string) => request<SessionDetail>(`/sessions/${id}`),
  getUsage: () => request<UsageSummary>("/usage"),
  upload: (file: File) => {
    const body = new FormData();
    body.set("file", file);
    return request<UploadedInput>("/uploads", {
      method: "POST",
      body,
    });
  },
  createSession: (input: {
    agentId: string;
    uploadIds: string[];
    title: string;
  }) =>
    request<SessionSummary>("/sessions", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  sendMessage: (sessionId: string, content: string) =>
    request<{ eventId: string; delivery: "accepted" | "queued" }>(
      `/sessions/${sessionId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ content }),
      },
    ),
  interruptSession: (sessionId: string) =>
    request<{ eventId: string; delivery: "accepted" }>(
      `/sessions/${sessionId}/interrupt`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
    ),
  archiveSession: (sessionId: string) =>
    request<SessionSummary>(`/sessions/${sessionId}/archive`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  restoreSession: (sessionId: string) =>
    request<SessionSummary>(`/sessions/${sessionId}/archive`, {
      method: "DELETE",
    }),
  deleteSession: (sessionId: string) =>
    request<{ id: string; deletionState: "pending" }>(
      `/sessions/${sessionId}`,
      {
        method: "DELETE",
        body: JSON.stringify({ confirmation: "DELETE" }),
      },
    ),
  syncArtifacts: (sessionId: string) =>
    request<{ artifacts: ArtifactSummary[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/artifacts/sync`,
      { method: "POST", body: JSON.stringify({}) },
    ),
  listArtifacts: (sessionId?: string) =>
    request<{ artifacts: ArtifactSummary[] }>(
      `/artifacts${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`,
    ),
  deleteArtifact: (id: string) =>
    request<{ id: string; deletionState: "pending" }>(`/artifacts/${id}`, {
      method: "DELETE",
    }),
};

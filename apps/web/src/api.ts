import type { FeatureCapabilities, UiEvent } from "@pwa/contracts";

export type UserRole = "user" | "admin";
export type SessionStatus = "idle" | "running" | "rescheduled" | "terminated";

export interface CurrentUser {
  userId: string;
  authSubject: string;
  role: UserRole;
}

export interface AgentSkillSummary {
  id: string;
  displayTitle: string;
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
  isAutoDefault: boolean;
  skills: AgentSkillSummary[];
}

export interface AgentDetail extends AgentSummary {
  systemPrompt?: string;
  lastErrorCode?: string | null;
}

export interface AgentList {
  agents: AgentSummary[];
  selection: {
    agentId: string;
    source: "personal_default" | "recent" | "default";
  } | null;
  blocker: {
    code: "NO_DEFAULT_AGENT";
    message: string;
  } | null;
}

export type SkillScope = "custom" | "preset";

export type SkillStatus = "provisioning" | "active" | "failed" | "deleting";

export interface SkillSummary {
  id: string;
  name: string;
  displayTitle: string;
  description: string;
  latestVersion: string;
  source: "custom" | "skill_hub";
  fileName: string;
  fileSize: number;
  status: SkillStatus;
  preset: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SkillMutationResult {
  defaultAgentSync: { synced: true } | { synced: false; errorCode: string };
}

export interface SkillList {
  skills: SkillSummary[];
  scope: SkillScope;
}

export interface AdminUserAgent {
  id: string;
  name: string;
  description: string;
  modelId: string;
  version: string;
  status: AdminPlatformAgentStatus;
  isAutoDefault: boolean;
  ownerUserId: string;
  ownerEmail: string;
  skills: AgentSkillSummary[];
  createdAt: string;
  updatedAt: string;
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
  pinnedAt: string | null;
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
  createdAt: string;
  quota: AdminQuota;
}

export interface AdminUserCreated {
  id: string;
  email: string;
  role: AdminUserRole;
  status: "active" | "disabled";
}

export interface AdminUserPage {
  users: AdminUserSummary[];
  nextCursor?: string | undefined;
}

export type AdminQuotaInheritance = Record<keyof AdminQuota, boolean>;

export interface AdminUserEffectiveQuota extends AdminQuota {
  userId: string;
  inherited: AdminQuotaInheritance;
}

export interface AdminAuditEntry {
  id: string;
  actorUserId: string | null;
  actorEmail: string | null;
  ownerUserId: string | null;
  ownerEmail: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  result: "succeeded" | "failed";
  errorCode: string | null;
  requestId: string;
  arkRequestId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface AdminAuditLogPage {
  entries: AdminAuditEntry[];
  nextCursor?: string | undefined;
}

export interface AdminAuditLogQuery {
  since?: string | undefined;
  until?: string | undefined;
  actorId?: string | undefined;
  action?: string | undefined;
  resourceType?: string | undefined;
  resourceId?: string | undefined;
  result?: "succeeded" | "failed" | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export type AdminDimensionStatus = "ok" | "near" | "exhausted";

export interface AdminUsageTotals {
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  activeUsers: number;
  sessions: number;
  exhaustedUsers: number;
}

export interface AdminUsageUserRow {
  userId: string;
  email: string;
  role: AdminUserRole;
  status: "active" | "disabled";
  quota: AdminQuota;
  usage: {
    personalAgents: number;
    concurrentSessions: number;
    dailySessions: number;
    inputTokens: number;
    outputTokens: number;
    tokens: number;
    toolCalls: number;
  };
  dimensionStatus: {
    personalAgents: AdminDimensionStatus;
    concurrentSessions: AdminDimensionStatus;
    dailySessions: AdminDimensionStatus;
    monthlyTokens: AdminDimensionStatus;
  };
}

export interface AdminUsageOverview {
  period: { startsAt: string; endsAt: string };
  totals: AdminUsageTotals;
  users: AdminUsageUserRow[];
  nextCursor?: string | undefined;
}

export interface AdminPlatformAgentUsage {
  platformAgentId: string;
  name: string;
  status: string;
  defaultAssignments: number;
  inputTokens: number;
  outputTokens: number;
  tokens: number;
}

export interface AdminUsageByAgents {
  platform: AdminPlatformAgentUsage[];
  personal: { personalAgents: number; tokens: number };
}

export interface AdminQuotaPolicy extends AdminQuota {
  updatedBy: string | null;
  updatedAt: string;
}

export interface AdminUserDetail extends AdminUserSummary {
  updatedAt: string;
  inherited: AdminQuotaInheritance;
  usage: UsageSummary["usage"];
  exhausted: UsageSummary["exhausted"];
  period: UsageSummary["period"];
}

export interface AdminUserSession {
  id: string;
  title: string;
  status: SessionStatus;
  agentKind: "platform" | "personal";
  agentName: string;
  agentVersion: string;
  createdAt: string;
  lastEventAt: string | null;
  archivedAt: string | null;
  deletionState: "none" | "pending" | "deletion_failed" | "deleted";
  tokens: number;
}

export interface AdminUserSessionPage {
  sessions: AdminUserSession[];
  nextCursor?: string | undefined;
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
  listAdminUsers: (
    params: {
      cursor?: string | undefined;
      limit?: number | undefined;
      q?: string | undefined;
    } = {},
  ) => {
    const search = new URLSearchParams();
    if (params.cursor) search.set("cursor", params.cursor);
    if (params.limit) search.set("limit", String(params.limit));
    if (params.q) search.set("q", params.q);
    const query = search.toString();
    return request<AdminUserPage>(`/admin/users${query ? `?${query}` : ""}`);
  },
  setAdminUserStatus: (userId: string, status: "active" | "disabled") =>
    request<{ status: "active" | "disabled"; revokedSessions: number }>(
      `/admin/users/${encodeURIComponent(userId)}/status`,
      { method: "PATCH", body: JSON.stringify({ status }) },
    ),
  setAdminUserRole: (userId: string, role: AdminUserRole) =>
    request<{ role: AdminUserRole; revokedSessions: number }>(
      `/admin/users/${encodeURIComponent(userId)}/role`,
      { method: "PATCH", body: JSON.stringify({ role }) },
    ),
  revokeAdminUserSessions: (userId: string) =>
    request<{ revokedSessions: number }>(
      `/admin/users/${encodeURIComponent(userId)}/sessions/revoke`,
      { method: "POST", body: JSON.stringify({}) },
    ),
  getAdminUser: (userId: string) =>
    request<AdminUserDetail>(`/admin/users/${encodeURIComponent(userId)}`),
  listAdminUserSessions: (
    userId: string,
    params: { cursor?: string | undefined; limit?: number | undefined } = {},
  ) => {
    const search = new URLSearchParams();
    if (params.cursor) search.set("cursor", params.cursor);
    if (params.limit) search.set("limit", String(params.limit));
    const query = search.toString();
    return request<AdminUserSessionPage>(
      `/admin/users/${encodeURIComponent(userId)}/sessions${query ? `?${query}` : ""}`,
    );
  },
  listAdminUserAudit: (
    userId: string,
    params: { cursor?: string | undefined; limit?: number | undefined } = {},
  ) => {
    const search = new URLSearchParams();
    if (params.cursor) search.set("cursor", params.cursor);
    if (params.limit) search.set("limit", String(params.limit));
    const query = search.toString();
    return request<AdminAuditLogPage>(
      `/admin/users/${encodeURIComponent(userId)}/audit${query ? `?${query}` : ""}`,
    );
  },
  listAdminAuditLogs: (query: AdminAuditLogQuery = {}) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") search.set(key, String(value));
    }
    const qs = search.toString();
    return request<AdminAuditLogPage>(`/admin/audit-logs${qs ? `?${qs}` : ""}`);
  },
  getAdminUsageOverview: (
    params: { cursor?: string | undefined; limit?: number | undefined } = {},
  ) => {
    const search = new URLSearchParams();
    if (params.cursor) search.set("cursor", params.cursor);
    if (params.limit) search.set("limit", String(params.limit));
    const query = search.toString();
    return request<AdminUsageOverview>(
      `/admin/usage/overview${query ? `?${query}` : ""}`,
    );
  },
  getAdminUsageByAgents: () =>
    request<AdminUsageByAgents>("/admin/usage/agents"),
  getAdminQuotaPolicy: () => request<AdminQuotaPolicy>("/admin/quota-policy"),
  updateAdminQuotaPolicy: (quota: AdminQuota) =>
    request<AdminQuotaPolicy>("/admin/quota-policy", {
      method: "PUT",
      body: JSON.stringify(quota),
    }),
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
  updateAdminUserQuota: (
    userId: string,
    quota: Partial<Record<keyof AdminQuota, number | null>>,
  ) =>
    request<AdminUserEffectiveQuota>(
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
    skillIds?: string[];
  }) =>
    request<AgentDetail>("/agents", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateAgent: (
    id: string,
    input: {
      name?: string;
      description?: string;
      modelId?: string;
      systemPrompt?: string;
      skillIds?: string[];
      arkVersion: string;
    },
  ) =>
    request<AgentDetail>(`/agents/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deleteAgent: (id: string) =>
    request<void>(`/agents/${id}`, { method: "DELETE" }),
  listSkills: (scope: SkillScope = "custom") =>
    request<SkillList>(`/skills?scope=${scope}`),
  uploadSkill: (input: {
    file: File;
    displayTitle?: string;
    description?: string;
  }) => {
    const body = new FormData();
    body.set("file", input.file);
    if (input.displayTitle) body.set("displayTitle", input.displayTitle);
    if (input.description) body.set("description", input.description);
    return request<SkillSummary & SkillMutationResult>("/skills", {
      method: "POST",
      body,
    });
  },
  updateSkill: (
    id: string,
    input: {
      file?: File;
      displayTitle?: string;
      description?: string;
    },
  ) => {
    const body = new FormData();
    if (input.file) body.set("file", input.file);
    if (input.displayTitle) body.set("displayTitle", input.displayTitle);
    if (input.description) body.set("description", input.description);
    return request<SkillSummary & SkillMutationResult>(
      `/skills/${encodeURIComponent(id)}`,
      { method: "PATCH", body },
    );
  },
  deleteSkill: (id: string) =>
    request<SkillMutationResult>(`/skills/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  listAdminUserAgents: () =>
    request<{ agents: AdminUserAgent[] }>("/admin/user-agents"),
  listSessions: (archived = false) =>
    request<{ sessions: SessionSummary[] }>(
      `/sessions${archived ? "?archived=true" : ""}`,
    ),
  getSession: (id: string) => request<SessionDetail>(`/sessions/${id}`),
  renameSession: (id: string, title: string) =>
    request<SessionSummary>(`/sessions/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),
  pinSession: (id: string) =>
    request<SessionSummary>(`/sessions/${id}/pin`, {
      method: "PUT",
      body: JSON.stringify({}),
    }),
  unpinSession: (id: string) =>
    request<SessionSummary>(`/sessions/${id}/pin`, { method: "DELETE" }),
  getSessionTranscript: (id: string) =>
    request<{ events: UiEvent[] }>(
      `/sessions/${encodeURIComponent(id)}/transcript`,
    ),
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

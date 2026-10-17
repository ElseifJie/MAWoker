import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import staticFiles from "@fastify/static";
import {
  registerSessionDeliveryRoutes,
  type DeliveryApiRepository,
} from "./session-delivery-routes.js";
import { AuthRequiredError, type AuthContext } from "@pwa/auth";
import {
  AgentConflictError,
  AgentReferencedError,
  type ArtifactRecord,
  InvalidModelError,
  InvalidSkillPackageError,
  InvalidUploadNameError,
  InvalidUserInputError,
  LastActiveAdminError,
  PersonalAgentQuotaExceededError,
  ResourceNotFoundError,
  SelfTargetForbiddenError,
  SessionTerminatedError,
  SessionHistoryRepairPendingError,
  SkillNotSelectableError,
  UserEmailConflictError,
  type AdminPermission,
  type AdminUserAgentRecord,
  type AdminUserCreated,
  type AdminUserLifecycleResult,
  type AgentSkillBinding,
  type AuditLogCursor,
  type AuditLogEntry,
  type AuditLogQuery,
  type AvailableAgentRecord,
  type AssistantView,
  type InviteCodeRecord,
  type AutomationRecord,
  type DefaultAgentRecord,
  type PersonalAgentRecord,
  type PlatformAgentRecord,
  type RunRecord,
  type SessionRecord,
  type SessionHistoryState,
  type SessionInputRecord,
  type SkillRecord,
  type SkillScope,
  type QuotaUsageSummary,
  type MemoryService,
  type MemoryState,
  type TenantAuthorizationService,
  type TenantResource,
  type TenantResourceKind,
  hashMemory,
  roleHasPermission,
} from "@pwa/domain";
import {
  capabilities as featureCapabilities,
  projectUiEvent,
  type ErrorCode,
  type UiEvent,
} from "@pwa/contracts";
import Fastify, {
  LogController,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import type { ServerResponse } from "node:http";
import { extname } from "node:path";
import type { Readable } from "node:stream";

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
    tenantResource?: TenantResource;
    arkRequestId?: string;
  }
}

export const AUTH_COOKIE_NAME = "pwa_session";

export interface ApiAuthService {
  login(
    email: string,
    password: string,
  ): Promise<{ token: string; expiresAt: Date }>;
  authenticate(token?: string): Promise<AuthContext>;
  renew(token: string): Promise<{ expiresAt: Date }>;
  logout(token?: string): Promise<void>;
}

export interface AdminService {
  listPlatformAgents(): PromiseLike<PlatformAgentRecord[]>;
  listUserAgents(): PromiseLike<AdminUserAgentRecord[]>;
  createPlatformAgent(
    input: {
      name: string;
      description: string;
      modelId: string;
      systemPrompt: string;
    },
    context: { adminId: string; requestId: string },
  ): PromiseLike<PlatformAgentRecord>;
  updatePlatformAgent(
    id: string,
    input: {
      name?: string;
      description?: string;
      modelId?: string;
      systemPrompt?: string;
      arkVersion?: string;
      status?: "active" | "disabled";
    },
    context: { adminId: string; requestId: string },
  ): PromiseLike<PlatformAgentRecord>;
  deletePlatformAgent(
    id: string,
    context: { adminId: string; requestId: string },
  ): PromiseLike<void>;
  listUsers(query: {
    limit: number;
    search: string | null;
    before: { createdAt: string; id: string } | null;
  }): PromiseLike<{
    users: Array<{
      id: string;
      email: string;
      role: "user" | "admin";
      status: "active" | "disabled";
      hasPassword: boolean;
      defaultAgentId: string | null;
      createdAt: Date;
      quota: {
        personalAgentLimit: number;
        concurrentSessionLimit: number;
        dailySessionLimit: number;
        monthlyTokenLimit: number;
      };
    }>;
    nextCursor: { createdAt: string; id: string } | null;
  }>;
  createUser(
    input: { email: string; password: string; role?: "user" | "admin" },
    context: { adminId: string; requestId: string },
  ): PromiseLike<AdminUserCreated>;
  resetUserPassword(
    userId: string,
    password: string,
    context: { adminId: string; requestId: string },
  ): PromiseLike<void>;
  setUserStatus(
    userId: string,
    status: "active" | "disabled",
    context: { adminId: string; requestId: string },
  ): PromiseLike<AdminUserLifecycleResult>;
  setUserRole(
    userId: string,
    role: "user" | "admin",
    context: { adminId: string; requestId: string },
  ): PromiseLike<AdminUserLifecycleResult>;
  revokeUserSessions(
    userId: string,
    context: { adminId: string; requestId: string },
  ): PromiseLike<{ revokedSessions: number }>;
  assignDefaultAgent(
    userId: string,
    platformAgentId: string,
    context: { adminId: string; requestId: string },
  ): PromiseLike<DefaultAgentRecord>;
  updateUserQuota(
    userId: string,
    quota: {
      personalAgentLimit?: number | null;
      concurrentSessionLimit?: number | null;
      dailySessionLimit?: number | null;
      monthlyTokenLimit?: number | null;
    },
    context: { adminId: string; requestId: string },
  ): PromiseLike<{
    userId: string;
    personalAgentLimit: number;
    concurrentSessionLimit: number;
    dailySessionLimit: number;
    monthlyTokenLimit: number;
    inherited: {
      personalAgentLimit: boolean;
      concurrentSessionLimit: boolean;
      dailySessionLimit: boolean;
      monthlyTokenLimit: boolean;
    };
  }>;
}

export interface AdminUsageApiService {
  overview(input: {
    limit: number;
    before: { tokens: number; userId: string } | null;
  }): PromiseLike<{
    period: { startsAt: Date; endsAt: Date };
    totals: {
      inputTokens: number;
      outputTokens: number;
      tokens: number;
      activeUsers: number;
      sessions: number;
      exhaustedUsers: number;
    };
    users: Array<{
      userId: string;
      email: string;
      role: "user" | "admin";
      status: "active" | "disabled";
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
        toolCalls: number;
      };
      dimensionStatus: {
        personalAgents: "ok" | "near" | "exhausted";
        concurrentSessions: "ok" | "near" | "exhausted";
        dailySessions: "ok" | "near" | "exhausted";
        monthlyTokens: "ok" | "near" | "exhausted";
      };
    }>;
    nextCursor: { tokens: number; userId: string } | null;
  }>;
  byAgents(): PromiseLike<{
    platform: Array<{
      platformAgentId: string;
      name: string;
      status: string;
      defaultAssignments: number;
      inputTokens: number;
      outputTokens: number;
      tokens: number;
    }>;
    personal: { personalAgents: number; tokens: number };
  }>;
}

export interface AdminUserDetailApiService {
  getDetail(
    userId: string,
    context: { adminId: string; requestId: string },
  ): PromiseLike<{
    id: string;
    email: string;
    role: "user" | "admin";
    status: "active" | "disabled";
    hasPassword: boolean;
    defaultAgentId: string | null;
    createdAt: Date;
    updatedAt: Date;
    quota: {
      personalAgentLimit: number;
      concurrentSessionLimit: number;
      dailySessionLimit: number;
      monthlyTokenLimit: number;
    };
    inherited: {
      personalAgentLimit: boolean;
      concurrentSessionLimit: boolean;
      dailySessionLimit: boolean;
      monthlyTokenLimit: boolean;
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
    period: { startsAt: Date; endsAt: Date };
  }>;
  listSessions(
    userId: string,
    input: { limit: number; before: { createdAt: string; id: string } | null },
  ): PromiseLike<{
    sessions: Array<{
      id: string;
      title: string;
      status: "idle" | "running" | "rescheduled" | "terminated";
      agentKind: "platform" | "personal";
      agentName: string;
      agentVersion: string;
      createdAt: Date;
      lastEventAt: Date | null;
      archivedAt: Date | null;
      deletionState: "none" | "pending" | "deletion_failed" | "deleted";
      tokens: number;
    }>;
    nextCursor: { createdAt: string; id: string } | null;
  }>;
}

export interface QuotaPolicyApiService {
  getDefault(): PromiseLike<
    | {
        personalAgentLimit: number;
        concurrentSessionLimit: number;
        dailySessionLimit: number;
        monthlyTokenLimit: number;
        mode: "enforced" | "unlimited";
        version: number;
        updatedBy: string | null;
        updatedAt: Date;
      }
    | undefined
  >;
  updateDefault(
    quota: {
      personalAgentLimit: number;
      concurrentSessionLimit: number;
      dailySessionLimit: number;
      monthlyTokenLimit: number;
      mode?: "enforced" | "unlimited";
    },
    context: { adminId: string; requestId: string },
  ): PromiseLike<{
    updated: {
      personalAgentLimit: number;
      concurrentSessionLimit: number;
      dailySessionLimit: number;
      monthlyTokenLimit: number;
      mode: "enforced" | "unlimited";
      version: number;
      updatedBy: string | null;
      updatedAt: Date;
    };
    overLimitUserIds: string[];
  }>;
}

export interface UserAgentApiService {
  list(userId: string): PromiseLike<{
    agents: Array<
      AvailableAgentRecord & {
        version?: string;
        ownerUserId?: string;
        lastErrorCode?: string | null;
      }
    >;
    selection: {
      agentId: string;
      source: "personal_default" | "recent" | "default";
    } | null;
    blocker: {
      code: "NO_DEFAULT_AGENT";
      message: string;
    } | null;
  }>;
  get(userId: string, id: string): PromiseLike<AvailableAgentRecord>;
  create(
    input: {
      name: string;
      description: string;
      modelId: string;
      systemPrompt: string;
      skills?: AgentSkillBinding[];
    },
    context: { userId: string; requestId: string },
  ): PromiseLike<PersonalAgentRecord>;
  update(
    id: string,
    input: {
      name?: string;
      description?: string;
      modelId?: string;
      systemPrompt?: string;
      skills?: AgentSkillBinding[];
      arkVersion: string;
    },
    context: { userId: string; requestId: string },
  ): PromiseLike<PersonalAgentRecord>;
  delete(
    id: string,
    context: { userId: string; requestId: string },
  ): PromiseLike<void>;
}

export interface SkillApiService {
  list(
    userId: string,
    query: { scope: SkillScope; search?: string | undefined },
  ): PromiseLike<SkillRecord[]>;
  upload(
    input: {
      file: { name: string; contentType: string; bytes: Uint8Array };
      displayTitle?: string | undefined;
      description?: string | undefined;
    },
    context: { userId: string; requestId: string },
  ): PromiseLike<{ skill: SkillRecord; defaultAgentSync: SyncOutcome }>;
  update(
    id: string,
    input: {
      file?: { name: string; contentType: string; bytes: Uint8Array };
      displayTitle?: string | undefined;
      description?: string | undefined;
    },
    context: { userId: string; requestId: string },
  ): PromiseLike<{ skill: SkillRecord; defaultAgentSync: SyncOutcome }>;
  delete(
    id: string,
    context: { userId: string; requestId: string },
  ): PromiseLike<SyncOutcome>;
  resolveBindings(
    userId: string,
    skillIds: string[],
  ): PromiseLike<AgentSkillBinding[]>;
}

type SyncOutcome = { synced: true } | { synced: false; errorCode: string };

export interface SessionApiService {
  reconcileSubmission?(
    userId: string,
    sessionId: string,
    submissionId: string,
    context: { userId: string; requestId: string },
  ): PromiseLike<unknown>;

  create(
    input: {
      agentId: string;
      title?: string;
      uploadIds?: string[];
      temporary?: boolean;
      submissionId?: string;
      content?: string;
    },
    context: { userId: string; requestId: string },
  ): PromiseLike<SessionRecord & { inputs?: SessionInputRecord[] }>;
  list(userId: string, archived: boolean): PromiseLike<SessionRecord[]>;
  get(
    userId: string,
    id: string,
  ): PromiseLike<
    SessionRecord & {
      inputs?: SessionInputRecord[];
      historyState?: SessionHistoryState;
    }
  >;
  archive(id: string, userId: string): PromiseLike<SessionRecord>;
  restore(id: string, userId: string): PromiseLike<SessionRecord>;
  rename(
    id: string,
    title: string,
    context: { userId: string; requestId: string },
  ): PromiseLike<SessionRecord>;
  setPinned(
    id: string,
    pinned: boolean,
    context: { userId: string; requestId: string },
  ): PromiseLike<SessionRecord>;
  requestDelete(id: string, userId: string): PromiseLike<SessionRecord>;
  sendMessage(
    id: string,
    input: { content: string; submissionId?: string },
    context: { userId: string; requestId: string },
  ): PromiseLike<{
    eventId: string;
    delivery: "accepted" | "queued";
  }>;
  interrupt(
    id: string,
    context: { userId: string; requestId: string },
  ): PromiseLike<{
    eventId: string;
    delivery: "accepted";
  }>;
  openEvents(
    id: string,
    context: { userId: string; requestId: string },
    signal?: AbortSignal,
  ): PromiseLike<{ session: SessionRecord; events: AsyncIterable<UiEvent> }>;
  openStoredEvents?(
    id: string,
    context: { userId: string; requestId: string },
    signal?: AbortSignal,
  ): PromiseLike<{ session: SessionRecord; events: AsyncIterable<UiEvent> }>;
  transcriptEvents(
    id: string,
    context: { userId: string; requestId: string },
    signal?: AbortSignal,
  ): PromiseLike<UiEvent[]>;
}

export interface SessionInputApiService {
  upload(
    input: { name: string; contentType: string; bytes: Uint8Array },
    context: { userId: string; requestId: string; signal?: AbortSignal },
  ): PromiseLike<SessionInputRecord>;
}

export interface ArtifactApiService {
  syncSession(
    sessionId: string,
    context: { userId: string; requestId: string; signal?: AbortSignal },
  ): PromiseLike<ArtifactRecord[]>;
  list(userId: string, sessionId?: string): PromiseLike<ArtifactRecord[]>;
  download(
    id: string,
    userId: string,
    signal?: AbortSignal,
  ): PromiseLike<{
    name: string;
    mimeType: string;
    sizeBytes: number;
    stream: Readable;
  }>;
  requestDelete(id: string, userId: string): PromiseLike<ArtifactRecord>;
}

export interface QuotaUsageApiService {
  getSummary(userId: string): PromiseLike<QuotaUsageSummary>;
}

export type AuditLogPageDto = {
  entries: AuditLogEntry[];
  nextCursor: AuditLogCursor | null;
};

export interface AuditApiService {
  list(query: AuditLogQuery): PromiseLike<AuditLogPageDto>;
  listForUser(
    userId: string,
    query: Pick<AuditLogQuery, "limit" | "before">,
  ): PromiseLike<AuditLogPageDto>;
  recordLogin(input: {
    email: string;
    userId: string | null;
    success: boolean;
    requestId: string;
  }): Promise<void>;
  recordUserView(input: {
    adminId: string;
    userId: string;
    requestId: string;
  }): Promise<void>;
}

export interface AutomationApiService {
  list(ownerUserId: string): PromiseLike<AutomationRecord[]>;
  create(
    ownerUserId: string,
    input: { title: string; schedule: unknown; timezone: string },
  ): PromiseLike<AutomationRecord>;
  setEnabled(
    ownerUserId: string,
    id: string,
    enabled: boolean,
  ): PromiseLike<AutomationRecord>;
  delete(ownerUserId: string, id: string): PromiseLike<void>;
}

export interface InviteApiService {
  list(): PromiseLike<InviteCodeRecord[]>;
  create(
    adminId: string,
    input: { email: string; expiresInDays?: number },
  ): PromiseLike<{ invite: InviteCodeRecord; code: string }>;
  revoke(adminId: string, id: string): PromiseLike<InviteCodeRecord>;
  accept(
    code: string,
    password: string,
  ): PromiseLike<{ userId: string; email: string }>;
}

interface BuildAppOptions {
  auth?: ApiAuthService;
  invites?: InviteApiService;
  automations?: AutomationApiService;
  assistant?: {
    get(userId: string): PromiseLike<AssistantView>;
    update(
      userId: string,
      input: {
        displayName?: string;
        persona?: string;
        preferences?: Record<string, unknown>;
        expectedRevision?: number;
      },
    ): PromiseLike<AssistantView>;
  };
  admin?: AdminService;
  audit?: AuditApiService;
  adminUsage?: AdminUsageApiService;
  quotaPolicy?: QuotaPolicyApiService;
  adminUserDetail?: AdminUserDetailApiService;
  userAgents?: UserAgentApiService;
  skills?: SkillApiService;
  memory?: Pick<
    MemoryService,
    | "list"
    | "status"
    | "write"
    | "remove"
    | "protect"
    | "recover"
    | "cancel"
    | "settings"
    | "expedite"
  >;
  sessions?: SessionApiService;
  eventSource?: "upstream" | "local";
  runs?: {
    get(userId: string, id: string): PromiseLike<RunRecord>;
  };
  sync?: {
    snapshot(userId: string): PromiseLike<unknown>;
    changes(
      userId: string,
      cursor: number,
      limit: number,
    ): PromiseLike<unknown>;
  };
  inputs?: SessionInputApiService;
  artifacts?: ArtifactApiService;
  fileReuse?: {
    prepare(
      id: string,
      context: { userId: string; requestId: string; signal?: AbortSignal },
    ): PromiseLike<SessionInputRecord>;
  };
  delivery?: DeliveryApiRepository;
  artifactRetryWindowMs?: number;
  quotaUsage?: QuotaUsageApiService;
  capabilities?: {
    personalAgentModels: readonly string[];
  };
  isProduction?: boolean;
  logStream?: { write(message: string): void };
  appOrigin?: string;
  rateLimit?: {
    max: number;
    windowMs: number;
    maxEntries?: number;
  };
  readiness?: {
    configurationReady: boolean;
    checkDatabase: (signal?: AbortSignal) => PromiseLike<void>;
    timeoutMs: number;
  };
  webRoot?: string;
  /**
   * Periodic login-session recheck for established SSE streams. Production
   * defaults follow the release-0 contract: every 15 seconds, 2 seconds per
   * check. Tests shorten both; nothing else may rely on these knobs.
   */
  sseAuthRecheckIntervalMs?: number;
  sseAuthRecheckBudgetMs?: number;
}

const credentialsBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["email", "password"],
  properties: {
    email: { type: "string", minLength: 3, maxLength: 320 },
    password: { type: "string", minLength: 1, maxLength: 200 },
  },
} as const;

const createUserBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["email", "password"],
  properties: {
    email: { type: "string", minLength: 3, maxLength: 320 },
    password: { type: "string", minLength: 8, maxLength: 200 },
    role: { type: "string", enum: ["user", "admin"] },
  },
} as const;

const resetPasswordBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["password"],
  properties: {
    password: { type: "string", minLength: 8, maxLength: 200 },
  },
} as const;

const uuidParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: { type: "string", format: "uuid" } },
} as const;

const syncChangesQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    cursor: { type: "integer", minimum: 0, default: 0 },
    limit: { type: "integer", minimum: 1, maximum: 200, default: 100 },
  },
} as const;

const createInviteBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["email"],
  properties: {
    email: { type: "string", minLength: 3, maxLength: 320 },
    expiresInDays: { type: "integer", minimum: 1, maximum: 30 },
  },
} as const;

const acceptInviteBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["code", "password"],
  properties: {
    code: { type: "string", minLength: 16, maxLength: 200 },
    password: { type: "string", minLength: 8, maxLength: 200 },
  },
} as const;

const automationBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "schedule", "timezone"],
  properties: {
    title: { type: "string", minLength: 1, maxLength: 120 },
    schedule: { type: "object" },
    timezone: { type: "string", minLength: 1, maxLength: 80 },
  },
} as const;

const automationPatchSchema = {
  type: "object",
  additionalProperties: false,
  required: ["enabled"],
  properties: { enabled: { type: "boolean" } },
} as const;

const assistantProfileBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    displayName: { type: "string", maxLength: 120 },
    persona: { type: "string", maxLength: 8_000 },
    preferences: { type: "object" },
    expectedRevision: { type: "integer", minimum: 1 },
  },
} as const;

const agentProperties = {
  name: { type: "string", minLength: 1, maxLength: 80 },
  description: { type: "string", maxLength: 500 },
  modelId: { type: "string", minLength: 1, maxLength: 200 },
  systemPrompt: { type: "string", maxLength: 32_000 },
} as const;

const createPlatformAgentBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "modelId", "systemPrompt"],
  properties: agentProperties,
} as const;

const updatePlatformAgentBodySchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: {
        status: { type: "string", enum: ["active", "disabled"] },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["arkVersion"],
      properties: {
        ...agentProperties,
        arkVersion: { type: "string", pattern: "^[1-9][0-9]*$" },
      },
      anyOf: [
        { required: ["name"] },
        { required: ["description"] },
        { required: ["modelId"] },
        { required: ["systemPrompt"] },
      ],
    },
  ],
} as const;

const skillIdsSchema = {
  type: "array",
  items: { type: "string", format: "uuid" },
  maxItems: 50,
  uniqueItems: true,
} as const;

const createPersonalAgentBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "modelId", "systemPrompt"],
  properties: { ...agentProperties, skillIds: skillIdsSchema },
} as const;

const updatePersonalAgentBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["arkVersion"],
  properties: {
    ...agentProperties,
    skillIds: skillIdsSchema,
    arkVersion: { type: "string", pattern: "^[1-9][0-9]*$" },
  },
  anyOf: [
    { required: ["name"] },
    { required: ["description"] },
    { required: ["modelId"] },
    { required: ["systemPrompt"] },
    { required: ["skillIds"] },
  ],
} as const;

const defaultAgentBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["platformAgentId"],
  properties: {
    platformAgentId: { type: "string", format: "uuid" },
  },
} as const;

const quotaDimension = {
  type: ["integer", "null"],
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
} as const;

/**
 * A `null` dimension inherits the default policy; omitting every override
 * removes the user's override row entirely.
 */
const quotaBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    personalAgentLimit: quotaDimension,
    concurrentSessionLimit: quotaDimension,
    dailySessionLimit: quotaDimension,
    monthlyTokenLimit: quotaDimension,
  },
} as const;

const quotaPolicyBodySchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "personalAgentLimit",
    "concurrentSessionLimit",
    "dailySessionLimit",
    "monthlyTokenLimit",
  ],
  properties: {
    personalAgentLimit: {
      type: "integer",
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    },
    concurrentSessionLimit: {
      type: "integer",
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    },
    dailySessionLimit: {
      type: "integer",
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    },
    monthlyTokenLimit: {
      type: "integer",
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    },
    mode: { type: "string", enum: ["enforced", "unlimited"] },
  },
} as const;

const listAdminUserSessionsQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    cursor: { type: "string", minLength: 1, maxLength: 512 },
    limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
  },
} as const;

const listAdminUsageQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    cursor: { type: "string", minLength: 1, maxLength: 512 },
    limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
  },
} as const;

const userStatusBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: { type: "string", enum: ["active", "disabled"] },
  },
} as const;

const userRoleBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["role"],
  properties: {
    role: { type: "string", enum: ["user", "admin"] },
  },
} as const;

const listAdminUsersQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    cursor: { type: "string", minLength: 1, maxLength: 512 },
    limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
    q: { type: "string", minLength: 1, maxLength: 320 },
  },
} as const;

const listAuditLogsQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    since: { type: "string", format: "date-time" },
    until: { type: "string", format: "date-time" },
    actorId: { type: "string", format: "uuid" },
    action: { type: "string", minLength: 1, maxLength: 100 },
    resourceType: { type: "string", minLength: 1, maxLength: 100 },
    resourceId: { type: "string", minLength: 1, maxLength: 320 },
    result: { type: "string", enum: ["succeeded", "failed"] },
    cursor: { type: "string", minLength: 1, maxLength: 512 },
    limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
  },
} as const;

const createSessionBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["agentId"],
  dependencies: { submissionId: ["content"], content: ["submissionId"] },
  properties: {
    agentId: { type: "string", format: "uuid" },
    temporary: { type: "boolean" },
    submissionId: { type: "string", format: "uuid" },
    content: {
      type: "string",
      minLength: 1,
      maxLength: 100_000,
      pattern: "\\S",
    },
    title: { type: "string", minLength: 1, maxLength: 120, pattern: "\\S" },
    uploadIds: {
      type: "array",
      maxItems: 20,
      uniqueItems: true,
      items: { type: "string", format: "uuid" },
    },
  },
} as const;

const listSessionsQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    archived: { type: "boolean", default: false },
  },
} as const;

const listArtifactsQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    sessionId: { type: "string", format: "uuid" },
  },
} as const;

const sendMessageBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["content"],
  properties: {
    submissionId: { type: "string", format: "uuid" },
    content: {
      type: "string",
      minLength: 1,
      maxLength: 100_000,
      pattern: "\\S",
    },
  },
} as const;

const emptyBodySchema = {
  type: "object",
  additionalProperties: false,
} as const;

const renameSessionBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["title"],
  properties: {
    title: { type: "string", minLength: 1, maxLength: 120, pattern: "\\S" },
  },
} as const;

const deleteSessionBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["confirmation"],
  properties: {
    confirmation: { type: "string", const: "DELETE" },
  },
} as const;

const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "font-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "manifest-src 'self'",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "worker-src 'self'",
].join("; ");

const logRedactionPaths = [
  "req.headers.authorization",
  "req.headers.cookie",
  "headers.authorization",
  "headers.cookie",
  "authorization",
  "cookie",
  "token",
  "*.token",
  "password",
  "*.password",
  "apiKey",
  "*.apiKey",
  "clientSecret",
  "*.clientSecret",
  "accessKeySecret",
  "*.accessKeySecret",
  "stsToken",
  "*.stsToken",
  "systemPrompt",
  "*.systemPrompt",
  "prompt",
  "*.prompt",
  "message",
  "*.message",
  "content",
  "*.content",
  "filename",
  "*.filename",
  "fileName",
  "*.fileName",
  "bytes",
  "*.bytes",
  "body",
  "req.body",
];

function rateLimitBucket(method: string, route: string): string {
  if (method === "GET" && route === "/api/v1/sessions/:id/events") {
    return "events";
  }
  if (method === "GET" && route === "/api/v1/artifacts/:id/download") {
    return "downloads";
  }
  return "api";
}

function resourceContext(request: FastifyRequest) {
  const route = request.routeOptions.url ?? "";
  const segments = route.split("/").filter(Boolean);
  const segment = segments[2] === "admin" ? segments[3] : segments[2];
  const resourceType =
    segment === "sessions"
      ? "session"
      : segment === "agents" || segment === "platform-agents"
        ? "agent"
        : segment === "artifacts"
          ? "artifact"
          : segment === "uploads"
            ? "upload"
            : segment === "users"
              ? "user"
              : segment === "auth"
                ? "authentication"
                : undefined;
  const params =
    typeof request.params === "object" && request.params !== null
      ? (request.params as Record<string, unknown>)
      : undefined;
  return {
    ...(resourceType ? { resource_type: resourceType } : {}),
    ...(typeof params?.id === "string" ? { resource_id: params.id } : {}),
  };
}

function captureArkRequestId(error: unknown, request: FastifyRequest): void {
  if (
    typeof error === "object" &&
    error !== null &&
    "arkRequestId" in error &&
    typeof error.arkRequestId === "string"
  ) {
    request.arkRequestId = error.arkRequestId;
  }
}

async function runBoundedProbe(
  probe: (signal?: AbortSignal) => PromiseLike<void>,
  timeoutMs: number,
): Promise<void> {
  const controller = new AbortController();
  const probePromise = Promise.resolve().then(() => probe(controller.signal));
  let timeout: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      let timedOut = false;
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
        void probePromise.then(
          () => reject(new Error("Readiness probe timed out")),
          () => reject(new Error("Readiness probe timed out")),
        );
      }, timeoutMs);
      void probePromise.then(
        () => {
          if (!timedOut) resolve();
        },
        (error: unknown) => {
          if (!timedOut) reject(error);
        },
      );
    });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function cookieOptions(isProduction: boolean, expires?: Date) {
  return {
    path: "/",
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax" as const,
    ...(expires ? { expires } : {}),
  };
}

function authError(requestId: string) {
  return {
    error: {
      code: "AUTH_REQUIRED",
      message: "Authentication required",
      requestId,
      retryable: false,
    },
  };
}

function forbiddenError(requestId: string) {
  return {
    error: {
      code: "FORBIDDEN",
      message: "Forbidden",
      requestId,
      retryable: false,
    },
  };
}

function resourceNotFoundError(requestId: string) {
  return {
    error: {
      code: "RESOURCE_NOT_FOUND",
      message: "Resource not found",
      requestId,
      retryable: false,
    },
  };
}

function applicationError(
  requestId: string,
  code: ErrorCode,
  message: string,
  retryable: boolean,
) {
  return { error: { code, message, requestId, retryable } };
}

function publicMemoryState(state: MemoryState) {
  return {
    status: state.status,
    protectedPaths: state.protectedPaths,
    autoDream: state.autoDream,
    run: state.run
      ? {
          kind: state.run.kind,
          stage: state.run.stage,
          error: state.run.error
            ? "Memory operation failed. Reload or contact support."
            : null,
          before: state.run.before,
          after: state.run.after,
        }
      : null,
  };
}

function publicRun(run: RunRecord) {
  return {
    id: run.id,
    conversationId: run.conversationId,
    triggerKind: run.triggerKind,
    submissionId: run.submissionId,
    status: run.status,
    arkSessionId: run.arkSessionId,
    turnId: run.turnId,
    errorCode: run.errorCode,
    startedAt: run.startedAt?.toISOString() ?? null,
    endedAt: run.endedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
}

function publicAutomation(automation: AutomationRecord) {
  return {
    id: automation.id,
    title: automation.title,
    kind: automation.kind,
    schedule: automation.schedule,
    timezone: automation.timezone,
    nextRunAt: automation.nextRunAt.toISOString(),
    enabled: automation.enabled,
    scheduleVersion: automation.scheduleVersion,
    revision: automation.revision,
    createdAt: automation.createdAt.toISOString(),
    updatedAt: automation.updatedAt.toISOString(),
  };
}

function publicInvite(invite: InviteCodeRecord) {
  return {
    id: invite.id,
    email: invite.email,
    createdBy: invite.createdBy,
    usedByUserId: invite.usedByUserId,
    status: invite.status,
    expiresAt: invite.expiresAt.toISOString(),
    usedAt: invite.usedAt?.toISOString() ?? null,
    revokedAt: invite.revokedAt?.toISOString() ?? null,
    createdAt: invite.createdAt.toISOString(),
    updatedAt: invite.updatedAt.toISOString(),
  };
}

function publicAssistant(view: AssistantView) {
  return {
    profile: {
      ownerUserId: view.profile.ownerUserId,
      defaultAgentId: view.profile.defaultAgentId,
      displayName: view.profile.displayName,
      persona: view.profile.persona,
      preferences: view.profile.preferences,
      revision: view.profile.revision,
      createdAt: view.profile.createdAt.toISOString(),
      updatedAt: view.profile.updatedAt.toISOString(),
    },
    agent: view.agent
      ? {
          id: view.agent.id,
          name: view.agent.name,
          modelId: view.agent.modelId,
          status: view.agent.status,
          arkAgentId: view.agent.arkAgentId,
        }
      : null,
  };
}

const memoryErrors = {
  MEMORY_BUSY: {
    status: 409,
    message: "Memory is busy. Wait for the current operation.",
  },
  MEMORY_CONFLICT: {
    status: 409,
    message: "Memory content changed. Reload before editing.",
  },
  MEMORY_INVALID: {
    status: 400,
    message: "Invalid memory path, content, or operation.",
  },
  MEMORY_CAPACITY: { status: 413, message: "Memory capacity exceeded." },
  MEMORY_REPAIR_REQUIRED: {
    status: 503,
    message: "Memory requires repair. Contact support.",
  },
} as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodePageCursor(value: Record<string, string | number>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodePageCursor(cursor: string): Record<string, string> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, string>;
}

function decodeUserListCursor(cursor: string | undefined) {
  if (cursor === undefined) return { before: null };
  const decoded = decodePageCursor(cursor);
  if (
    !decoded ||
    typeof decoded.createdAt !== "string" ||
    Number.isNaN(Date.parse(decoded.createdAt)) ||
    typeof decoded.id !== "string" ||
    !UUID_PATTERN.test(decoded.id)
  ) {
    return { before: null, invalid: true as const };
  }
  return { before: { createdAt: decoded.createdAt, id: decoded.id } };
}

function decodeAuditCursor(cursor: string | undefined) {
  return decodeUserListCursor(cursor);
}

function decodeUsageCursor(cursor: string | undefined) {
  if (cursor === undefined) return { before: null };
  const decoded = decodePageCursor(cursor);
  if (
    !decoded ||
    typeof decoded.userId !== "string" ||
    !UUID_PATTERN.test(decoded.userId) ||
    typeof decoded.tokens !== "number" ||
    !Number.isSafeInteger(decoded.tokens) ||
    decoded.tokens < 0
  ) {
    return { before: null, invalid: true as const };
  }
  return { before: { tokens: decoded.tokens, userId: decoded.userId } };
}

/**
 * Fastify rejects a malformed request itself, before any handler runs — an empty
 * or unparseable JSON body, an unsupported content type, an oversized payload.
 * Those carry a 4xx `statusCode` and an `FST_ERR_*` code, but no `validation`
 * array, so the generic error handler used to report them as 500s. The client's
 * own message is never echoed; the response carries ours instead.
 *
 * Multipart errors are the one family that does not follow the `FST_ERR_*`
 * naming (`FST_REQ_FILE_TOO_LARGE`, `FST_FILES_LIMIT`, …): without this map an
 * oversized upload surfaced as a 500.
 */
const MULTIPART_CLIENT_ERRORS = new Set([
  "FST_REQ_FILE_TOO_LARGE",
  "FST_FILES_LIMIT",
  "FST_PARTS_LIMIT",
  "FST_FIELDS_LIMIT",
  "FST_PROTO_VIOLATION",
  "FST_INVALID_MULTIPART_CONTENT_TYPE",
  "FST_INVALID_JSON_FIELD_ERROR",
]);

/**
 * Stream-parser failures for a body the client cut off mid-flight. They carry
 * neither an `FST_*` code nor a statusCode, and used to surface as 500s.
 */
const TRUNCATED_BODY_ERROR_CODES = new Set(["ERR_STREAM_PREMATURE_CLOSE"]);

function fastifyClientError(
  error: unknown,
): { status: number; code: ErrorCode; message: string } | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { code?: unknown; statusCode?: unknown };
  if (typeof candidate.code !== "string") return undefined;
  if (TRUNCATED_BODY_ERROR_CODES.has(candidate.code)) {
    return {
      status: 400,
      code: "VALIDATION_FAILED",
      message: "Request body ended before it was complete",
    };
  }
  if (
    !candidate.code.startsWith("FST_ERR_") &&
    !MULTIPART_CLIENT_ERRORS.has(candidate.code)
  ) {
    return undefined;
  }
  if (
    typeof candidate.statusCode !== "number" ||
    candidate.statusCode < 400 ||
    candidate.statusCode >= 500
  ) {
    return undefined;
  }
  if (candidate.code === "FST_REQ_FILE_TOO_LARGE") {
    return {
      status: 413,
      code: "VALIDATION_FAILED",
      message: "Uploaded file exceeds the 20 MB size limit",
    };
  }
  if (
    candidate.code === "FST_FILES_LIMIT" ||
    candidate.code === "FST_PARTS_LIMIT" ||
    candidate.code === "FST_FIELDS_LIMIT"
  ) {
    return {
      status: 413,
      code: "VALIDATION_FAILED",
      message: "Upload has too many parts",
    };
  }
  switch (candidate.statusCode) {
    case 413:
      return {
        status: 413,
        code: "VALIDATION_FAILED",
        message: "Request body is too large",
      };
    case 415:
      return {
        status: 415,
        code: "VALIDATION_FAILED",
        message: "Unsupported content type",
      };
    case 404:
      return {
        status: 404,
        code: "RESOURCE_NOT_FOUND",
        message: "Resource not found",
      };
    default:
      return {
        status: candidate.statusCode,
        code: "VALIDATION_FAILED",
        message: "Request body could not be read",
      };
  }
}

function sendArkAvailabilityError(
  category: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): boolean {
  if (category === "rate_limited") {
    reply
      .code(429)
      .send(
        applicationError(
          request.id,
          "ARK_RATE_LIMITED",
          "Ark rate limit exceeded",
          true,
        ),
      );
    return true;
  }
  if (
    category === "unavailable" ||
    category === "unknown_write_outcome" ||
    category === "timeout"
  ) {
    reply
      .code(503)
      .send(
        applicationError(
          request.id,
          "ARK_UNAVAILABLE",
          "Ark service is unavailable",
          category !== "unknown_write_outcome",
        ),
      );
    return true;
  }
  return false;
}

/**
 * Last-resort mapping for Ark gateway categories that no flow-specific handler
 * claimed. Without this the error would escape as a framework 500 with no
 * application error code for the web client to interpret.
 */
function sendArkCategoryError(
  category: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): boolean {
  if (typeof category !== "string") return false;
  switch (category) {
    case "invalid_response":
      reply
        .code(502)
        .send(
          applicationError(
            request.id,
            "ARK_INVALID_RESPONSE",
            "Ark rejected the request or returned an unexpected response",
            false,
          ),
        );
      return true;
    case "not_found":
      reply.code(404).send(resourceNotFoundError(request.id));
      return true;
    case "runtime_busy":
      reply
        .code(503)
        .send(
          applicationError(
            request.id,
            "ARK_RUNTIME_BUSY",
            "Ark is busy handling other work",
            true,
          ),
        );
      return true;
    case "session_terminated":
    case "cancelled":
      reply
        .code(409)
        .send(
          applicationError(
            request.id,
            "ARK_REQUEST_REJECTED",
            "Ark cannot serve this request in its current state",
            false,
          ),
        );
      return true;
    default:
      return false;
  }
}

function publicAgent(agent: PlatformAgentRecord) {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    modelId: agent.modelId,
    systemPrompt: agent.systemPrompt,
    arkVersion: agent.arkVersion,
    status: agent.status,
    lastErrorCode: agent.lastErrorCode,
  };
}

function publicUserAgent(
  agent: AvailableAgentRecord | PersonalAgentRecord,
  includePrompt = false,
) {
  const personal = "ownerUserId" in agent;
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    modelId: agent.modelId,
    version: agent.arkVersion,
    status: agent.status,
    kind: personal ? ("personal" as const) : agent.kind,
    editable: personal ? true : agent.editable,
    isAutoDefault: agent.isAutoDefault,
    // AvailableAgentRecord carries Skill summaries; a bare provisioning record
    // (create/update) carries Ark bindings instead, so no titles are claimed.
    ...("kind" in agent
      ? { skills: agent.skills }
      : { skills: agent.skills.map((skill) => ({ id: skill.skillId })) }),
    ...(personal ? { lastErrorCode: agent.lastErrorCode } : {}),
    ...(includePrompt && (personal || agent.editable)
      ? { systemPrompt: agent.systemPrompt }
      : {}),
  };
}

function publicSkill(skill: SkillRecord) {
  return {
    id: skill.id,
    name: skill.name,
    displayTitle: skill.displayTitle,
    description: skill.description,
    latestVersion: skill.latestVersion,
    source: skill.source,
    fileName: skill.fileName,
    fileSize: skill.fileSize,
    status: skill.status,
    preset: skill.ownerUserId === null,
    createdAt: skill.createdAt.toISOString(),
    updatedAt: skill.updatedAt.toISOString(),
  };
}

function adminUserAgent(agent: AdminUserAgentRecord) {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    modelId: agent.modelId,
    version: agent.arkVersion,
    status: agent.status,
    isAutoDefault: agent.isAutoDefault,
    ownerUserId: agent.ownerUserId,
    ownerEmail: agent.ownerEmail,
    skills: agent.skills,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
  };
}

function publicInput(input: SessionInputRecord) {
  return {
    id: input.id,
    name: input.originalName,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    mountPath: input.mountPath,
    ...(input.sessionId === null
      ? {
          status: input.status,
          expiresAt: input.expiresAt,
        }
      : {}),
  };
}

function inputCancellation(request: FastifyRequest, reply: FastifyReply) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.raw.once("aborted", abort);
  reply.raw.once("close", abort);
  return {
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
    close: () => {
      request.raw.removeListener("aborted", abort);
      reply.raw.removeListener("close", abort);
    },
  };
}

function publicSession(
  session: SessionRecord & {
    inputs?: SessionInputRecord[];
    historyState?: SessionHistoryState;
    submissions?: Array<{
      submissionId: string;
      status: string;
      content: string | null;
      acceptedContent?: string | null;
      upstreamEventId: string | null;
      lastErrorCode: string | null;
      createdAt: Date;
    }>;
  },
) {
  return {
    id: session.id,
    ...(session.historyState
      ? {
          historyState: {
            ...session.historyState,
            scannedAt: session.historyState.scannedAt?.toISOString() ?? null,
          },
        }
      : {}),
    ...(session.submissions
      ? {
          submissions: session.submissions.map((item) => ({
            submissionId: item.submissionId,
            status: item.status,
            content: item.content,
            acceptedContent:
              item.acceptedContent == null
                ? null
                : (projectUiEvent({
                    id: item.upstreamEventId ?? item.submissionId,
                    sourceType: "user.message",
                    type: "message",
                    createdAt: item.createdAt.toISOString(),
                    payload: { content: item.acceptedContent },
                  }).payload.content ?? null),
            upstreamEventId: item.upstreamEventId,
            errorCode: item.lastErrorCode,
            createdAt: item.createdAt,
          })),
        }
      : {}),
    upstreamReady: !session.arkSessionId.startsWith("pending:"),
    title: session.title,
    status: session.status,
    error:
      session.lastErrorCode == null
        ? null
        : {
            code: session.lastErrorCode,
            recoverable: session.errorRecoverable === true,
          },
    deletionState: session.deletionState,
    archivedAt: session.archivedAt,
    pinnedAt: session.pinnedAt,
    lastEventAt: session.lastEventAt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    agent: {
      id:
        session.agentKind === "platform"
          ? session.platformAgentId
          : session.personalAgentId,
      kind: session.agentKind,
      name: session.agentName,
      version: session.agentVersion,
    },
    ...("inputs" in session
      ? { inputs: (session.inputs ?? []).map(publicInput) }
      : {}),
  };
}

function publicArtifact(artifact: ArtifactRecord) {
  return {
    id: artifact.id,
    sessionId: artifact.sessionId,
    name: artifact.name,
    mimeType: artifact.mimeType,
    sizeBytes: artifact.sizeBytes,
    generatedAt: artifact.generatedAt,
    deletionState: artifact.deletionState,
    error:
      artifact.lastErrorCode === null
        ? null
        : { code: artifact.lastErrorCode, retryable: true },
  };
}

function attachmentFilename(name: string): string {
  const safe = Array.from(name, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 ||
      code > 126 ||
      code === 127 ||
      character === '"' ||
      character === "\\"
      ? "_"
      : character;
  })
    .join("")
    .trim();
  return safe || "download";
}

function contentDisposition(name: string): string {
  const fallback = `attachment; filename="${attachmentFilename(name)}"`;
  if (
    !Array.from(name).some((character) => (character.codePointAt(0) ?? 0) > 126)
  ) {
    return fallback;
  }
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${fallback}; filename*=UTF-8''${encoded}`;
}

async function writeSseChunk(
  response: ServerResponse,
  chunk: string,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted || response.destroyed) return false;
  if (response.write(chunk)) return true;

  return new Promise<boolean>((resolve) => {
    const finish = (writable: boolean) => {
      response.removeListener("drain", drained);
      response.removeListener("close", closed);
      signal.removeEventListener("abort", aborted);
      resolve(writable);
    };
    const drained = () => finish(true);
    const closed = () => finish(false);
    const aborted = () => finish(false);

    response.once("drain", drained);
    response.once("close", closed);
    signal.addEventListener("abort", aborted, { once: true });

    if (signal.aborted || response.destroyed) {
      finish(false);
    } else if (!response.writableNeedDrain) {
      finish(true);
    }
  });
}

function sendAdminError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  captureArkRequestId(error, request);
  if (
    error instanceof ResourceNotFoundError ||
    hasErrorName(error, "ResourceNotFoundError")
  ) {
    return reply.code(404).send(resourceNotFoundError(request.id));
  }
  if (
    error instanceof InvalidModelError ||
    hasErrorName(error, "InvalidModelError")
  ) {
    return reply
      .code(400)
      .send(
        applicationError(
          request.id,
          "VALIDATION_FAILED",
          "Model is not allowed",
          false,
        ),
      );
  }
  if (
    error instanceof PersonalAgentQuotaExceededError ||
    hasErrorName(error, "PersonalAgentQuotaExceededError")
  ) {
    return reply
      .code(429)
      .send(
        applicationError(
          request.id,
          "QUOTA_EXCEEDED",
          "Personal Agent quota exceeded",
          false,
        ),
      );
  }
  if (
    error instanceof UserEmailConflictError ||
    hasErrorName(error, "UserEmailConflictError")
  ) {
    return reply
      .code(409)
      .send(
        applicationError(
          request.id,
          "USER_EMAIL_CONFLICT",
          "A user with this email already exists",
          false,
        ),
      );
  }
  if (
    error instanceof SelfTargetForbiddenError ||
    hasErrorName(error, "SelfTargetForbiddenError")
  ) {
    return reply
      .code(409)
      .send(
        applicationError(
          request.id,
          "SELF_TARGET_FORBIDDEN",
          "Administrators cannot target their own account",
          false,
        ),
      );
  }
  if (
    error instanceof LastActiveAdminError ||
    hasErrorName(error, "LastActiveAdminError")
  ) {
    return reply
      .code(409)
      .send(
        applicationError(
          request.id,
          "LAST_ACTIVE_ADMIN",
          "The last active administrator cannot be disabled or demoted",
          false,
        ),
      );
  }
  if (
    error instanceof InvalidUserInputError ||
    hasErrorName(error, "InvalidUserInputError")
  ) {
    return reply
      .code(400)
      .send(
        applicationError(
          request.id,
          "VALIDATION_FAILED",
          "User details are invalid",
          false,
        ),
      );
  }
  if (
    error instanceof AgentConflictError ||
    hasErrorName(error, "AgentConflictError") ||
    (typeof error === "object" &&
      error !== null &&
      "category" in error &&
      error.category === "version_conflict")
  ) {
    return reply
      .code(409)
      .send(
        applicationError(
          request.id,
          "ARK_CONFLICT",
          "Agent version conflict",
          false,
        ),
      );
  }
  if (
    error instanceof AgentReferencedError ||
    hasErrorName(error, "AgentReferencedError")
  ) {
    return reply
      .code(409)
      .send(
        applicationError(
          request.id,
          "VALIDATION_FAILED",
          "Platform Agent is still referenced",
          false,
        ),
      );
  }
  if (hasErrorName(error, "PersonalAgentBusyError")) {
    return reply
      .code(409)
      .send(
        applicationError(
          request.id,
          "AGENT_BUSY",
          "Personal Agent creation is still being reconciled",
          true,
        ),
      );
  }
  if (
    error instanceof InvalidSkillPackageError ||
    hasErrorName(error, "InvalidSkillPackageError")
  ) {
    return reply
      .code(400)
      .send(
        applicationError(
          request.id,
          "INVALID_SKILL_PACKAGE",
          "Skill packages must be non-empty .zip archives up to 50 MB",
          false,
        ),
      );
  }
  if (
    error instanceof SkillNotSelectableError ||
    hasErrorName(error, "SkillNotSelectableError")
  ) {
    return reply
      .code(400)
      .send(
        applicationError(
          request.id,
          "SKILL_NOT_AVAILABLE",
          "One or more selected Skills are not available",
          false,
        ),
      );
  }
  const category =
    typeof error === "object" && error !== null && "category" in error
      ? error.category
      : undefined;
  if (sendArkAvailabilityError(category, request, reply)) return reply;
  if (sendArkCategoryError(category, request, reply)) return reply;
  throw error;
}

function sendSessionError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  captureArkRequestId(error, request);
  if (
    error instanceof Error &&
    "code" in error &&
    (error.code === "SUBMISSION_ADMISSION_PAUSED" ||
      error.code === "FILE_REUSE_ADMISSION_PAUSED")
  )
    return reply
      .code(503)
      .send(applicationError(request.id, error.code, error.message, true));
  if (hasErrorName(error, "UploadTooLargeError"))
    return reply
      .code(413)
      .send(
        applicationError(
          request.id,
          error instanceof Error &&
            "code" in error &&
            error.code === "UPLOAD_TOTAL_TOO_LARGE"
            ? "UPLOAD_TOTAL_TOO_LARGE"
            : "UPLOAD_TOO_LARGE",
          error instanceof Error &&
            "code" in error &&
            error.code === "UPLOAD_TOTAL_TOO_LARGE"
            ? "材料总量不能超过 100 MB"
            : "单个材料不能超过 20 MB",
          false,
        ),
      );
  if (hasErrorName(error, "SessionPendingOperationError"))
    return reply
      .code(409)
      .send(
        applicationError(
          request.id,
          "SESSION_BUSY",
          "A pending task cannot be interrupted yet",
          false,
        ),
      );
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "SUBMISSION_CONFLICT"
  ) {
    return reply
      .code(409)
      .send(
        applicationError(
          request.id,
          "SUBMISSION_CONFLICT",
          "Submission ID was used for another request",
          false,
        ),
      );
  }
  if (
    hasErrorName(error, "SessionCreateVerificationError") &&
    typeof error === "object" &&
    error !== null &&
    "code" in error
  ) {
    if (error.code === "ARK_SESSION_CREATE_OUTCOME_UNKNOWN") {
      sendArkAvailabilityError("unknown_write_outcome", request, reply);
      return reply;
    }
    if (
      error.code === "ARK_SESSION_AGENT_ID_MISMATCH" ||
      error.code === "ARK_SESSION_AGENT_VERSION_MISMATCH" ||
      error.code === "ARK_SESSION_ENVIRONMENT_ID_MISMATCH" ||
      error.code === "ARK_SESSION_SNAPSHOT_ENVIRONMENT_ID_MISMATCH" ||
      error.code === "ARK_SESSION_CONFIG_SNAPSHOT_INCOMPLETE"
    ) {
      sendArkCategoryError("invalid_response", request, reply);
      return reply;
    }
  }
  if (
    error instanceof ResourceNotFoundError ||
    hasErrorName(error, "ResourceNotFoundError")
  ) {
    return reply.code(404).send(resourceNotFoundError(request.id));
  }
  if (
    error instanceof SessionHistoryRepairPendingError ||
    hasErrorName(error, "SessionHistoryRepairPendingError")
  ) {
    return reply
      .code(409)
      .send(
        applicationError(
          request.id,
          "EVENT_HISTORY_REPAIR_PENDING",
          "会话历史正在修复，暂时无法完整导出。请稍后重试。",
          true,
        ),
      );
  }
  if (
    error instanceof SessionTerminatedError ||
    hasErrorName(error, "SessionTerminatedError") ||
    (typeof error === "object" &&
      error !== null &&
      "category" in error &&
      error.category === "session_terminated")
  ) {
    return reply
      .code(409)
      .send(
        applicationError(
          request.id,
          "SESSION_TERMINATED",
          "Session is terminated",
          false,
        ),
      );
  }
  if (hasErrorName(error, "SessionDeletionConflictError")) {
    const failed =
      typeof error === "object" &&
      error !== null &&
      "deletionState" in error &&
      error.deletionState === "deletion_failed";
    return reply
      .code(409)
      .send(
        applicationError(
          request.id,
          failed ? "DELETION_FAILED" : "DELETION_PENDING",
          failed
            ? "Session deletion has failed"
            : "Session deletion is pending",
          false,
        ),
      );
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "QuotaExceededError"
  ) {
    const concurrent =
      "dimension" in error && error.dimension === "concurrent_sessions";
    return reply
      .code(429)
      .send(
        applicationError(
          request.id,
          concurrent ? "CONCURRENCY_LIMITED" : "QUOTA_EXCEEDED",
          concurrent ? "Concurrent Session quota exceeded" : "Quota exceeded",
          false,
        ),
      );
  }
  const category =
    typeof error === "object" && error !== null && "category" in error
      ? error.category
      : undefined;
  if (category === "runtime_busy") {
    return reply
      .code(409)
      .send(
        applicationError(
          request.id,
          "SESSION_BUSY",
          "Session runtime is busy",
          true,
        ),
      );
  }
  if (sendArkAvailabilityError(category, request, reply)) return reply;
  if (sendArkCategoryError(category, request, reply)) return reply;
  throw error;
}

function sendArtifactError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  captureArkRequestId(error, request);
  if (
    error instanceof ResourceNotFoundError ||
    hasErrorName(error, "ResourceNotFoundError")
  ) {
    return reply.code(404).send(resourceNotFoundError(request.id));
  }
  const storageFailure =
    hasErrorName(error, "StorageProviderError") &&
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "STORAGE_UNAVAILABLE";
  const category =
    typeof error === "object" && error !== null && "category" in error
      ? error.category
      : undefined;
  const sourceFailure =
    hasErrorName(error, "ArkGatewayError") && typeof category === "string";
  if (storageFailure || sourceFailure) {
    const code = storageFailure
      ? "ARTIFACT_STORAGE_UNAVAILABLE"
      : "ARTIFACT_SOURCE_UNAVAILABLE";
    const operation =
      typeof error === "object" &&
      error !== null &&
      "operation" in error &&
      (error.operation === "write" ||
        error.operation === "read" ||
        error.operation === "delete")
        ? error.operation
        : undefined;
    request.log.error(
      {
        artifactErrorCode: code,
        ...(operation ? { artifactOperation: operation } : {}),
      },
      "Artifact provider operation failed",
    );
    return reply
      .code(503)
      .send(
        applicationError(
          request.id,
          code,
          "Artifact service is unavailable",
          true,
        ),
      );
  }
  return sendSessionError(error, request, reply);
}

/**
 * Every admin route declares the permission it requires; unknown admin routes
 * stay invisible (404). Adding a role later only extends the role → permission
 * mapping in `@pwa/domain`, never this table's semantics.
 */
const ADMIN_ROUTE_PERMISSIONS: Record<string, AdminPermission> = {
  "/api/v1/admin/platform-agents": "AGENT_MANAGE",
  "/api/v1/admin/platform-agents/:id": "AGENT_MANAGE",
  "/api/v1/admin/user-agents": "AGENT_MANAGE",
  "/api/v1/admin/users": "USER_MANAGE",
  "/api/v1/admin/users/:id": "USER_MANAGE",
  "/api/v1/admin/users/:id/audit": "AUDIT_VIEW",
  "/api/v1/admin/users/:id/default-agent": "USER_MANAGE",
  "/api/v1/admin/users/:id/password": "USER_MANAGE",
  "/api/v1/admin/users/:id/quota": "QUOTA_MANAGE",
  "/api/v1/admin/users/:id/role": "USER_MANAGE",
  "/api/v1/admin/users/:id/sessions": "USER_MANAGE",
  "/api/v1/admin/users/:id/sessions/revoke": "USER_MANAGE",
  "/api/v1/admin/users/:id/status": "USER_MANAGE",
  "/api/v1/admin/users/:id/usage": "USAGE_VIEW",
  "/api/v1/admin/users/:id/submissions/:submissionId/reconcile": "USER_MANAGE",
  "/api/v1/admin/invites": "USER_MANAGE",
  "/api/v1/admin/invites/:id/revoke": "USER_MANAGE",
  "/api/v1/admin/audit-logs": "AUDIT_VIEW",
  "/api/v1/admin/quota-policy": "SETTINGS_MANAGE",
  "/api/v1/admin/usage/agents": "USAGE_VIEW",
  "/api/v1/admin/usage/overview": "USAGE_VIEW",
};

function adminRoutePermission(route: string): AdminPermission | undefined {
  return ADMIN_ROUTE_PERMISSIONS[route];
}

function hasErrorName(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name;
}

export function requireAuthenticated(
  auth: ApiAuthService,
  isProduction = false,
) {
  return async function authenticateRequest(
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    try {
      const token = request.cookies[AUTH_COOKIE_NAME];
      request.auth = await auth.authenticate(token);
      if (token) {
        const renewed = await auth.renew(token);
        reply.setCookie(
          AUTH_COOKIE_NAME,
          token,
          cookieOptions(isProduction, renewed.expiresAt),
        );
      }
    } catch (error) {
      if (
        !(error instanceof AuthRequiredError) &&
        !hasErrorName(error, "AuthRequiredError")
      ) {
        throw error;
      }
      return reply.code(401).send(authError(request.id));
    }
  };
}

export function requirePermission(
  auth: ApiAuthService,
  permission: AdminPermission,
  isProduction = false,
) {
  const authenticate = requireAuthenticated(auth, isProduction);
  return async function authorizePermission(
    request: Parameters<typeof authenticate>[0],
    reply: Parameters<typeof authenticate>[1],
  ) {
    await authenticate(request, reply);
    if (reply.sent) {
      return reply;
    }
    if (!roleHasPermission(request.auth?.role, permission)) {
      return reply.code(403).send(forbiddenError(request.id));
    }
  };
}

export function requireAdmin(auth: ApiAuthService, isProduction = false) {
  return requirePermission(auth, "USER_MANAGE", isProduction);
}

export function requireUser(auth: ApiAuthService, isProduction = false) {
  const authenticate = requireAuthenticated(auth, isProduction);
  return async function authorizeUserContent(
    request: Parameters<typeof authenticate>[0],
    reply: Parameters<typeof authenticate>[1],
  ) {
    await authenticate(request, reply);
    if (reply.sent) {
      return reply;
    }
    if (request.auth?.role !== "user") {
      return reply.code(404).send(resourceNotFoundError(request.id));
    }
  };
}

export function requireTenantResource(
  authorization: Pick<TenantAuthorizationService, "resolve">,
  kind: TenantResourceKind,
) {
  return async function authorizeTenantResource(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) {
    if (!request.auth) {
      return reply.code(401).send(authError(request.id));
    }
    if (request.auth.role !== "user") {
      return reply.code(404).send(resourceNotFoundError(request.id));
    }

    try {
      request.tenantResource = await authorization.resolve(
        kind,
        request.params.id,
        request.auth.userId,
      );
    } catch (error) {
      if (
        !(error instanceof ResourceNotFoundError) &&
        !hasErrorName(error, "ResourceNotFoundError")
      ) {
        throw error;
      }
      return reply.code(404).send(resourceNotFoundError(request.id));
    }
  };
}

const unavailableAuth: ApiAuthService = {
  async login() {
    throw new AuthRequiredError();
  },
  async authenticate() {
    throw new AuthRequiredError();
  },
  async renew() {
    throw new AuthRequiredError();
  },
  async logout() {},
};

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({
    logger: {
      redact: {
        paths: logRedactionPaths,
        censor: "[REDACTED]",
      },
      ...(options.logStream ? { stream: options.logStream } : {}),
    },
    logController: new LogController({ disableRequestLogging: true }),
    ajv: { customOptions: { removeAdditional: false } },
  });
  const isProduction = options.isProduction ?? false;
  const appOrigin = new URL(options.appOrigin ?? "http://localhost:5173")
    .origin;
  const rateLimit = options.rateLimit ?? { max: 120, windowMs: 60_000 };
  const maxRequestWindows = Math.max(1, rateLimit.maxEntries ?? 10_000);
  const requestWindows = new Map<string, { count: number; resetAt: number }>();
  const activeEventStreams = new Map<string, number>();
  /**
   * Established SSE streams per authenticated user, so an admin-level
   * revocation in THIS process closes them immediately instead of waiting
   * for the periodic recheck (which remains the cross-replica backstop).
   */
  const activeAuthStreams = new Map<string, Set<AbortController>>();
  const registerAuthStream = (userId: string, controller: AbortController) => {
    const streams = activeAuthStreams.get(userId) ?? new Set<AbortController>();
    streams.add(controller);
    activeAuthStreams.set(userId, streams);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      streams.delete(controller);
      if (streams.size === 0) activeAuthStreams.delete(userId);
    };
  };
  const closeAuthStreamsForUser = (userId: string) => {
    const streams = activeAuthStreams.get(userId);
    if (!streams) return;
    for (const controller of [...streams]) controller.abort();
  };
  let nextRequestWindowSweep = 0;

  const acquireEventStream = (userId: string, sessionId: string) => {
    const key = `${userId}:${sessionId}`;
    const active = activeEventStreams.get(key) ?? 0;
    if (active >= rateLimit.max) return undefined;
    activeEventStreams.set(key, active + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (activeEventStreams.get(key) ?? 1) - 1;
      if (remaining <= 0) activeEventStreams.delete(key);
      else activeEventStreams.set(key, remaining);
    };
  };

  void app.register(cookie);
  void app.register(multipart, {
    limits: {
      files: 20,
      fields: 20,
      fileSize: 20 * 1024 * 1024,
    },
  });
  if (options.webRoot) {
    void app.register(staticFiles, {
      root: options.webRoot,
      wildcard: false,
    });
    app.setNotFoundHandler((request, reply) => {
      const pathname = request.url.split("?", 1)[0] ?? request.url;
      const excludedNamespaces = [
        "/api",
        "/health",
        "/assets",
        "/@vite",
        "/@id",
        "/@fs",
        "/@react-refresh",
        "/__vite_ping",
      ];
      const excluded = excludedNamespaces.some(
        (namespace) =>
          pathname === namespace || pathname.startsWith(`${namespace}/`),
      );
      if (request.method === "GET" && !excluded && extname(pathname) === "") {
        return reply.type("text/html").sendFile("index.html");
      }
      return reply.code(404).send(resourceNotFoundError(request.id));
    });
  }

  app.addHook("onResponse", async (request, reply) => {
    request.log.info(
      {
        event: "request.completed",
        request_id: request.id,
        ...(request.auth ? { user_id: request.auth.userId } : {}),
        ...resourceContext(request),
        result: reply.statusCode < 400 ? "success" : "error",
        status_code: reply.statusCode,
        ...(request.arkRequestId
          ? { ark_request_id: request.arkRequestId }
          : {}),
      },
      "Request completed",
    );
  });

  app.setErrorHandler((error, request, reply) => {
    if (
      hasErrorName(error, "MemoryError") &&
      typeof error === "object" &&
      error !== null &&
      "code" in error
    ) {
      const code = error.code;
      if (typeof code === "string" && Object.hasOwn(memoryErrors, code)) {
        const memoryCode = code as keyof typeof memoryErrors;
        const mapped = memoryErrors[memoryCode];
        return reply
          .code(mapped.status)
          .send(
            applicationError(
              request.id,
              memoryCode,
              mapped.message,
              memoryCode === "MEMORY_BUSY",
            ),
          );
      }
    }
    const validation =
      typeof error === "object" &&
      error !== null &&
      "validation" in error &&
      error.validation !== undefined;
    const clientError = validation ? undefined : fastifyClientError(error);
    const status = validation ? 400 : (clientError?.status ?? 500);
    const code: ErrorCode = validation
      ? "VALIDATION_FAILED"
      : (clientError?.code ?? "INTERNAL_ERROR");
    request.log.error(
      {
        event: "request.failed",
        request_id: request.id,
        ...(request.auth ? { user_id: request.auth.userId } : {}),
        ...resourceContext(request),
        result: "error",
        status_code: status,
        error_code: code,
      },
      "Request failed",
    );
    return reply
      .code(status)
      .send(
        applicationError(
          request.id,
          code,
          validation
            ? "Request validation failed"
            : (clientError?.message ?? "Internal server error"),
          false,
        ),
      );
  });

  app.addHook("onRequest", async (request, reply) => {
    reply
      .header("content-security-policy", contentSecurityPolicy)
      .header("cross-origin-opener-policy", "same-origin")
      .header("cross-origin-resource-policy", "same-origin")
      .header("permissions-policy", "camera=(), microphone=(), geolocation=()")
      .header("referrer-policy", "no-referrer")
      .header("x-frame-options", "DENY")
      .header("x-content-type-options", "nosniff");
    if (isProduction) {
      reply.header(
        "strict-transport-security",
        "max-age=31536000; includeSubDomains",
      );
    }

    const origin = request.headers.origin;
    if (origin !== undefined) {
      if (origin !== appOrigin) {
        return reply
          .code(403)
          .send(
            applicationError(
              request.id,
              "ORIGIN_FORBIDDEN",
              "Origin is not allowed",
              false,
            ),
          );
      }
      reply
        .header("access-control-allow-origin", appOrigin)
        .header("access-control-allow-credentials", "true")
        .header("vary", "Origin");
      if (request.method === "OPTIONS") {
        return reply
          .header(
            "access-control-allow-methods",
            "GET, POST, PATCH, PUT, DELETE, OPTIONS",
          )
          .header("access-control-allow-headers", "Content-Type, Last-Event-ID")
          .code(204)
          .send();
      }
    }

    const route = request.routeOptions.url ?? "";
    if (!request.url.startsWith("/api/v1/")) {
      return;
    }

    const now = Date.now();
    if (
      now >= nextRequestWindowSweep ||
      requestWindows.size >= maxRequestWindows
    ) {
      for (const [key, value] of requestWindows) {
        if (value.resetAt <= now) requestWindows.delete(key);
      }
      nextRequestWindowSweep = now + rateLimit.windowMs;
    }
    const rateLimitKey = `${request.ip}:${rateLimitBucket(request.method, route)}`;
    let window = requestWindows.get(rateLimitKey);
    if (!window || window.resetAt <= now) {
      requestWindows.delete(rateLimitKey);
      while (requestWindows.size >= maxRequestWindows) {
        const oldestKey = requestWindows.keys().next().value as
          string | undefined;
        if (oldestKey === undefined) break;
        requestWindows.delete(oldestKey);
      }
      window = { count: 0, resetAt: now + rateLimit.windowMs };
      requestWindows.set(rateLimitKey, window);
    }
    window.count += 1;
    if (window.count <= rateLimit.max) return;

    const retryAfter = Math.max(1, Math.ceil((window.resetAt - now) / 1_000));
    return reply
      .header("retry-after", retryAfter)
      .code(429)
      .send(
        applicationError(request.id, "RATE_LIMITED", "Too many requests", true),
      );
  });

  app.get("/preview-frame", async (_request, reply) =>
    reply
      .header(
        "content-security-policy",
        "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'",
      )
      .header("x-frame-options", "SAMEORIGIN")
      .header("cache-control", "no-store")
      .type("text/html")
      .send(
        '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>',
      ),
  );

  app.get("/health", async () => ({ status: "ok" }));
  app.get("/health/live", async () => ({ status: "live" }));
  app.get("/health/ready", async (_request, reply) => {
    const readiness = options.readiness ?? {
      configurationReady: true,
      checkDatabase: async () => undefined,
      timeoutMs: 1_000,
    };
    if (!readiness.configurationReady) {
      return reply.code(503).send({
        status: "not_ready",
        checks: { configuration: "failed", database: "skipped" },
      });
    }
    try {
      await runBoundedProbe(readiness.checkDatabase, readiness.timeoutMs);
      return reply.send({
        status: "ready",
        checks: { configuration: "ok", database: "ok" },
      });
    } catch {
      return reply.code(503).send({
        status: "not_ready",
        checks: { configuration: "ok", database: "failed" },
      });
    }
  });

  {
    const auth = options.auth ?? unavailableAuth;
    const authenticate = requireAuthenticated(auth, isProduction);
    const authorizeUser = requireUser(auth, isProduction);

    app.addHook("preHandler", async (request, reply) => {
      const route = request.routeOptions.url ?? "";
      if (!route.startsWith("/api/v1/") || route.startsWith("/api/v1/auth/")) {
        return;
      }
      if (route.startsWith("/api/v1/admin/")) {
        const permission = adminRoutePermission(route);
        if (!permission) {
          return reply.code(404).send(resourceNotFoundError(request.id));
        }
        await authenticate(request, reply);
        if (reply.sent) {
          return reply;
        }
        if (!roleHasPermission(request.auth?.role, permission)) {
          return reply.code(403).send(forbiddenError(request.id));
        }
        return;
      }
      // /me and /capabilities describe the caller, not user content, so both
      // roles may read them; authorizeUser would 404 an administrator.
      if (route === "/api/v1/me" || route === "/api/v1/capabilities") {
        return authenticate(request, reply);
      }
      return authorizeUser(request, reply);
    });

    if (options.delivery) {
      registerSessionDeliveryRoutes(
        app,
        options.delivery,
        options.artifactRetryWindowMs,
      );
    }

    app.post<{ Body: { email: string; password: string } }>(
      "/api/v1/auth/login",
      { schema: { body: credentialsBodySchema } },
      async (request, reply) => {
        const email = request.body.email.trim().toLowerCase();
        try {
          const session = await auth.login(email, request.body.password);
          reply.setCookie(
            AUTH_COOKIE_NAME,
            session.token,
            cookieOptions(isProduction, session.expiresAt),
          );
          if (options.audit) {
            const identity = await auth
              .authenticate(session.token)
              .catch(() => undefined);
            await options.audit.recordLogin({
              email,
              userId: identity?.userId ?? null,
              success: true,
              requestId: request.id,
            });
          }
          return reply.code(204).send();
        } catch (error) {
          if (
            !(error instanceof AuthRequiredError) &&
            !hasErrorName(error, "AuthRequiredError")
          ) {
            throw error;
          }
          await options.audit
            ?.recordLogin({
              email,
              userId: null,
              success: false,
              requestId: request.id,
            })
            .catch(() => undefined);
          return reply.code(401).send(authError(request.id));
        }
      },
    );

    if (options.invites) {
      app.post<{ Body: { code: string; password: string } }>(
        "/api/v1/auth/invite/accept",
        { schema: { body: acceptInviteBodySchema } },
        async (request, reply) => {
          try {
            const user = await options.invites!.accept(
              request.body.code,
              request.body.password,
            );
            return reply.code(201).send({ user });
          } catch (error) {
            if (hasErrorName(error, "InvalidInviteError")) {
              return reply
                .code(400)
                .send(
                  applicationError(
                    request.id,
                    "INVITE_INVALID",
                    "Invite code is invalid, expired, or already used",
                    false,
                  ),
                );
            }
            if (hasErrorName(error, "UserEmailConflictError")) {
              return reply
                .code(409)
                .send(
                  applicationError(
                    request.id,
                    "USER_EMAIL_CONFLICT",
                    "A user with this email already exists",
                    false,
                  ),
                );
            }
            if (error instanceof Error && error.name === "ZodError") {
              return reply
                .code(400)
                .send(
                  applicationError(
                    request.id,
                    "VALIDATION_FAILED",
                    "Invalid invite code or password",
                    false,
                  ),
                );
            }
            throw error;
          }
        },
      );
    }

    app.post("/api/v1/auth/logout", async (request, reply) => {
      const token = request.cookies[AUTH_COOKIE_NAME];
      // The logout flush marks the end of a work session: memory
      // consolidation for everything this user left pending is expedited
      // fire-and-forget so the next login starts from a fresh handoff.
      const userId = token
        ? await auth
            .authenticate(token)
            .then((context) => context.userId)
            .catch(() => undefined)
        : undefined;
      await auth.logout(token);
      reply.clearCookie(AUTH_COOKIE_NAME, cookieOptions(isProduction));
      if (userId) {
        void options.memory?.expedite?.(userId).catch(() => undefined);
      }
      return reply.code(204).send();
    });

    app.get("/api/v1/me", async (request) => ({ user: request.auth }));

    app.get("/api/v1/capabilities", async () => ({
      ...featureCapabilities,
      memoryStores: { available: !!options.memory },
      personalAgentModels: [
        ...(options.capabilities?.personalAgentModels ?? []),
      ],
    }));

    if (options.runs) {
      const runs = options.runs;
      app.get<{ Params: { id: string } }>(
        "/api/v1/runs/:id",
        { schema: { params: uuidParamsSchema } },
        async (request, reply) => {
          try {
            const run = await runs.get(request.auth!.userId, request.params.id);
            return reply.send(publicRun(run));
          } catch (error) {
            if (hasErrorName(error, "ResourceNotFoundError")) {
              return reply.code(404).send(resourceNotFoundError(request.id));
            }
            throw error;
          }
        },
      );
    }

    if (options.sync) {
      const sync = options.sync;
      app.get("/api/v1/sync/snapshot", async (request) =>
        sync.snapshot(request.auth!.userId),
      );
      app.get<{ Querystring: { cursor: number; limit: number } }>(
        "/api/v1/sync/changes",
        { schema: { querystring: syncChangesQuerySchema } },
        async (request) =>
          sync.changes(
            request.auth!.userId,
            request.query.cursor,
            request.query.limit,
          ),
      );
    }

    if (options.assistant) {
      const assistant = options.assistant;
      app.get("/api/v1/assistant/profile", async (request) =>
        publicAssistant(await assistant.get(request.auth!.userId)),
      );
      app.patch<{
        Body: {
          displayName?: string;
          persona?: string;
          preferences?: Record<string, unknown>;
          expectedRevision?: number;
        };
      }>(
        "/api/v1/assistant/profile",
        { schema: { body: assistantProfileBodySchema } },
        async (request, reply) => {
          try {
            return reply.send(
              publicAssistant(
                await assistant.update(request.auth!.userId, request.body),
              ),
            );
          } catch (error) {
            if (hasErrorName(error, "AssistantProfileConflictError")) {
              return reply
                .code(409)
                .send(
                  applicationError(
                    request.id,
                    "ASSISTANT_PROFILE_CONFLICT",
                    "Assistant profile changed. Reload before editing.",
                    false,
                  ),
                );
            }
            if (hasErrorName(error, "ResourceNotFoundError")) {
              return reply.code(404).send(resourceNotFoundError(request.id));
            }
            throw error;
          }
        },
      );
    }

    if (options.automations) {
      const automations = options.automations;
      app.get("/api/v1/automations", async (request) => ({
        automations: (await automations.list(request.auth!.userId)).map(
          publicAutomation,
        ),
      }));
      app.post<{
        Body: {
          title: string;
          schedule: Record<string, unknown>;
          timezone: string;
        };
      }>(
        "/api/v1/automations",
        { schema: { body: automationBodySchema } },
        async (request, reply) => {
          try {
            const automation = await automations.create(
              request.auth!.userId,
              request.body,
            );
            return reply
              .code(201)
              .send({ automation: publicAutomation(automation) });
          } catch (error) {
            if (hasErrorName(error, "InvalidAutomationScheduleError")) {
              return reply
                .code(400)
                .send(
                  applicationError(
                    request.id,
                    "VALIDATION_FAILED",
                    error instanceof Error ? error.message : "Invalid schedule",
                    false,
                  ),
                );
            }
            throw error;
          }
        },
      );
      app.patch<{ Params: { id: string }; Body: { enabled: boolean } }>(
        "/api/v1/automations/:id",
        { schema: { params: uuidParamsSchema, body: automationPatchSchema } },
        async (request, reply) => {
          try {
            const automation = await automations.setEnabled(
              request.auth!.userId,
              request.params.id,
              request.body.enabled,
            );
            return reply.send({ automation: publicAutomation(automation) });
          } catch (error) {
            if (hasErrorName(error, "InvalidAutomationScheduleError")) {
              return reply
                .code(400)
                .send(
                  applicationError(
                    request.id,
                    "VALIDATION_FAILED",
                    error instanceof Error ? error.message : "Invalid schedule",
                    false,
                  ),
                );
            }
            throw error;
          }
        },
      );
      app.delete<{ Params: { id: string } }>(
        "/api/v1/automations/:id",
        { schema: { params: uuidParamsSchema } },
        async (request, reply) => {
          await automations.delete(request.auth!.userId, request.params.id);
          return reply.code(204).send();
        },
      );
    }

    if (options.memory) {
      const memory = options.memory;
      const pathProperty = {
        type: "string",
        minLength: 1,
        maxLength: 512,
      } as const;
      const pathBody = {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: { path: pathProperty },
      } as const;
      app.addHook("preValidation", async (request) => {
        const route = request.routeOptions.url ?? "";
        if (!route.startsWith("/api/v1/memory/") || request.body === undefined)
          return;
        const body = request.body as Record<string, unknown>;
        if (
          typeof body !== "object" ||
          body === null ||
          Array.isArray(body) ||
          (Object.hasOwn(body, "path") && typeof body.path !== "string") ||
          (Object.hasOwn(body, "content") &&
            typeof body.content !== "string") ||
          (Object.hasOwn(body, "expectedHash") &&
            typeof body.expectedHash !== "string") ||
          (Object.hasOwn(body, "protected") &&
            typeof body.protected !== "boolean") ||
          (Object.hasOwn(body, "autoDream") &&
            typeof body.autoDream !== "boolean")
        ) {
          throw Object.assign(new Error("Invalid memory payload type"), {
            name: "MemoryError",
            code: "MEMORY_INVALID",
          });
        }
      });
      // Check empty action bodies in the handler: requests with no body are valid.
      const emptyActionBody = (body: unknown) => {
        if (body === undefined) return;
        if (
          typeof body !== "object" ||
          body === null ||
          Array.isArray(body) ||
          Object.keys(body).length
        ) {
          throw Object.assign(new Error("Invalid memory action payload"), {
            name: "MemoryError",
            code: "MEMORY_INVALID",
          });
        }
      };
      app.get("/api/v1/memory", async (request) => {
        const result = await memory.list(request.auth!.userId);
        return {
          entries: result.entries.map(({ path, content }) => ({
            path,
            content,
            // Server-computed edit base: the browser must send this back as
            // expectedHash when saving, so a stale editor cannot silently
            // overwrite a concurrent update.
            hash: hashMemory(content),
          })),
          capacity: result.capacity,
          state: publicMemoryState(result.state),
          store: result.store,
          sessionCount: result.sessionCount,
        };
      });
      app.get("/api/v1/memory/status", async (request) =>
        publicMemoryState(await memory.status(request.auth!.userId)),
      );
      app.post<{
        Body: { path: string; content: string; expectedHash?: string };
      }>(
        "/api/v1/memory/entry",
        {
          schema: {
            body: {
              ...pathBody,
              required: ["path", "content"],
              properties: {
                path: pathProperty,
                content: { type: "string" },
                expectedHash: { type: "string" },
              },
            },
          },
        },
        async (request, reply) =>
          reply
            .code(202)
            .send(
              publicMemoryState(
                await memory.write(request.auth!.userId, request.body),
              ),
            ),
      );
      app.delete<{ Body: { path: string } }>(
        "/api/v1/memory/entry",
        { schema: { body: pathBody } },
        async (request, reply) =>
          reply
            .code(202)
            .send(
              publicMemoryState(
                await memory.remove(request.auth!.userId, request.body.path),
              ),
            ),
      );
      app.post<{ Body: { path: string; protected: boolean } }>(
        "/api/v1/memory/protect",
        {
          schema: {
            body: {
              ...pathBody,
              required: ["path", "protected"],
              properties: {
                path: pathProperty,
                protected: { type: "boolean" },
              },
            },
          },
        },
        async (request) => {
          await memory.protect(
            request.auth!.userId,
            request.body.path,
            request.body.protected,
          );
          return publicMemoryState(await memory.status(request.auth!.userId));
        },
      );
      // Consolidation is system-driven (autoDream monitor / capacity guard);
      // no manual dream/compress interface is exposed to users.
      app.post("/api/v1/memory/recover", async (request, reply) => {
        emptyActionBody(request.body);
        await memory.recover(request.auth!.userId);
        return reply
          .code(200)
          .send(publicMemoryState(await memory.status(request.auth!.userId)));
      });
      app.post("/api/v1/memory/cancel", async (request, reply) => {
        emptyActionBody(request.body);
        return reply
          .code(200)
          .send(publicMemoryState(await memory.cancel(request.auth!.userId)));
      });
      app.patch<{ Body: { autoDream: boolean } }>(
        "/api/v1/memory/settings",
        {
          schema: {
            body: {
              type: "object",
              additionalProperties: false,
              required: ["autoDream"],
              properties: { autoDream: { type: "boolean" } },
            },
          },
        },
        async (request) => {
          await memory.settings(request.auth!.userId, request.body.autoDream);
          return publicMemoryState(await memory.status(request.auth!.userId));
        },
      );
    }

    if (options.quotaUsage) {
      app.get("/api/v1/usage", async (request, reply) => {
        const summary = await options.quotaUsage!.getSummary(
          request.auth!.userId,
        );
        return reply.send({
          ...summary,
          period: {
            startsAt: summary.period.startsAt.toISOString(),
            endsAt: summary.period.endsAt.toISOString(),
          },
        });
      });
    }

    if (options.artifacts) {
      const artifacts = options.artifacts;

      app.post<{
        Params: { id: string };
        Body: Record<string, never>;
      }>(
        "/api/v1/sessions/:id/artifacts/sync",
        {
          schema: {
            params: uuidParamsSchema,
            body: emptyBodySchema,
          },
        },
        async (request, reply) => {
          const controller = new AbortController();
          const abort = () => controller.abort();
          request.raw.once("aborted", abort);
          reply.raw.once("close", abort);
          try {
            const synced = await artifacts.syncSession(request.params.id, {
              userId: request.auth!.userId,
              requestId: request.id,
              signal: controller.signal,
            });
            return reply.send({
              artifacts: synced.map(publicArtifact),
            });
          } catch (error) {
            return sendArtifactError(error, request, reply);
          } finally {
            request.raw.removeListener("aborted", abort);
            reply.raw.removeListener("close", abort);
          }
        },
      );

      app.get<{ Querystring: { sessionId?: string } }>(
        "/api/v1/artifacts",
        { schema: { querystring: listArtifactsQuerySchema } },
        async (request, reply) => {
          const records =
            request.query.sessionId === undefined
              ? await artifacts.list(request.auth!.userId)
              : await artifacts.list(
                  request.auth!.userId,
                  request.query.sessionId,
                );
          return reply.send({ artifacts: records.map(publicArtifact) });
        },
      );

      app.get<{ Params: { id: string } }>(
        "/api/v1/artifacts/:id/download",
        { schema: { params: uuidParamsSchema } },
        async (request, reply) => {
          const controller = new AbortController();
          const abort = () => controller.abort();
          request.raw.once("aborted", abort);
          reply.raw.once("close", abort);
          try {
            const download = await artifacts.download(
              request.params.id,
              request.auth!.userId,
              controller.signal,
            );
            const cleanup = () => {
              request.raw.removeListener("aborted", abort);
              reply.raw.removeListener("close", abort);
            };
            download.stream.once("close", cleanup);
            return reply
              .header("content-type", download.mimeType)
              .header("content-length", download.sizeBytes)
              .header("content-disposition", contentDisposition(download.name))
              .send(download.stream);
          } catch (error) {
            controller.abort();
            request.raw.removeListener("aborted", abort);
            reply.raw.removeListener("close", abort);
            return sendArtifactError(error, request, reply);
          }
        },
      );

      app.delete<{ Params: { id: string } }>(
        "/api/v1/artifacts/:id",
        { schema: { params: uuidParamsSchema } },
        async (request, reply) => {
          try {
            const artifact = await artifacts.requestDelete(
              request.params.id,
              request.auth!.userId,
            );
            return reply.code(202).send({
              id: artifact.id,
              deletionState: artifact.deletionState,
            });
          } catch (error) {
            return sendArtifactError(error, request, reply);
          }
        },
      );
    }

    if (options.inputs) {
      const inputs = options.inputs;
      if (options.fileReuse) {
        app.post<{ Params: { id: string } }>(
          "/api/v1/artifacts/:id/reuse",
          { schema: { params: uuidParamsSchema } },
          async (request, reply) => {
            const cancellation = inputCancellation(request, reply);
            try {
              const result = await options.fileReuse!.prepare(
                request.params.id,
                {
                  userId: request.auth!.userId,
                  requestId: request.id,
                  signal: cancellation.signal,
                },
              );
              return reply.code(201).send(publicInput(result));
            } catch (error) {
              return sendSessionError(error, request, reply);
            } finally {
              cancellation.close();
            }
          },
        );
      }
      app.post(
        "/api/v1/uploads",
        {
          schema: {
            headers: {
              type: "object",
              required: ["content-type"],
              properties: {
                "content-type": {
                  type: "string",
                  pattern: "^multipart/form-data(?:;|$)",
                },
              },
            },
          },
        },
        async (request, reply) => {
          const cancellation = inputCancellation(request, reply);
          try {
            let file:
              | {
                  name: string;
                  contentType: string;
                  bytes: Uint8Array;
                }
              | undefined;
            let invalid = false;
            for await (const part of request.parts()) {
              if (part.type !== "file" || file || part.fieldname !== "file") {
                invalid = true;
                if (part.type === "file") await part.toBuffer();
                continue;
              }
              file = {
                name: part.filename,
                contentType: part.mimetype,
                bytes: new Uint8Array(await part.toBuffer()),
              };
            }
            if (!file || invalid) {
              return reply
                .code(400)
                .send(
                  applicationError(
                    request.id,
                    "INVALID_MULTIPART",
                    "Exactly one file is required",
                    false,
                  ),
                );
            }
            const uploaded = await inputs.upload(file, {
              userId: request.auth!.userId,
              requestId: request.id,
              signal: cancellation.signal,
            });
            return reply.code(201).send(publicInput(uploaded));
          } catch (error) {
            if (
              error instanceof InvalidUploadNameError ||
              hasErrorName(error, "InvalidUploadNameError")
            ) {
              return reply
                .code(400)
                .send(
                  applicationError(
                    request.id,
                    "INVALID_UPLOAD_NAME",
                    "Invalid upload filename",
                    false,
                  ),
                );
            }
            return sendSessionError(error, request, reply);
          } finally {
            cancellation.close();
          }
        },
      );
    }

    if (options.sessions) {
      const sessions = options.sessions;
      const context = (request: FastifyRequest) => ({
        userId: request.auth!.userId,
        requestId: request.id,
      });

      app.post<{
        Body: {
          agentId: string;
          title?: string;
          uploadIds?: string[];
          temporary?: boolean;
          submissionId?: string;
          content?: string;
        };
      }>(
        "/api/v1/sessions",
        { schema: { body: createSessionBodySchema } },
        async (request, reply) => {
          try {
            const created = await sessions.create(
              {
                agentId: request.body.agentId,
                ...(request.body.submissionId
                  ? {
                      submissionId: request.body.submissionId,
                      content: request.body.content!,
                    }
                  : {}),
                ...(request.body.temporary !== undefined
                  ? { temporary: request.body.temporary }
                  : {}),
                ...(request.body.title !== undefined
                  ? { title: request.body.title.trim() }
                  : {}),
                ...(request.body.uploadIds !== undefined
                  ? { uploadIds: request.body.uploadIds }
                  : {}),
              },
              context(request),
            );
            return reply
              .code(request.body.submissionId ? 202 : 201)
              .send(publicSession(created));
          } catch (error) {
            return sendSessionError(error, request, reply);
          }
        },
      );

      app.post<{
        Params: { id: string; submissionId: string };
        Body: { sessionId: string };
      }>(
        "/api/v1/admin/users/:id/submissions/:submissionId/reconcile",
        {
          schema: {
            params: {
              type: "object",
              required: ["id", "submissionId"],
              properties: {
                id: { type: "string", format: "uuid" },
                submissionId: { type: "string", format: "uuid" },
              },
            },
            body: {
              type: "object",
              additionalProperties: false,
              required: ["sessionId"],
              properties: { sessionId: { type: "string", format: "uuid" } },
            },
          },
        },
        async (request, reply) => {
          try {
            if (!sessions.reconcileSubmission) return reply.code(404).send();
            const receipt = await sessions.reconcileSubmission(
              request.params.id,
              request.body.sessionId,
              request.params.submissionId,
              { userId: request.auth!.userId, requestId: request.id },
            );
            return reply.send(receipt);
          } catch (error) {
            return sendSessionError(error, request, reply);
          }
        },
      );

      app.get<{ Querystring: { archived?: boolean } }>(
        "/api/v1/sessions",
        { schema: { querystring: listSessionsQuerySchema } },
        async (request, reply) => {
          const records = await sessions.list(
            request.auth!.userId,
            request.query.archived ?? false,
          );
          return reply.send({ sessions: records.map(publicSession) });
        },
      );

      app.get<{ Params: { id: string } }>(
        "/api/v1/sessions/:id",
        { schema: { params: uuidParamsSchema } },
        async (request, reply) => {
          try {
            const record = await sessions.get(
              request.auth!.userId,
              request.params.id,
            );
            return reply.send(publicSession(record));
          } catch (error) {
            return sendSessionError(error, request, reply);
          }
        },
      );

      app.patch<{ Params: { id: string }; Body: { title: string } }>(
        "/api/v1/sessions/:id",
        {
          schema: {
            params: uuidParamsSchema,
            body: renameSessionBodySchema,
          },
        },
        async (request, reply) => {
          try {
            const session = await sessions.rename(
              request.params.id,
              request.body.title,
              context(request),
            );
            return reply.send(publicSession(session));
          } catch (error) {
            return sendSessionError(error, request, reply);
          }
        },
      );

      app.put<{ Params: { id: string }; Body: Record<string, never> }>(
        "/api/v1/sessions/:id/pin",
        { schema: { params: uuidParamsSchema, body: emptyBodySchema } },
        async (request, reply) => {
          try {
            const session = await sessions.setPinned(
              request.params.id,
              true,
              context(request),
            );
            return reply.send(publicSession(session));
          } catch (error) {
            return sendSessionError(error, request, reply);
          }
        },
      );

      app.delete<{ Params: { id: string } }>(
        "/api/v1/sessions/:id/pin",
        { schema: { params: uuidParamsSchema } },
        async (request, reply) => {
          try {
            const session = await sessions.setPinned(
              request.params.id,
              false,
              context(request),
            );
            return reply.send(publicSession(session));
          } catch (error) {
            return sendSessionError(error, request, reply);
          }
        },
      );

      app.post<{
        Params: { id: string };
        Body: Record<string, never>;
      }>(
        "/api/v1/sessions/:id/archive",
        {
          schema: {
            params: uuidParamsSchema,
            body: emptyBodySchema,
          },
        },
        async (request, reply) => {
          try {
            return reply.send(
              publicSession(
                await sessions.archive(request.params.id, request.auth!.userId),
              ),
            );
          } catch (error) {
            return sendSessionError(error, request, reply);
          }
        },
      );

      app.delete<{ Params: { id: string } }>(
        "/api/v1/sessions/:id/archive",
        { schema: { params: uuidParamsSchema } },
        async (request, reply) => {
          try {
            return reply.send(
              publicSession(
                await sessions.restore(request.params.id, request.auth!.userId),
              ),
            );
          } catch (error) {
            return sendSessionError(error, request, reply);
          }
        },
      );

      app.delete<{
        Params: { id: string };
        Body: { confirmation: "DELETE" };
      }>(
        "/api/v1/sessions/:id",
        {
          schema: {
            params: uuidParamsSchema,
            body: deleteSessionBodySchema,
          },
        },
        async (request, reply) => {
          try {
            const session = await sessions.requestDelete(
              request.params.id,
              request.auth!.userId,
            );
            return reply.code(202).send({
              id: session.id,
              deletionState: session.deletionState,
            });
          } catch (error) {
            return sendSessionError(error, request, reply);
          }
        },
      );

      app.get<{ Params: { id: string } }>(
        "/api/v1/sessions/:id/transcript",
        { schema: { params: uuidParamsSchema } },
        async (request, reply) => {
          const controller = new AbortController();
          const abort = () => controller.abort();
          request.raw.once("aborted", abort);
          reply.raw.once("close", abort);
          try {
            return reply.send({
              events: await sessions.transcriptEvents(
                request.params.id,
                context(request),
                controller.signal,
              ),
            });
          } catch (error) {
            controller.abort();
            return sendSessionError(error, request, reply);
          } finally {
            request.raw.removeListener("aborted", abort);
            reply.raw.removeListener("close", abort);
          }
        },
      );

      app.get<{ Params: { id: string } }>(
        "/api/v1/sessions/:id/events",
        { schema: { params: uuidParamsSchema } },
        async (request, reply) => {
          const releaseEventStream = acquireEventStream(
            request.auth!.userId,
            request.params.id,
          );
          if (!releaseEventStream) {
            return reply
              .header("retry-after", 1)
              .code(429)
              .send(
                applicationError(
                  request.id,
                  "RATE_LIMITED",
                  "Too many active event streams",
                  true,
                ),
              );
          }
          const controller = new AbortController();
          const releaseAuthStream = registerAuthStream(
            request.auth!.userId,
            controller,
          );
          // Release-0 revocation recheck (P0-03): an established stream must
          // stop pushing within the bounded window after its login session is
          // revoked. The timer runs independently of the event loop below, so
          // history replay, an idle upstream, and write backpressure all stay
          // covered. Any failure — revoked session, disabled user, database
          // outage, or a check that exceeds its budget — closes the stream:
          // fail closed, never keep streaming on an unverifiable session.
          const recheckAuth = options.auth;
          const recheckIntervalMs = options.sseAuthRecheckIntervalMs ?? 15_000;
          const recheckBudgetMs = options.sseAuthRecheckBudgetMs ?? 2_000;
          const recheckToken = request.cookies[AUTH_COOKIE_NAME];
          let recheckTimer: NodeJS.Timeout | undefined;
          let recheckBudgetTimer: NodeJS.Timeout | undefined;
          let recheckInFlight = false;
          let terminated = false;
          const stopRecheck = () => {
            if (recheckTimer) clearInterval(recheckTimer);
            recheckTimer = undefined;
            if (recheckBudgetTimer) clearTimeout(recheckBudgetTimer);
            recheckBudgetTimer = undefined;
          };
          const terminate = () => {
            if (terminated) return false;
            terminated = true;
            stopRecheck();
            releaseAuthStream();
            controller.abort();
            releaseEventStream();
            return true;
          };
          const close = () => void terminate();
          reply.raw.once("close", close);
          const terminateForAuth = () => {
            // Abort the upstream and release capacity before the courtesy
            // control write. Only the cleanup winner may write or close.
            if (!terminate()) return;
            if (!reply.raw.destroyed && !reply.raw.writableEnded) {
              let controlSettled = false;
              const finishControl = () => {
                if (controlSettled) return;
                controlSettled = true;
                clearTimeout(graceTimer);
                if (!reply.raw.destroyed && !reply.raw.writableEnded) {
                  reply.raw.destroy();
                }
              };
              const graceTimer = setTimeout(finishControl, 250);
              graceTimer.unref?.();
              try {
                reply.raw.write(
                  "event: auth_invalid\ndata: {}\n\n",
                  finishControl,
                );
              } catch {
                finishControl();
              }
              return;
            }
            if (!reply.raw.destroyed) reply.raw.destroy();
          };
          if (recheckAuth) {
            recheckTimer = setInterval(() => {
              if (terminated || recheckInFlight) return;
              recheckInFlight = true;
              const budget = setTimeout(() => {
                if (recheckBudgetTimer === budget) {
                  recheckBudgetTimer = undefined;
                }
                terminateForAuth();
              }, recheckBudgetMs);
              recheckBudgetTimer = budget;
              budget.unref?.();
              recheckAuth
                .authenticate(recheckToken)
                .then(
                  () => {
                    clearTimeout(budget);
                    if (recheckBudgetTimer === budget) {
                      recheckBudgetTimer = undefined;
                    }
                  },
                  () => {
                    clearTimeout(budget);
                    if (recheckBudgetTimer === budget) {
                      recheckBudgetTimer = undefined;
                    }
                    terminateForAuth();
                  },
                )
                .finally(() => {
                  if (!terminated) recheckInFlight = false;
                });
            }, recheckIntervalMs);
            recheckTimer.unref?.();
          }
          try {
            let opened: {
              session: SessionRecord;
              events: AsyncIterable<UiEvent>;
            };
            try {
              const eventContext = context(request);
              opened =
                options.eventSource === "local" && sessions.openStoredEvents
                  ? await sessions.openStoredEvents(
                      request.params.id,
                      eventContext,
                      controller.signal,
                    )
                  : await sessions.openEvents(
                      request.params.id,
                      eventContext,
                      controller.signal,
                    );
            } catch (error) {
              reply.raw.removeListener("close", close);
              if (!terminate()) return reply;
              return sendSessionError(error, request, reply);
            }
            if (terminated) return reply;
            if (opened.session.arkSessionId.startsWith("pending:")) {
              reply.raw.removeListener("close", close);
              terminate();
              return reply
                .code(409)
                .send(
                  applicationError(
                    request.id,
                    "SESSION_BUSY",
                    "Session delivery is pending",
                    true,
                  ),
                );
            }
            // Snapshot from the record openEvents already loaded. Replayed
            // session.status_* events correct any lag in this state.
            const ready = {
              sessionId: opened.session.id,
              status: opened.session.status,
              agentName: opened.session.agentName,
              agentVersion: opened.session.agentVersion,
            };

            reply.hijack();
            reply.raw.writeHead(200, {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache, no-transform",
              connection: "keep-alive",
            });
            try {
              if (
                !(await writeSseChunk(
                  reply.raw,
                  `event: ready\ndata: ${JSON.stringify(ready)}\n\n`,
                  controller.signal,
                ))
              ) {
                return reply;
              }
              for await (const event of opened.events) {
                if (controller.signal.aborted || reply.raw.destroyed) break;
                const id = event.id.replace(/[\r\n]/g, "");
                const sourceType = event.sourceType.replace(/[\r\n]/g, "");
                if (
                  !(await writeSseChunk(
                    reply.raw,
                    `id: ${id}\nevent: ${sourceType}\ndata: ${JSON.stringify(event)}\n\n`,
                    controller.signal,
                  ))
                ) {
                  break;
                }
              }
            } finally {
              reply.raw.removeListener("close", close);
              terminate();
              if (!reply.raw.destroyed && !reply.raw.writableEnded) {
                reply.raw.end();
              }
            }
          } finally {
            terminate();
          }
          return reply;
        },
      );

      app.post<{
        Params: { id: string };
        Body: { content: string; submissionId?: string };
      }>(
        "/api/v1/sessions/:id/messages",
        {
          schema: {
            params: uuidParamsSchema,
            body: sendMessageBodySchema,
          },
        },
        async (request, reply) => {
          try {
            const accepted = await sessions.sendMessage(
              request.params.id,
              {
                content: request.body.content.trim(),
                ...(request.body.submissionId
                  ? { submissionId: request.body.submissionId }
                  : {}),
              },
              context(request),
            );
            return reply.code(202).send(accepted);
          } catch (error) {
            return sendSessionError(error, request, reply);
          }
        },
      );

      app.post<{
        Params: { id: string };
        Body: Record<string, never>;
      }>(
        "/api/v1/sessions/:id/interrupt",
        {
          schema: {
            params: uuidParamsSchema,
            body: emptyBodySchema,
          },
        },
        async (request, reply) => {
          try {
            const accepted = await sessions.interrupt(
              request.params.id,
              context(request),
            );
            return reply.code(202).send(accepted);
          } catch (error) {
            return sendSessionError(error, request, reply);
          }
        },
      );
    }

    if (options.userAgents) {
      const userAgents = options.userAgents;
      const context = (request: FastifyRequest) => ({
        userId: request.auth!.userId,
        requestId: request.id,
      });
      const resolveSkillBindings = async (
        userId: string,
        skillIds: string[] | undefined,
      ): Promise<AgentSkillBinding[] | undefined> => {
        if (skillIds === undefined) return undefined;
        if (!options.skills) {
          throw new Error("Skill service is not configured");
        }
        return options.skills.resolveBindings(userId, skillIds);
      };

      app.get("/api/v1/agents", async (request, reply) => {
        const result = await userAgents.list(request.auth!.userId);
        return reply.send({
          agents: result.agents.map((agent) => publicUserAgent(agent)),
          selection: result.selection,
          blocker: result.blocker,
        });
      });

      app.get<{ Params: { id: string } }>(
        "/api/v1/agents/:id",
        { schema: { params: uuidParamsSchema } },
        async (request, reply) => {
          try {
            const agent = await userAgents.get(
              request.auth!.userId,
              request.params.id,
            );
            return reply.send(publicUserAgent(agent, true));
          } catch (error) {
            return sendAdminError(error, request, reply);
          }
        },
      );

      app.post<{
        Body: {
          name: string;
          description?: string;
          modelId: string;
          systemPrompt: string;
          skillIds?: string[];
        };
      }>(
        "/api/v1/agents",
        { schema: { body: createPersonalAgentBodySchema } },
        async (request, reply) => {
          try {
            const skills = await resolveSkillBindings(
              request.auth!.userId,
              request.body.skillIds,
            );
            const created = await userAgents.create(
              {
                name: request.body.name.trim(),
                description: request.body.description?.trim() ?? "",
                modelId: request.body.modelId.trim(),
                systemPrompt: request.body.systemPrompt,
                ...(skills !== undefined ? { skills } : {}),
              },
              context(request),
            );
            // Re-read so the response carries Skill summaries like the list.
            let record: AvailableAgentRecord | undefined;
            try {
              record = await userAgents.get(request.auth!.userId, created.id);
            } catch {
              record = undefined;
            }
            return reply
              .code(201)
              .send(publicUserAgent(record ?? created, true));
          } catch (error) {
            return sendAdminError(error, request, reply);
          }
        },
      );

      app.patch<{
        Params: { id: string };
        Body: {
          name?: string;
          description?: string;
          modelId?: string;
          systemPrompt?: string;
          skillIds?: string[];
          arkVersion: string;
        };
      }>(
        "/api/v1/agents/:id",
        {
          schema: {
            params: uuidParamsSchema,
            body: updatePersonalAgentBodySchema,
          },
        },
        async (request, reply) => {
          try {
            const skills = await resolveSkillBindings(
              request.auth!.userId,
              request.body.skillIds,
            );
            const updated = await userAgents.update(
              request.params.id,
              {
                ...(request.body.name !== undefined
                  ? { name: request.body.name.trim() }
                  : {}),
                ...(request.body.description !== undefined
                  ? { description: request.body.description.trim() }
                  : {}),
                ...(request.body.modelId !== undefined
                  ? { modelId: request.body.modelId.trim() }
                  : {}),
                ...(request.body.systemPrompt !== undefined
                  ? { systemPrompt: request.body.systemPrompt }
                  : {}),
                ...(skills !== undefined ? { skills } : {}),
                arkVersion: request.body.arkVersion,
              },
              context(request),
            );
            let record: AvailableAgentRecord | undefined;
            try {
              record = await userAgents.get(request.auth!.userId, updated.id);
            } catch {
              record = undefined;
            }
            return reply.send(publicUserAgent(record ?? updated, true));
          } catch (error) {
            return sendAdminError(error, request, reply);
          }
        },
      );

      app.delete<{ Params: { id: string } }>(
        "/api/v1/agents/:id",
        { schema: { params: uuidParamsSchema } },
        async (request, reply) => {
          try {
            await userAgents.delete(request.params.id, context(request));
            return reply.code(204).send();
          } catch (error) {
            return sendAdminError(error, request, reply);
          }
        },
      );
    }

    if (options.skills) {
      const skills = options.skills;
      const context = (request: FastifyRequest) => ({
        userId: request.auth!.userId,
        requestId: request.id,
      });

      /** Per-request limits: a Skill package may exceed the 20 MB uploads cap. */
      const skillUploadLimits = {
        files: 1,
        fields: 5,
        fileSize: 50 * 1024 * 1024,
      };

      const readSkillUpload = async (
        request: FastifyRequest,
        reply: FastifyReply,
      ) => {
        let file:
          { name: string; contentType: string; bytes: Uint8Array } | undefined;
        const fields: Record<string, string> = {};
        let invalid = false;
        let truncated = false;
        for await (const part of request.parts({ limits: skillUploadLimits })) {
          if (part.type !== "file") {
            if (
              part.fieldname === "displayTitle" ||
              part.fieldname === "description"
            ) {
              if (typeof part.value === "string" && !fields[part.fieldname]) {
                fields[part.fieldname] = part.value;
              }
            } else {
              invalid = true;
            }
            continue;
          }
          if (part.fieldname !== "file" || file) {
            invalid = true;
            await part.toBuffer();
            continue;
          }
          const bytes = new Uint8Array(await part.toBuffer());
          if (part.file.truncated) {
            truncated = true;
            continue;
          }
          file = { name: part.filename, contentType: part.mimetype, bytes };
        }
        if (truncated) {
          reply
            .code(413)
            .send(
              applicationError(
                request.id,
                "INVALID_SKILL_PACKAGE",
                "Skill packages must be .zip archives up to 50 MB",
                false,
              ),
            );
          return undefined;
        }
        if (invalid) {
          reply
            .code(400)
            .send(
              applicationError(
                request.id,
                "INVALID_MULTIPART",
                "Exactly one .zip file part is required, with optional displayTitle and description fields",
                false,
              ),
            );
          return undefined;
        }
        return { file, fields };
      };

      app.get<{ Querystring: { scope?: string; q?: string } }>(
        "/api/v1/skills",
        async (request, reply) => {
          const scope = request.query.scope === "preset" ? "preset" : "custom";
          const records = await skills.list(request.auth!.userId, {
            scope,
            search: request.query.q,
          });
          return reply.send({
            skills: records.map(publicSkill),
            scope,
          });
        },
      );

      app.post("/api/v1/skills", async (request, reply) => {
        const upload = await readSkillUpload(request, reply);
        if (upload === undefined) return reply;
        if (!upload.file) {
          return reply
            .code(400)
            .send(
              applicationError(
                request.id,
                "INVALID_MULTIPART",
                "A .zip skill package is required",
                false,
              ),
            );
        }
        try {
          const { skill, defaultAgentSync } = await skills.upload(
            {
              file: upload.file,
              displayTitle: upload.fields.displayTitle,
              description: upload.fields.description,
            },
            context(request),
          );
          return reply.code(201).send({
            ...publicSkill(skill),
            defaultAgentSync,
          });
        } catch (error) {
          return sendAdminError(error, request, reply);
        }
      });

      app.patch<{ Params: { id: string } }>(
        "/api/v1/skills/:id",
        { schema: { params: uuidParamsSchema } },
        async (request, reply) => {
          const upload = await readSkillUpload(request, reply);
          if (upload === undefined) return reply;
          try {
            const { skill, defaultAgentSync } = await skills.update(
              request.params.id,
              {
                ...(upload.file ? { file: upload.file } : {}),
                displayTitle: upload.fields.displayTitle,
                description: upload.fields.description,
              },
              context(request),
            );
            return reply.send({
              ...publicSkill(skill),
              defaultAgentSync,
            });
          } catch (error) {
            return sendAdminError(error, request, reply);
          }
        },
      );

      app.delete<{ Params: { id: string } }>(
        "/api/v1/skills/:id",
        { schema: { params: uuidParamsSchema } },
        async (request, reply) => {
          try {
            const result = await skills.delete(
              request.params.id,
              context(request),
            );
            return reply.code(200).send({ defaultAgentSync: result });
          } catch (error) {
            return sendAdminError(error, request, reply);
          }
        },
      );
    }

    if (options.admin) {
      const admin = options.admin;
      const context = (request: FastifyRequest) => ({
        adminId: request.auth!.userId,
        requestId: request.id,
      });

      app.get("/api/v1/admin/platform-agents", async (_request, reply) => {
        const agents = await admin.listPlatformAgents();
        return reply.send({ agents: agents.map(publicAgent) });
      });

      app.get("/api/v1/admin/user-agents", async (_request, reply) => {
        const agents = await admin.listUserAgents();
        return reply.send({ agents: agents.map(adminUserAgent) });
      });

      app.post<{
        Body: {
          name: string;
          description?: string;
          modelId: string;
          systemPrompt: string;
        };
      }>(
        "/api/v1/admin/platform-agents",
        { schema: { body: createPlatformAgentBodySchema } },
        async (_request, reply) => {
          return reply
            .code(405)
            .header("Allow", "GET")
            .send({
              error: {
                code: "SYSTEM_AGENTS_READ_ONLY",
                message:
                  "System Agents are configured through SYSTEM_AGENT_IDS in .env.",
                retryable: false,
              },
            });
        },
      );

      app.patch<{
        Params: { id: string };
        Body: {
          name?: string;
          description?: string;
          modelId?: string;
          systemPrompt?: string;
          arkVersion?: string;
          status?: "active" | "disabled";
        };
      }>(
        "/api/v1/admin/platform-agents/:id",
        {
          schema: {
            params: uuidParamsSchema,
            body: updatePlatformAgentBodySchema,
          },
        },
        async (_request, reply) => {
          return reply
            .code(405)
            .header("Allow", "GET")
            .send({
              error: {
                code: "SYSTEM_AGENTS_READ_ONLY",
                message:
                  "System Agents are configured through SYSTEM_AGENT_IDS in .env.",
                retryable: false,
              },
            });
        },
      );

      app.delete<{ Params: { id: string } }>(
        "/api/v1/admin/platform-agents/:id",
        { schema: { params: uuidParamsSchema } },
        async (_request, reply) => {
          return reply
            .code(405)
            .header("Allow", "GET")
            .send({
              error: {
                code: "SYSTEM_AGENTS_READ_ONLY",
                message:
                  "System Agents are configured through SYSTEM_AGENT_IDS in .env.",
                retryable: false,
              },
            });
        },
      );

      app.get<{
        Querystring: { cursor?: string; limit?: number; q?: string };
      }>(
        "/api/v1/admin/users",
        { schema: { querystring: listAdminUsersQuerySchema } },
        async (request, reply) => {
          const { before, invalid } = decodeUserListCursor(
            request.query.cursor,
          );
          if (invalid) {
            return reply
              .code(400)
              .send(
                applicationError(
                  request.id,
                  "VALIDATION_FAILED",
                  "Invalid pagination cursor",
                  false,
                ),
              );
          }
          const search = request.query.q?.trim();
          const page = await admin.listUsers({
            limit: request.query.limit ?? 50,
            search: search ? search : null,
            before,
          });
          return reply.send({
            users: page.users.map((user) => ({
              id: user.id,
              email: user.email,
              role: user.role,
              status: user.status,
              hasPassword: user.hasPassword,
              defaultAgentId: user.defaultAgentId,
              createdAt: user.createdAt.toISOString(),
              quota: user.quota,
            })),
            ...(page.nextCursor
              ? {
                  nextCursor: encodePageCursor({
                    createdAt: page.nextCursor.createdAt,
                    id: page.nextCursor.id,
                  }),
                }
              : {}),
          });
        },
      );

      app.post<{
        Body: { email: string; password: string; role?: "user" | "admin" };
      }>(
        "/api/v1/admin/users",
        { schema: { body: createUserBodySchema } },
        async (request, reply) => {
          try {
            const created = await admin.createUser(
              request.body,
              context(request),
            );
            return reply.code(201).send(created);
          } catch (error) {
            return sendAdminError(error, request, reply);
          }
        },
      );

      app.post<{ Params: { id: string }; Body: { password: string } }>(
        "/api/v1/admin/users/:id/password",
        { schema: { params: uuidParamsSchema, body: resetPasswordBodySchema } },
        async (request, reply) => {
          try {
            await admin.resetUserPassword(
              request.params.id,
              request.body.password,
              context(request),
            );
            closeAuthStreamsForUser(request.params.id);
            return reply.code(204).send();
          } catch (error) {
            return sendAdminError(error, request, reply);
          }
        },
      );

      app.patch<{
        Params: { id: string };
        Body: { status: "active" | "disabled" };
      }>(
        "/api/v1/admin/users/:id/status",
        { schema: { params: uuidParamsSchema, body: userStatusBodySchema } },
        async (request, reply) => {
          try {
            const result = await admin.setUserStatus(
              request.params.id,
              request.body.status,
              context(request),
            );
            if (request.body.status === "disabled") {
              closeAuthStreamsForUser(request.params.id);
            }
            return reply.send({
              status: result.to,
              revokedSessions: result.revokedSessions,
            });
          } catch (error) {
            return sendAdminError(error, request, reply);
          }
        },
      );

      app.patch<{
        Params: { id: string };
        Body: { role: "user" | "admin" };
      }>(
        "/api/v1/admin/users/:id/role",
        { schema: { params: uuidParamsSchema, body: userRoleBodySchema } },
        async (request, reply) => {
          try {
            const result = await admin.setUserRole(
              request.params.id,
              request.body.role,
              context(request),
            );
            closeAuthStreamsForUser(request.params.id);
            return reply.send({
              role: result.to,
              revokedSessions: result.revokedSessions,
            });
          } catch (error) {
            return sendAdminError(error, request, reply);
          }
        },
      );

      app.post<{ Params: { id: string }; Body: Record<string, never> }>(
        "/api/v1/admin/users/:id/sessions/revoke",
        { schema: { params: uuidParamsSchema, body: emptyBodySchema } },
        async (request, reply) => {
          try {
            const result = await admin.revokeUserSessions(
              request.params.id,
              context(request),
            );
            closeAuthStreamsForUser(request.params.id);
            return reply.send({ revokedSessions: result.revokedSessions });
          } catch (error) {
            return sendAdminError(error, request, reply);
          }
        },
      );

      app.put<{
        Params: { id: string };
        Body: { platformAgentId: string };
      }>(
        "/api/v1/admin/users/:id/default-agent",
        {
          schema: {
            params: uuidParamsSchema,
            body: defaultAgentBodySchema,
          },
        },
        async (request, reply) => {
          try {
            const assignment = await admin.assignDefaultAgent(
              request.params.id,
              request.body.platformAgentId,
              context(request),
            );
            return reply.send({
              userId: assignment.userId,
              platformAgentId: assignment.platformAgentId,
              assignedAt: assignment.assignedAt.toISOString(),
            });
          } catch (error) {
            return sendAdminError(error, request, reply);
          }
        },
      );

      app.put<{
        Params: { id: string };
        Body: {
          personalAgentLimit?: number | null;
          concurrentSessionLimit?: number | null;
          dailySessionLimit?: number | null;
          monthlyTokenLimit?: number | null;
        };
      }>(
        "/api/v1/admin/users/:id/quota",
        { schema: { params: uuidParamsSchema, body: quotaBodySchema } },
        async (request, reply) => {
          try {
            const quota = await admin.updateUserQuota(
              request.params.id,
              request.body,
              context(request),
            );
            return reply.send({
              userId: quota.userId,
              personalAgentLimit: quota.personalAgentLimit,
              concurrentSessionLimit: quota.concurrentSessionLimit,
              dailySessionLimit: quota.dailySessionLimit,
              monthlyTokenLimit: quota.monthlyTokenLimit,
              inherited: quota.inherited,
            });
          } catch (error) {
            return sendAdminError(error, request, reply);
          }
        },
      );
    }

    if (options.adminUserDetail) {
      const adminUserDetail = options.adminUserDetail;

      app.get<{ Params: { id: string } }>(
        "/api/v1/admin/users/:id",
        { schema: { params: uuidParamsSchema } },
        async (request, reply) => {
          try {
            const detail = await adminUserDetail.getDetail(request.params.id, {
              adminId: request.auth!.userId,
              requestId: request.id,
            });
            return reply.send({
              ...detail,
              period: {
                startsAt: detail.period.startsAt.toISOString(),
                endsAt: detail.period.endsAt.toISOString(),
              },
            });
          } catch (error) {
            return sendAdminError(error, request, reply);
          }
        },
      );

      app.get<{
        Params: { id: string };
        Querystring: { cursor?: string; limit?: number };
      }>(
        "/api/v1/admin/users/:id/sessions",
        {
          schema: {
            params: uuidParamsSchema,
            querystring: listAdminUserSessionsQuerySchema,
          },
        },
        async (request, reply) => {
          const { before, invalid } = decodeUserListCursor(
            request.query.cursor,
          );
          if (invalid) {
            return reply
              .code(400)
              .send(
                applicationError(
                  request.id,
                  "VALIDATION_FAILED",
                  "Invalid pagination cursor",
                  false,
                ),
              );
          }
          const page = await adminUserDetail.listSessions(request.params.id, {
            limit: request.query.limit ?? 50,
            before,
          });
          return reply.send({
            sessions: page.sessions.map((session) => ({
              id: session.id,
              title: session.title,
              status: session.status,
              agentKind: session.agentKind,
              agentName: session.agentName,
              agentVersion: session.agentVersion,
              createdAt: session.createdAt.toISOString(),
              lastEventAt: session.lastEventAt?.toISOString() ?? null,
              archivedAt: session.archivedAt?.toISOString() ?? null,
              deletionState: session.deletionState,
              tokens: session.tokens,
            })),
            ...(page.nextCursor
              ? {
                  nextCursor: encodePageCursor({
                    createdAt: page.nextCursor.createdAt,
                    id: page.nextCursor.id,
                  }),
                }
              : {}),
          });
        },
      );
    }

    if (options.audit) {
      const audit = options.audit;

      app.get<{
        Params: { id: string };
        Querystring: { cursor?: string; limit?: number };
      }>(
        "/api/v1/admin/users/:id/audit",
        {
          schema: {
            params: uuidParamsSchema,
            querystring: listAdminUserSessionsQuerySchema,
          },
        },
        async (request, reply) => {
          const { before, invalid } = decodeAuditCursor(request.query.cursor);
          if (invalid) {
            return reply
              .code(400)
              .send(
                applicationError(
                  request.id,
                  "VALIDATION_FAILED",
                  "Invalid pagination cursor",
                  false,
                ),
              );
          }
          const page = await audit.listForUser(request.params.id, {
            limit: request.query.limit ?? 50,
            before,
          });
          return reply.send({
            entries: page.entries.map((entry) => ({
              id: entry.id,
              actorUserId: entry.actorUserId,
              actorEmail: entry.actorEmail,
              ownerUserId: entry.ownerUserId,
              ownerEmail: entry.ownerEmail,
              action: entry.action,
              resourceType: entry.resourceType,
              resourceId: entry.resourceId,
              result: entry.result,
              errorCode: entry.errorCode,
              requestId: entry.requestId,
              arkRequestId: entry.arkRequestId,
              metadata: entry.metadata ?? null,
              createdAt: entry.createdAt.toISOString(),
            })),
            ...(page.nextCursor
              ? {
                  nextCursor: encodePageCursor({
                    createdAt: page.nextCursor.createdAt,
                    id: page.nextCursor.id,
                  }),
                }
              : {}),
          });
        },
      );
    }

    if (options.adminUsage) {
      const adminUsage = options.adminUsage;

      app.get<{ Querystring: { cursor?: string; limit?: number } }>(
        "/api/v1/admin/usage/overview",
        { schema: { querystring: listAdminUsageQuerySchema } },
        async (request, reply) => {
          const { before, invalid } = decodeUsageCursor(request.query.cursor);
          if (invalid) {
            return reply
              .code(400)
              .send(
                applicationError(
                  request.id,
                  "VALIDATION_FAILED",
                  "Invalid pagination cursor",
                  false,
                ),
              );
          }
          const overview = await adminUsage.overview({
            limit: request.query.limit ?? 50,
            before,
          });
          return reply.send({
            period: {
              startsAt: overview.period.startsAt.toISOString(),
              endsAt: overview.period.endsAt.toISOString(),
            },
            totals: overview.totals,
            users: overview.users,
            ...(overview.nextCursor
              ? {
                  nextCursor: encodePageCursor({
                    tokens: overview.nextCursor.tokens,
                    userId: overview.nextCursor.userId,
                  }),
                }
              : {}),
          });
        },
      );

      app.get("/api/v1/admin/usage/agents", async (_request, reply) => {
        const usage = await adminUsage.byAgents();
        return reply.send(usage);
      });
    }

    if (options.quotaPolicy) {
      const quotaPolicy = options.quotaPolicy;
      const context = (request: FastifyRequest) => ({
        adminId: request.auth!.userId,
        requestId: request.id,
      });

      app.get("/api/v1/admin/quota-policy", async (_request, reply) => {
        const policy = await quotaPolicy.getDefault();
        if (!policy) {
          return reply.code(404).send(resourceNotFoundError(_request.id));
        }
        return reply.send({
          personalAgentLimit: policy.personalAgentLimit,
          concurrentSessionLimit: policy.concurrentSessionLimit,
          dailySessionLimit: policy.dailySessionLimit,
          monthlyTokenLimit: policy.monthlyTokenLimit,
          mode: policy.mode,
          version: policy.version,
          updatedBy: policy.updatedBy,
          updatedAt: policy.updatedAt.toISOString(),
        });
      });

      app.put<{
        Body: {
          personalAgentLimit: number;
          concurrentSessionLimit: number;
          dailySessionLimit: number;
          monthlyTokenLimit: number;
          mode?: "enforced" | "unlimited";
        };
      }>(
        "/api/v1/admin/quota-policy",
        { schema: { body: quotaPolicyBodySchema } },
        async (request, reply) => {
          try {
            const result = await quotaPolicy.updateDefault(
              request.body,
              context(request),
            );
            return reply.send({
              personalAgentLimit: result.updated.personalAgentLimit,
              concurrentSessionLimit: result.updated.concurrentSessionLimit,
              dailySessionLimit: result.updated.dailySessionLimit,
              monthlyTokenLimit: result.updated.monthlyTokenLimit,
              mode: result.updated.mode,
              version: result.updated.version,
              updatedBy: result.updated.updatedBy,
              updatedAt: result.updated.updatedAt.toISOString(),
            });
          } catch (error) {
            return sendAdminError(error, request, reply);
          }
        },
      );
    }

    if (options.invites) {
      const invites = options.invites;
      app.get("/api/v1/admin/invites", async (_request, reply) => {
        const rows = await invites.list();
        return reply.send({ invites: rows.map(publicInvite) });
      });
      app.post<{ Body: { email: string; expiresInDays?: number } }>(
        "/api/v1/admin/invites",
        { schema: { body: createInviteBodySchema } },
        async (request, reply) => {
          try {
            const result = await invites.create(
              request.auth!.userId,
              request.body,
            );
            return reply.code(201).send({
              invite: publicInvite(result.invite),
              code: result.code,
            });
          } catch (error) {
            return sendAdminError(error, request, reply);
          }
        },
      );
      app.post<{ Params: { id: string } }>(
        "/api/v1/admin/invites/:id/revoke",
        { schema: { params: uuidParamsSchema } },
        async (request, reply) => {
          try {
            return reply.send({
              invite: publicInvite(
                await invites.revoke(request.auth!.userId, request.params.id),
              ),
            });
          } catch (error) {
            return sendAdminError(error, request, reply);
          }
        },
      );
    }

    if (options.audit) {
      const audit = options.audit;

      app.get<{
        Querystring: {
          since?: string;
          until?: string;
          actorId?: string;
          action?: string;
          resourceType?: string;
          resourceId?: string;
          result?: "succeeded" | "failed";
          cursor?: string;
          limit?: number;
        };
      }>(
        "/api/v1/admin/audit-logs",
        { schema: { querystring: listAuditLogsQuerySchema } },
        async (request, reply) => {
          const { before, invalid } = decodeAuditCursor(request.query.cursor);
          if (invalid) {
            return reply
              .code(400)
              .send(
                applicationError(
                  request.id,
                  "VALIDATION_FAILED",
                  "Invalid pagination cursor",
                  false,
                ),
              );
          }
          const page = await audit.list({
            since: request.query.since,
            until: request.query.until,
            actorId: request.query.actorId,
            action: request.query.action,
            resourceType: request.query.resourceType,
            resourceId: request.query.resourceId,
            result: request.query.result,
            limit: request.query.limit ?? 50,
            before,
          });
          return reply.send({
            entries: page.entries.map((entry) => ({
              id: entry.id,
              actorUserId: entry.actorUserId,
              actorEmail: entry.actorEmail,
              ownerUserId: entry.ownerUserId,
              ownerEmail: entry.ownerEmail,
              action: entry.action,
              resourceType: entry.resourceType,
              resourceId: entry.resourceId,
              result: entry.result,
              errorCode: entry.errorCode,
              requestId: entry.requestId,
              arkRequestId: entry.arkRequestId,
              metadata: entry.metadata ?? null,
              createdAt: entry.createdAt.toISOString(),
            })),
            ...(page.nextCursor
              ? {
                  nextCursor: encodePageCursor({
                    createdAt: page.nextCursor.createdAt,
                    id: page.nextCursor.id,
                  }),
                }
              : {}),
          });
        },
      );
    }
  }

  return app;
}

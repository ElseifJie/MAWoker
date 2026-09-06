import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import {
  AuthRequiredError,
  AuthVerificationError,
  type AuthContext,
} from "@pwa/auth";
import {
  AgentConflictError,
  AgentReferencedError,
  InvalidModelError,
  InvalidUploadNameError,
  PersonalAgentQuotaExceededError,
  ResourceNotFoundError,
  SessionTerminatedError,
  type AvailableAgentRecord,
  type DefaultAgentRecord,
  type PersonalAgentRecord,
  type PlatformAgentRecord,
  type SessionRecord,
  type SessionInputRecord,
  type TenantAuthorizationService,
  type TenantResource,
  type TenantResourceKind,
} from "@pwa/domain";
import type { UiEvent } from "@pwa/contracts";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import type { ServerResponse } from "node:http";

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
    tenantResource?: TenantResource;
  }
}

export const AUTH_COOKIE_NAME = "pwa_session";

export interface ApiAuthService {
  requestEmailCode(email: string): Promise<void>;
  verifyEmailCode(
    email: string,
    code: string,
  ): Promise<{ token: string; expiresAt: Date }>;
  authenticate(token?: string): Promise<AuthContext>;
  renew(token: string): Promise<{ expiresAt: Date }>;
  logout(token?: string): Promise<void>;
}

export interface AdminService {
  listPlatformAgents(): PromiseLike<PlatformAgentRecord[]>;
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
  listUsers(): PromiseLike<
    Array<{
      id: string;
      email: string;
      status: "active" | "disabled";
      defaultAgentId: string | null;
    }>
  >;
  assignDefaultAgent(
    userId: string,
    platformAgentId: string,
    context: { adminId: string; requestId: string },
  ): PromiseLike<DefaultAgentRecord>;
  updateUserQuota(
    userId: string,
    quota: {
      personalAgentLimit: number;
      concurrentSessionLimit: number;
      dailySessionLimit: number;
      monthlyTokenLimit: number;
    },
    context: { adminId: string; requestId: string },
  ): PromiseLike<{
    userId: string;
    personalAgentLimit: number;
    concurrentSessionLimit: number;
    dailySessionLimit: number;
    monthlyTokenLimit: number;
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
    selection: { agentId: string; source: "recent" | "default" } | null;
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
      arkVersion: string;
    },
    context: { userId: string; requestId: string },
  ): PromiseLike<PersonalAgentRecord>;
  delete(
    id: string,
    context: { userId: string; requestId: string },
  ): PromiseLike<void>;
}

export interface SessionApiService {
  create(
    input: { agentId: string; title?: string; uploadIds?: string[] },
    context: { userId: string; requestId: string },
  ): PromiseLike<SessionRecord & { inputs?: SessionInputRecord[] }>;
  list(userId: string, archived: boolean): PromiseLike<SessionRecord[]>;
  get(
    userId: string,
    id: string,
  ): PromiseLike<SessionRecord & { inputs?: SessionInputRecord[] }>;
  sendMessage(
    id: string,
    input: { content: string },
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
  ): PromiseLike<{ events: AsyncIterable<UiEvent> }>;
}

export interface SessionInputApiService {
  upload(
    input: { name: string; contentType: string; bytes: Uint8Array },
    context: { userId: string; requestId: string },
  ): PromiseLike<SessionInputRecord>;
}

interface BuildAppOptions {
  auth?: ApiAuthService;
  admin?: AdminService;
  userAgents?: UserAgentApiService;
  sessions?: SessionApiService;
  inputs?: SessionInputApiService;
  isProduction?: boolean;
}

const emailCodeBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["email"],
  properties: {
    email: { type: "string", minLength: 3, maxLength: 320 },
  },
} as const;

const verifyBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["email", "code"],
  properties: {
    email: { type: "string", minLength: 3, maxLength: 320 },
    code: { type: "string", minLength: 1, maxLength: 32 },
  },
} as const;

const uuidParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: { type: "string", format: "uuid" } },
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

const createPersonalAgentBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "modelId", "systemPrompt"],
  properties: agentProperties,
} as const;

const updatePersonalAgentBodySchema = {
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
} as const;

const defaultAgentBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["platformAgentId"],
  properties: {
    platformAgentId: { type: "string", format: "uuid" },
  },
} as const;

const quotaBodySchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "personalAgentLimit",
    "concurrentSessionLimit",
    "dailySessionLimit",
    "monthlyTokenLimit",
  ],
  properties: {
    personalAgentLimit: { type: "integer", minimum: 0 },
    concurrentSessionLimit: { type: "integer", minimum: 0 },
    dailySessionLimit: { type: "integer", minimum: 0 },
    monthlyTokenLimit: { type: "integer", minimum: 0 },
  },
} as const;

const createSessionBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["agentId"],
  properties: {
    agentId: { type: "string", format: "uuid" },
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

const sendMessageBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["content"],
  properties: {
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
  code: string,
  message: string,
  retryable: boolean,
) {
  return { error: { code, message, requestId, retryable } };
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
    ...(personal ? { lastErrorCode: agent.lastErrorCode } : {}),
    ...(includePrompt && (personal || agent.editable)
      ? { systemPrompt: agent.systemPrompt }
      : {}),
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

function publicSession(
  session: SessionRecord & { inputs?: SessionInputRecord[] },
) {
  return {
    id: session.id,
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
  const category =
    typeof error === "object" && error !== null && "category" in error
      ? error.category
      : undefined;
  if (category === "rate_limited") {
    return reply
      .code(429)
      .send(
        applicationError(
          request.id,
          "ARK_RATE_LIMITED",
          "Ark rate limit exceeded",
          true,
        ),
      );
  }
  if (
    category === "unavailable" ||
    category === "unknown_write_outcome" ||
    category === "timeout"
  ) {
    return reply
      .code(503)
      .send(
        applicationError(
          request.id,
          "ARK_UNAVAILABLE",
          "Ark service is unavailable",
          category !== "unknown_write_outcome",
        ),
      );
  }
  throw error;
}

function sendSessionError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (
    error instanceof ResourceNotFoundError ||
    hasErrorName(error, "ResourceNotFoundError")
  ) {
    return reply.code(404).send(resourceNotFoundError(request.id));
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
  if (category === "rate_limited") {
    return reply
      .code(429)
      .send(
        applicationError(
          request.id,
          "ARK_RATE_LIMITED",
          "Ark rate limit exceeded",
          true,
        ),
      );
  }
  if (
    category === "unavailable" ||
    category === "unknown_write_outcome" ||
    category === "timeout"
  ) {
    return reply
      .code(503)
      .send(
        applicationError(
          request.id,
          "ARK_UNAVAILABLE",
          "Ark service is unavailable",
          category !== "unknown_write_outcome",
        ),
      );
  }
  throw error;
}

function isAllowedAdminRoute(route: string): boolean {
  return (
    route === "/api/v1/admin/platform-agents" ||
    route === "/api/v1/admin/platform-agents/:id" ||
    route === "/api/v1/admin/users" ||
    route === "/api/v1/admin/users/:id/default-agent" ||
    route === "/api/v1/admin/users/:id/quota"
  );
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

export function requireAdmin(auth: ApiAuthService, isProduction = false) {
  const authenticate = requireAuthenticated(auth, isProduction);
  return async function authorizeAdmin(
    request: Parameters<typeof authenticate>[0],
    reply: Parameters<typeof authenticate>[1],
  ) {
    await authenticate(request, reply);
    if (reply.sent) {
      return reply;
    }
    if (request.auth?.role !== "admin") {
      return reply.code(403).send(forbiddenError(request.id));
    }
  };
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
      return reply.code(403).send(forbiddenError(request.id));
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
      return reply.code(403).send(forbiddenError(request.id));
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
  async requestEmailCode() {
    throw new AuthVerificationError();
  },
  async verifyEmailCode() {
    throw new AuthVerificationError();
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
    logger: true,
    ajv: { customOptions: { removeAdditional: false } },
  });
  const isProduction = options.isProduction ?? false;

  void app.register(cookie);
  void app.register(multipart, {
    limits: {
      files: 20,
      fields: 20,
      fileSize: 20 * 1024 * 1024,
    },
  });

  app.get("/health", async () => ({ status: "ok" }));

  {
    const auth = options.auth ?? unavailableAuth;
    const authenticate = requireAuthenticated(auth, isProduction);
    const authorizeAdmin = requireAdmin(auth, isProduction);
    const authorizeUser = requireUser(auth, isProduction);

    app.addHook("preHandler", async (request, reply) => {
      const route = request.routeOptions.url ?? "";
      if (!route.startsWith("/api/v1/") || route.startsWith("/api/v1/auth/")) {
        return;
      }
      if (route.startsWith("/api/v1/admin/")) {
        if (!isAllowedAdminRoute(route)) {
          return reply.code(404).send(resourceNotFoundError(request.id));
        }
        return authorizeAdmin(request, reply);
      }
      if (route === "/api/v1/me") {
        return authenticate(request, reply);
      }
      return authorizeUser(request, reply);
    });

    app.post<{ Body: { email: string } }>(
      "/api/v1/auth/email-code",
      { schema: { body: emailCodeBodySchema } },
      async (request, reply) => {
        try {
          await auth.requestEmailCode(request.body.email.trim().toLowerCase());
          return reply.code(202).send({ accepted: true });
        } catch (error) {
          if (
            !(error instanceof AuthVerificationError) &&
            !hasErrorName(error, "AuthVerificationError")
          ) {
            throw error;
          }
          return reply.code(401).send(authError(request.id));
        }
      },
    );

    app.post<{ Body: { email: string; code: string } }>(
      "/api/v1/auth/verify",
      { schema: { body: verifyBodySchema } },
      async (request, reply) => {
        try {
          const session = await auth.verifyEmailCode(
            request.body.email.trim().toLowerCase(),
            request.body.code,
          );
          reply.setCookie(
            AUTH_COOKIE_NAME,
            session.token,
            cookieOptions(isProduction, session.expiresAt),
          );
          return reply.code(204).send();
        } catch (error) {
          if (
            !(error instanceof AuthVerificationError) &&
            !hasErrorName(error, "AuthVerificationError") &&
            !(error instanceof AuthRequiredError) &&
            !hasErrorName(error, "AuthRequiredError")
          ) {
            throw error;
          }
          return reply.code(401).send(authError(request.id));
        }
      },
    );

    app.post("/api/v1/auth/logout", async (request, reply) => {
      await auth.logout(request.cookies[AUTH_COOKIE_NAME]);
      reply.clearCookie(AUTH_COOKIE_NAME, cookieOptions(isProduction));
      return reply.code(204).send();
    });

    app.get("/api/v1/me", async (request) => ({ user: request.auth }));

    if (options.inputs) {
      const inputs = options.inputs;
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
        Body: { agentId: string; title?: string; uploadIds?: string[] };
      }>(
        "/api/v1/sessions",
        { schema: { body: createSessionBodySchema } },
        async (request, reply) => {
          try {
            const created = await sessions.create(
              {
                agentId: request.body.agentId,
                ...(request.body.title !== undefined
                  ? { title: request.body.title.trim() }
                  : {}),
                ...(request.body.uploadIds !== undefined
                  ? { uploadIds: request.body.uploadIds }
                  : {}),
              },
              context(request),
            );
            return reply.code(201).send(publicSession(created));
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

      app.get<{ Params: { id: string } }>(
        "/api/v1/sessions/:id/events",
        { schema: { params: uuidParamsSchema } },
        async (request, reply) => {
          const controller = new AbortController();
          const close = () => controller.abort();
          reply.raw.once("close", close);
          let opened: { events: AsyncIterable<UiEvent> };
          try {
            opened = await sessions.openEvents(
              request.params.id,
              context(request),
              controller.signal,
            );
          } catch (error) {
            controller.abort();
            reply.raw.removeListener("close", close);
            return sendSessionError(error, request, reply);
          }

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
                ": ready\n\n",
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
            controller.abort();
            reply.raw.removeListener("close", close);
            if (!reply.raw.destroyed && !reply.raw.writableEnded) {
              reply.raw.end();
            }
          }
          return reply;
        },
      );

      app.post<{
        Params: { id: string };
        Body: { content: string };
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
              { content: request.body.content.trim() },
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
        };
      }>(
        "/api/v1/agents",
        { schema: { body: createPersonalAgentBodySchema } },
        async (request, reply) => {
          try {
            const created = await userAgents.create(
              {
                name: request.body.name.trim(),
                description: request.body.description?.trim() ?? "",
                modelId: request.body.modelId.trim(),
                systemPrompt: request.body.systemPrompt,
              },
              context(request),
            );
            return reply.code(201).send(publicUserAgent(created, true));
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
            const updated = await userAgents.update(
              request.params.id,
              request.body,
              context(request),
            );
            return reply.send(publicUserAgent(updated, true));
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
        async (request, reply) => {
          try {
            const created = await admin.createPlatformAgent(
              {
                name: request.body.name.trim(),
                description: request.body.description?.trim() ?? "",
                modelId: request.body.modelId.trim(),
                systemPrompt: request.body.systemPrompt,
              },
              context(request),
            );
            return reply.code(201).send(publicAgent(created));
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
        async (request, reply) => {
          try {
            const updated = await admin.updatePlatformAgent(
              request.params.id,
              request.body,
              context(request),
            );
            return reply.send(publicAgent(updated));
          } catch (error) {
            return sendAdminError(error, request, reply);
          }
        },
      );

      app.delete<{ Params: { id: string } }>(
        "/api/v1/admin/platform-agents/:id",
        { schema: { params: uuidParamsSchema } },
        async (request, reply) => {
          try {
            await admin.deletePlatformAgent(
              request.params.id,
              context(request),
            );
            return reply.code(204).send();
          } catch (error) {
            return sendAdminError(error, request, reply);
          }
        },
      );

      app.get("/api/v1/admin/users", async (_request, reply) => {
        const users = await admin.listUsers();
        return reply.send({
          users: users.map((user) => ({
            id: user.id,
            email: user.email,
            status: user.status,
            defaultAgentId: user.defaultAgentId,
          })),
        });
      });

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
          personalAgentLimit: number;
          concurrentSessionLimit: number;
          dailySessionLimit: number;
          monthlyTokenLimit: number;
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
            });
          } catch (error) {
            return sendAdminError(error, request, reply);
          }
        },
      );
    }
  }

  return app;
}

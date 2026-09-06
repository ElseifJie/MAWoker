import cookie from "@fastify/cookie";
import {
  AuthRequiredError,
  AuthVerificationError,
  type AuthContext,
} from "@pwa/auth";
import {
  AgentConflictError,
  AgentReferencedError,
  InvalidModelError,
  ResourceNotFoundError,
  type DefaultAgentRecord,
  type PlatformAgentRecord,
  type TenantAuthorizationService,
  type TenantResource,
  type TenantResourceKind,
} from "@pwa/domain";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";

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

interface BuildAppOptions {
  auth?: ApiAuthService;
  admin?: AdminService;
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

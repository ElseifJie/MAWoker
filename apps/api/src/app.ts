import cookie from "@fastify/cookie";
import {
  AuthRequiredError,
  AuthVerificationError,
  type AuthContext,
} from "@pwa/auth";
import {
  ResourceNotFoundError,
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

interface BuildAppOptions {
  auth?: ApiAuthService;
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
  }

  return app;
}

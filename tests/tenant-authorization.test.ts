import { describe, expect, it, vi } from "vitest";
import {
  AUTH_COOKIE_NAME,
  buildApp,
  requireTenantResource,
  type ApiAuthService,
} from "../apps/api/src/app.js";
import {
  ResourceNotFoundError,
  TenantAuthorizationService,
  type TenantAuthorizationRepositories,
  type TenantResourceKind,
} from "../packages/domain/src/index.js";

const currentUserId = "00000000-0000-4000-8000-000000000001";
const otherUserId = "00000000-0000-4000-8000-000000000002";
const ownedId = "00000000-0000-4000-8000-000000000010";
const foreignId = "00000000-0000-4000-8000-000000000020";
const missingId = "00000000-0000-4000-8000-000000000030";

const matrix: Array<{
  kind: TenantResourceKind;
  path: string;
  dependency: "ark" | "tos";
  repository:
    | "personalAgents"
    | "platformAgents"
    | "sessions"
    | "sessionInputs"
    | "artifacts"
    | "usage";
}> = [
  {
    kind: "personalAgent",
    path: "/api/v1/agents/personal",
    dependency: "ark",
    repository: "personalAgents",
  },
  {
    kind: "platformAgent",
    path: "/api/v1/agents/platform",
    dependency: "ark",
    repository: "platformAgents",
  },
  {
    kind: "session",
    path: "/api/v1/sessions",
    dependency: "ark",
    repository: "sessions",
  },
  {
    kind: "sessionInput",
    path: "/api/v1/inputs",
    dependency: "ark",
    repository: "sessionInputs",
  },
  {
    kind: "artifact",
    path: "/api/v1/artifacts",
    dependency: "tos",
    repository: "artifacts",
  },
  {
    kind: "usage",
    path: "/api/v1/usage",
    dependency: "ark",
    repository: "usage",
  },
];

function createRepositories() {
  const createScopedLookup = () => {
    const existingResources = [
      { id: ownedId, userId: currentUserId },
      { id: foreignId, userId: otherUserId },
    ];
    return vi.fn(async (userId: string, resourceId: string) => {
      const resource = existingResources.find(
        ({ id, userId: ownerUserId }) =>
          id === resourceId && ownerUserId === userId,
      );
      return resource ? { id: resource.id } : undefined;
    });
  };

  return {
    personalAgents: { findOwned: createScopedLookup() },
    platformAgents: {
      findAssignedToUser: createScopedLookup(),
    },
    sessions: { findOwned: createScopedLookup() },
    sessionInputs: { findOwned: createScopedLookup() },
    artifacts: { findOwned: createScopedLookup() },
    usage: { findOwned: createScopedLookup() },
  } satisfies TenantAuthorizationRepositories;
}

function createAuthService(role: "user" | "admin" = "user"): ApiAuthService {
  return {
    async login() {
      return { token: "token", expiresAt: new Date(Date.now() + 60_000) };
    },
    async authenticate() {
      return {
        userId: currentUserId,
        authSubject: `managed:${role}@example.com`,
        role,
      };
    },
    async renew() {
      return { expiresAt: new Date(Date.now() + 60_000) };
    },
    async logout() {},
  };
}

function comparableEnvelope(response: {
  json(): { error: Record<string, unknown> };
}) {
  const envelope = response.json();
  return {
    ...envelope,
    error: { ...envelope.error, requestId: "<request-id>" },
  };
}

describe("TenantAuthorizationService", () => {
  it.each(matrix)(
    "resolves $kind only through its tenant-scoped repository",
    async ({ kind, repository }) => {
      // Given an owned resource, a real resource scoped to another user, and a missing ID.
      const repositories = createRepositories();
      const service = new TenantAuthorizationService(repositories);
      const lookup =
        repository === "platformAgents"
          ? repositories.platformAgents.findAssignedToUser
          : repositories[repository].findOwned;

      await expect(lookup(otherUserId, foreignId)).resolves.toEqual({
        id: foreignId,
      });
      lookup.mockClear();

      // When the service resolves all three IDs as the current user.
      await expect(
        service.resolve(kind, ownedId, currentUserId),
      ).resolves.toEqual({ id: ownedId });
      await expect(
        service.resolve(kind, foreignId, currentUserId),
      ).rejects.toBeInstanceOf(ResourceNotFoundError);
      await expect(
        service.resolve(kind, missingId, currentUserId),
      ).rejects.toEqual(new ResourceNotFoundError());

      // Then both inaccessible cases are hidden by the same scoped lookup.
      expect(lookup).toHaveBeenNthCalledWith(1, currentUserId, ownedId);
      expect(lookup).toHaveBeenNthCalledWith(2, currentUserId, foreignId);
      expect(lookup).toHaveBeenNthCalledWith(3, currentUserId, missingId);
    },
  );
});

describe("tenant route guard", () => {
  it.each(matrix)(
    "returns indistinguishable 404s before $dependency access for $kind",
    async ({ kind, path, dependency, repository }) => {
      // Given a route backed by scoped records for both the current and another user.
      const repositories = createRepositories();
      const service = new TenantAuthorizationService(repositories);
      const ark = vi.fn();
      const tos = vi.fn();
      const lookup =
        repository === "platformAgents"
          ? repositories.platformAgents.findAssignedToUser
          : repositories[repository].findOwned;
      await expect(lookup(otherUserId, foreignId)).resolves.toEqual({
        id: foreignId,
      });
      lookup.mockClear();
      const app = buildApp({ auth: createAuthService() });
      app.get<{ Params: { id: string } }>(
        `${path}/:id`,
        { preHandler: requireTenantResource(service, kind) },
        async (request) => {
          if (dependency === "ark") ark();
          if (dependency === "tos") tos();
          return { resource: request.tenantResource };
        },
      );

      // When the owner accesses its resource, downstream access remains available.
      const owned = await app.inject({
        method: "GET",
        url: `${path}/${ownedId}`,
        cookies: { [AUTH_COOKIE_NAME]: "user-token" },
      });
      expect(owned.statusCode).toBe(200);
      expect(owned.json()).toEqual({ resource: { id: ownedId } });
      expect(dependency === "ark" ? ark : tos).toHaveBeenCalledOnce();
      ark.mockClear();
      tos.mockClear();

      // When the current user requests the other user's resource and a missing ID.
      const foreign = await app.inject({
        method: "GET",
        url: `${path}/${foreignId}`,
        cookies: { [AUTH_COOKIE_NAME]: "user-token" },
      });
      const missing = await app.inject({
        method: "GET",
        url: `${path}/${missingId}`,
        cookies: { [AUTH_COOKIE_NAME]: "user-token" },
      });

      // Then the HTTP envelopes match and neither external dependency is touched.
      expect(foreign.statusCode).toBe(404);
      expect(missing.statusCode).toBe(404);
      expect(comparableEnvelope(foreign)).toEqual({
        error: {
          code: "RESOURCE_NOT_FOUND",
          message: "Resource not found",
          requestId: "<request-id>",
          retryable: false,
        },
      });
      expect(comparableEnvelope(foreign)).toEqual(comparableEnvelope(missing));
      expect(ark).not.toHaveBeenCalled();
      expect(tos).not.toHaveBeenCalled();
      await app.close();
    },
  );

  it.each(matrix)(
    "does not grant an admin access to user $kind content",
    async ({ kind, path }) => {
      // Given an authenticated admin and a user-content route.
      const repositories = createRepositories();
      const service = new TenantAuthorizationService(repositories);
      const downstream = vi.fn();
      const app = buildApp({ auth: createAuthService("admin") });
      app.get(
        `${path}/:id`,
        { preHandler: requireTenantResource(service, kind) },
        async () => {
          downstream();
          return { exposed: true };
        },
      );

      // When the admin requests user-owned content.
      const response = await app.inject({
        method: "GET",
        url: `${path}/${ownedId}`,
        cookies: { [AUTH_COOKIE_NAME]: "admin-token" },
      });

      // Then authorization stops before repository or downstream access.
      expect(response.statusCode).toBe(404);
      expect(downstream).not.toHaveBeenCalled();
      expect(repositories.personalAgents.findOwned).not.toHaveBeenCalled();
      expect(
        repositories.platformAgents.findAssignedToUser,
      ).not.toHaveBeenCalled();
      expect(repositories.sessions.findOwned).not.toHaveBeenCalled();
      expect(repositories.sessionInputs.findOwned).not.toHaveBeenCalled();
      expect(repositories.artifacts.findOwned).not.toHaveBeenCalled();
      expect(repositories.usage.findOwned).not.toHaveBeenCalled();
      await app.close();
    },
  );
});

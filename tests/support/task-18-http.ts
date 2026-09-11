import { InMemoryArkGateway } from "../../packages/ark-client/src/index.js";
import {
  ArtifactService,
  QuotaUsageService,
  SessionService,
  UserAgentService,
} from "../../packages/domain/src/index.js";
import {
  AUTH_COOKIE_NAME,
  buildApp,
  type ApiAuthService,
} from "../../apps/api/src/app.js";
import { createTask18DatabaseHarness } from "./task-18-database.js";

type Actor = "first" | "second" | "admin";

export function comparableError(body: unknown) {
  const envelope = body as {
    error: { code: string; message: string; retryable: boolean };
  };
  return {
    code: envelope.error.code,
    message: envelope.error.message,
    retryable: envelope.error.retryable,
  };
}

export async function createTask18HttpHarness() {
  const database = await createTask18DatabaseHarness();
  const ark = new InMemoryArkGateway();
  const storageReads: string[] = [];
  const storage = {
    write: database.storage.write.bind(database.storage),
    async openRead(objectKey: string, signal?: AbortSignal) {
      storageReads.push(objectKey);
      return database.storage.openRead(objectKey, signal);
    },
    delete: database.storage.delete.bind(database.storage),
  };
  const userAgents = new UserAgentService({
    repository: database.repositories.userAgents,
    ark,
    modelAllowlist: ["model-a"],
    createId: database.ids,
  });
  const sessions = new SessionService({
    repository: database.repositories.sessionLifecycle,
    agentResolver: userAgents,
    ark,
    environmentId: "environment-1",
    createId: database.ids,
  });
  const artifacts = new ArtifactService({
    repository: database.repositories.artifacts,
    ark,
    storage,
    createId: database.ids,
  });
  const quotaUsage = new QuotaUsageService({
    repository: database.repositories.usage,
    now: () => new Date(),
  });
  const identity = new Map<string, Actor>([
    ["first-token", "first"],
    ["second-token", "second"],
    ["admin-token", "admin"],
  ]);
  const userId = (actor: Actor) =>
    actor === "first"
      ? database.first.userId
      : actor === "second"
        ? database.second.userId
        : database.adminId;
  const auth: ApiAuthService = {
    async login() {
      throw new Error("Not used");
    },
    async authenticate(token) {
      const actor = token ? identity.get(token) : undefined;
      if (!actor) {
        throw Object.assign(new Error("Authentication required"), {
          name: "AuthRequiredError",
        });
      }
      return {
        userId: userId(actor),
        authSubject: `managed:${actor}`,
        role: actor === "admin" ? "admin" : "user",
      };
    },
    async renew() {
      return { expiresAt: new Date(Date.now() + 60_000) };
    },
    async logout() {},
  };
  const app = buildApp({
    auth,
    userAgents,
    sessions,
    artifacts,
    quotaUsage,
    capabilities: { personalAgentModels: ["model-a"] },
  });
  let arkOffset = 0;
  let tosOffset = 0;

  return {
    ...database,
    app,
    cookies(actor: Actor) {
      return { [AUTH_COOKIE_NAME]: `${actor}-token` };
    },
    resetExternalCalls() {
      arkOffset = ark.calls.length;
      tosOffset = storageReads.length;
    },
    externalCalls() {
      return {
        ark: ark.calls.length - arkOffset,
        tos: storageReads.length - tosOffset,
      };
    },
    async close() {
      await app.close();
      await database.close();
    },
  };
}

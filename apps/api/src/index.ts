import { randomUUID } from "node:crypto";
import { HttpArkGateway } from "@pwa/ark-client";
import { ApplicationSessionService, AuthVerificationError } from "@pwa/auth";
import { parseServerConfig } from "@pwa/config";
import { createAuthStore, createDatabase, createRepositories } from "@pwa/db";
import {
  SessionInputService,
  SessionService,
  UserAgentService,
} from "@pwa/domain";

const config = parseServerConfig(process.env);
const { buildApp } = await import("./app.js");
const database = createDatabase(config.databaseUrl);
const repositories = createRepositories(database.db);
const ark = new HttpArkGateway({
  baseUrl: config.ark.baseUrl,
  apiKey: config.ark.apiKey,
});
const auth = new ApplicationSessionService({
  identity: {
    async requestEmailCode() {
      throw new AuthVerificationError(
        "Managed identity integration is not configured",
      );
    },
    async verifyEmailCode() {
      throw new AuthVerificationError(
        "Managed identity integration is not configured",
      );
    },
  },
  store: createAuthStore(database.db),
});
const userAgents = new UserAgentService({
  repository: repositories.userAgents,
  ark,
  modelAllowlist: config.modelAllowlist,
  createId: randomUUID,
});
const sessions = new SessionService({
  repository: repositories.sessionLifecycle,
  agentResolver: userAgents,
  ark,
  environmentId: config.ark.environmentId,
  createId: randomUUID,
});
const inputs = new SessionInputService({
  repository: repositories.sessionInputs,
  ark,
  createId: randomUUID,
});
const app = buildApp({
  auth,
  userAgents,
  sessions,
  inputs,
  isProduction: config.nodeEnv === "production",
});

await app.listen({ host: "0.0.0.0", port: config.port });

const shutdown = async () => {
  process.off("SIGINT", shutdown);
  process.off("SIGTERM", shutdown);
  await app.close();
  await database.close();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

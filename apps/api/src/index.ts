import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { HttpArkGateway } from "@pwa/ark-client";
import { ApplicationSessionService, hashPassword } from "@pwa/auth";
import { parseServerConfig } from "@pwa/config";
import { createAuthStore, createDatabase, createRepositories } from "@pwa/db";
import {
  AdminUsageService,
  AdminUserDetailService,
  ArtifactService,
  AuditService,
  DriveFileService,
  LoggingNotifier,
  PlatformAgentService,
  QuotaPolicyService,
  QuotaUsageService,
  SessionInputService,
  SessionService,
  UserAgentService,
  type PlatformAgentRepository,
} from "@pwa/domain";
import { createTosArtifactStorage } from "@pwa/storage";

const config = parseServerConfig(process.env);
const { buildApp } = await import("./app.js");
const database = createDatabase(config.databaseUrl, {
  probeTimeoutMs: config.health.databaseTimeoutMs,
});
const repositories = createRepositories(database.db);
const ark = new HttpArkGateway({
  baseUrl: config.ark.baseUrl,
  apiKey: config.ark.apiKey,
  timeoutMs: config.ark.requestTimeoutMs,
  maxAttempts: config.ark.maxAttempts,
  baseDelayMs: config.ark.retryBaseDelayMs,
  maxDelayMs: config.ark.retryMaxDelayMs,
});
const artifactStorage = createTosArtifactStorage(config.tos);
const isProduction = config.nodeEnv === "production";
const auth = new ApplicationSessionService({
  store: createAuthStore(database.db),
});
const userAgents = new UserAgentService({
  repository: repositories.userAgents,
  ark,
  modelAllowlist: config.modelAllowlist,
  createId: randomUUID,
});
const notifier = new LoggingNotifier();
const admin = new PlatformAgentService({
  repository: repositories.platformAgents as unknown as PlatformAgentRepository,
  ark,
  modelAllowlist: config.modelAllowlist,
  createId: randomUUID,
  passwordHasher: { hash: hashPassword },
  notifier,
});
const adminUsage = new AdminUsageService({
  repository: {
    overview: (input) => repositories.usage.adminOverview(input),
    byAgents: (input) => repositories.usage.byAgents(input),
  },
});
const quotaPolicy = new QuotaPolicyService({
  repository: repositories.quotaPolicies,
  notifier,
});
const quotaUsage = new QuotaUsageService({
  repository: repositories.usage,
});
const audit = new AuditService({ repository: repositories.auditLogs });
const adminUserDetail = new AdminUserDetailService({
  repository: {
    getUser: repositories.adminUsers.getUser,
    listSessions: repositories.adminUsers.listSessions,
    summary: repositories.usage.summary,
  },
  audit,
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
const driveFiles = new DriveFileService({
  repository: repositories.driveFiles,
  storage: artifactStorage,
  createId: randomUUID,
});
const artifacts = new ArtifactService({
  repository: repositories.artifacts,
  drive: driveFiles,
  ark,
  storage: artifactStorage,
  createId: randomUUID,
});
const app = buildApp({
  auth,
  admin,
  audit,
  adminUsage,
  quotaPolicy,
  adminUserDetail,
  userAgents,
  sessions,
  inputs,
  artifacts,
  quotaUsage,
  capabilities: { personalAgentModels: config.modelAllowlist },
  isProduction,
  appOrigin: config.appOrigin,
  rateLimit: config.apiRateLimit,
  readiness: {
    configurationReady: true,
    checkDatabase: (signal) => database.probe(signal),
    timeoutMs: config.health.databaseTimeoutMs,
  },
  webRoot: resolve(import.meta.dirname, "../../web/dist"),
});

await app.listen({ host: "0.0.0.0", port: config.port });

const shutdown = async () => {
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  await app.close();
  await database.close();
};
const onSignal = () => void shutdown();
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);

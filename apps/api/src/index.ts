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
  AssistantProfileService,
  AccountDeletionService,
  AccountExportService,
  AutomationService,
  InviteCodeService,
  McpServerService,
  NotificationChannelService,
  AuditService,
  DriveFileService,
  LoggingNotifier,
  MemoryService,
  PlatformAgentService,
  QuotaPolicyService,
  QuotaUsageService,
  RunService,
  SyncService,
  resolveSystemAgents,
  SessionInputService,
  FileReuseService,
  SessionService,
  SkillService,
  UserAgentService,
  UserDefaultAgentSynchronizer,
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
// Resolve System Agent metadata before serving requests so startup fails closed.
const configuredSystemAgents = await resolveSystemAgents({
  agentIds: config.systemAgentIds,
  ark,
  modelAllowlist: config.modelAllowlist,
});
await repositories.platformAgents.synchronizeSystemAgents(
  configuredSystemAgents,
);
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
  mcpServers: {
    async listActive(ownerUserId) {
      const rows = await repositories.mcpServers.listOwned(ownerUserId);
      return rows
        .filter((row) => row.status === "active")
        .map((row) => ({ id: row.id, name: row.name, url: row.url }));
    },
  },
});
const notifier = new LoggingNotifier();
const memory = new MemoryService({
  repository: repositories.memories,
  ark,
  modelId: config.memory.modelId,
  monitorIntervalMs: config.memory.monitorIntervalMs,
  cooldownMs: config.memory.cooldownMs,
  ...(config.memory.byteBudget === undefined
    ? {}
    : { byteBudget: config.memory.byteBudget }),
});
const admin = new PlatformAgentService({
  repository: repositories.platformAgents as unknown as PlatformAgentRepository,
  ark,
  modelAllowlist: config.modelAllowlist,
  createId: randomUUID,
  passwordHasher: { hash: hashPassword },
  notifier,
  userAgentLister: () => repositories.adminAgents.listUserAgents(),
  memory,
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
  submissionAdmissionEnabled: config.reliability.submissionAdmissionEnabled,
  createId: randomUUID,
  memory,
});
const runService = new RunService({ repository: repositories.runs });
const accountDeletionService = new AccountDeletionService({
  repository: repositories.accountDeletion,
});
const accountExportService = new AccountExportService({
  repository: repositories.accountExport,
});
const automationService = new AutomationService({
  repository: repositories.automations,
  createId: randomUUID,
});
const notificationChannels = new NotificationChannelService({
  repository: repositories.notificationChannels,
  createId: randomUUID,
});
const mcpServers = new McpServerService({
  repository: repositories.mcpServers,
  createId: randomUUID,
});
const inviteCodes = new InviteCodeService({
  repository: repositories.inviteCodes,
  passwordHasher: { hash: hashPassword },
  createId: randomUUID,
});
const assistantProfile = new AssistantProfileService({
  repository: repositories.assistantProfiles,
});
const syncService = new SyncService({
  repository: repositories.sync,
  runs: repositories.runs,
  notifications: repositories.sessionDelivery,
});
const skills = new SkillService({
  repository: repositories.skills,
  ark,
  defaultAgents: new UserDefaultAgentSynchronizer(userAgents),
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
  invites: inviteCodes,
  automations: automationService,
  accountDeletion: accountDeletionService,
  accountExport: accountExportService,
  adminSystem: repositories.adminSystem,
  mcpServers,
  notificationChannels,
  accountSessions: {
    async list(userId, currentSessionId, now) {
      const rows = await repositories.authSessions.listActiveForUser(
        userId,
        now,
      );
      return rows.map((row) => ({
        ...row,
        current: row.id === currentSessionId,
      }));
    },
    revokeOthers(userId, currentSessionId, now) {
      return repositories.authSessions.revokeOthersForUser(
        userId,
        currentSessionId,
        now,
      );
    },
  },
  assistant: assistantProfile,
  admin,
  audit,
  adminUsage,
  quotaPolicy,
  adminUserDetail,
  userAgents,
  skills,
  sessions,
  eventSource: config.reliability.eventSource,
  runs: runService,
  sync: syncService,
  memory,
  inputs,
  artifacts,
  fileReuse: new FileReuseService({
    admissionEnabled: config.reliability.fileReuseAdmissionEnabled,
    repository: repositories.fileReuse,
    inputs: repositories.sessionInputs,
    ark,
    storage: artifactStorage,
    createId: randomUUID,
  }),
  delivery: repositories.sessionDelivery,
  artifactRetryWindowMs: config.reliability.artifactRetryWindowMs,
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

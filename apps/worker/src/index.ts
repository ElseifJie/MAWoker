import { randomUUID } from "node:crypto";
import { HttpArkGateway } from "@pwa/ark-client";
import { parseServerConfig } from "@pwa/config";
import { createDatabase, createRepositories } from "@pwa/db";
import {
  ArtifactService,
  DriveFileService,
  LoggingNotifier,
  SessionInputService,
  SessionService,
  UserAgentService,
} from "@pwa/domain";
import { createTosArtifactStorage } from "@pwa/storage";
import { ArtifactDeletionProcessor } from "./artifact-deletion.js";
import { ArtifactObjectCleanupProcessor } from "./artifact-object-cleanup.js";
import { DriveObjectCleanupProcessor } from "./drive-object-cleanup.js";
import { DriveOrphanGcProcessor } from "./drive-orphan-gc.js";
import { startWorkerLivenessServer } from "./health.js";
import { createWorkerLogger, logWorkerFailure } from "./logger.js";
import { PersonalAgentReconciliationProcessor } from "./personal-agent-reconciliation.js";
import { runProductionWorkerPoll } from "./poll.js";
import { QuotaInterruptProcessor } from "./quota-interrupt.js";
import { SessionReconciliationProcessor } from "./session-reconciliation.js";
import { SessionDeletionProcessor } from "./session-deletion.js";
import { UploadCleanupProcessor } from "./upload-cleanup.js";
import { UsageReconciliationProcessor } from "./usage-reconciliation.js";

const config = parseServerConfig(process.env);
const logger = createWorkerLogger();
const reportWorkerError = (_message: string, error: unknown) => {
  logWorkerFailure(logger, "worker.operation.failed", error);
};
const database = createDatabase(config.databaseUrl);
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
const service = new UserAgentService({
  repository: repositories.userAgents,
  ark,
  modelAllowlist: config.modelAllowlist,
  createId: randomUUID,
});
const personalAgentProcessor = new PersonalAgentReconciliationProcessor({
  jobs: repositories.jobs,
  service,
  workerId: `personal-agent-worker:${process.pid}:${randomUUID()}`,
});
const sessionProcessor = new SessionReconciliationProcessor({
  jobs: repositories.jobs,
  service: new SessionService({
    repository: repositories.sessionLifecycle,
    agentResolver: service,
    ark,
    environmentId: config.ark.environmentId,
    createId: randomUUID,
  }),
  workerId: `session-worker:${process.pid}:${randomUUID()}`,
});
const driveFiles = new DriveFileService({
  repository: repositories.driveFiles,
  storage: artifactStorage,
  createId: randomUUID,
});
const sessionDeletionProcessor = new SessionDeletionProcessor({
  jobs: repositories.jobs,
  repository: repositories.sessionDeletion,
  ark,
  workerId: `session-deletion-worker:${process.pid}:${randomUUID()}`,
  alert: (event) =>
    logger.error(
      { event: "deletion.terminal", ...event },
      "Terminal deletion failure",
    ),
});
const notifier = new LoggingNotifier((fields, message) =>
  logger.warn(fields, message),
);
const usageProcessor = new UsageReconciliationProcessor({
  repository: {
    listReconcilable: repositories.usage.listReconcilable,
    markReconciled: repositories.usage.markReconciled,
    projectEvent: repositories.sessionLifecycle.projectEvent,
    monthlyTokenState: repositories.usage.monthlyTokenState,
  },
  ark,
  workerId: `usage-worker:${process.pid}:${randomUUID()}`,
  reportError: reportWorkerError,
  notifier,
});
const quotaInterruptProcessor = new QuotaInterruptProcessor({
  jobs: repositories.quotaInterrupts,
  ark,
  workerId: `quota-interrupt-worker:${process.pid}:${randomUUID()}`,
});
const uploadCleanupProcessor = new UploadCleanupProcessor({
  jobs: repositories.jobs,
  service: new SessionInputService({
    repository: repositories.sessionInputs,
    ark,
    createId: randomUUID,
  }),
  workerId: `upload-cleanup-worker:${process.pid}:${randomUUID()}`,
});
const artifactDeletionProcessor = new ArtifactDeletionProcessor({
  jobs: repositories.jobs,
  service: new ArtifactService({
    repository: repositories.artifacts,
    drive: driveFiles,
    ark,
    storage: artifactStorage,
    createId: randomUUID,
  }),
  workerId: `artifact-deletion-worker:${process.pid}:${randomUUID()}`,
  alert: (event) =>
    logger.error(
      { event: "deletion.terminal", ...event },
      "Terminal deletion failure",
    ),
});
const artifactObjectCleanupProcessor = new ArtifactObjectCleanupProcessor({
  jobs: repositories.jobs,
  service: new ArtifactService({
    repository: repositories.artifacts,
    drive: driveFiles,
    ark,
    storage: artifactStorage,
    createId: randomUUID,
  }),
  workerId: `artifact-object-cleanup-worker:${process.pid}:${randomUUID()}`,
});
const driveObjectCleanupProcessor = new DriveObjectCleanupProcessor({
  jobs: repositories.jobs,
  service: driveFiles,
  workerId: `drive-object-cleanup-worker:${process.pid}:${randomUUID()}`,
});
const driveOrphanGcProcessor = new DriveOrphanGcProcessor({
  service: driveFiles,
  retentionMs: config.driveOrphanRetentionMs,
});
const health = startWorkerLivenessServer({
  host: config.worker.healthHost,
  port: config.worker.healthPort,
});

logger.info({ event: "worker.ready", result: "success" }, "Worker ready");

await new Promise<void>((resolve) => {
  let running = false;
  const poll = async () => {
    if (running) return;
    running = true;
    try {
      await runProductionWorkerPoll(
        {
          personalAgent: personalAgentProcessor,
          session: sessionProcessor,
          sessionDeletion: sessionDeletionProcessor,
          usage: usageProcessor,
          quotaInterrupt: quotaInterruptProcessor,
          uploadCleanup: uploadCleanupProcessor,
          artifactDeletion: artifactDeletionProcessor,
          artifactCleanup: artifactObjectCleanupProcessor,
          driveCleanup: driveObjectCleanupProcessor,
          driveOrphanGc: driveOrphanGcProcessor,
        },
        reportWorkerError,
      );
    } finally {
      running = false;
    }
  };
  const interval = setInterval(() => void poll(), config.worker.pollIntervalMs);
  void poll();
  const shutdown = async () => {
    clearInterval(interval);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await health.close();
    await database.close();
    resolve();
  };
  const onSignal = () => void shutdown();

  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
});

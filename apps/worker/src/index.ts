import { randomUUID } from "node:crypto";
import { HttpArkGateway } from "@pwa/ark-client";
import { parseServerConfig } from "@pwa/config";
import { createDatabase, createRepositories } from "@pwa/db";
import { UserAgentService } from "@pwa/domain";
import { PersonalAgentReconciliationProcessor } from "./personal-agent-reconciliation.js";

const config = parseServerConfig(process.env);
const database = createDatabase(config.databaseUrl);
const repositories = createRepositories(database.db);
const service = new UserAgentService({
  repository: repositories.userAgents,
  ark: new HttpArkGateway({
    baseUrl: config.ark.baseUrl,
    apiKey: config.ark.apiKey,
  }),
  modelAllowlist: config.modelAllowlist,
  createId: randomUUID,
});
const processor = new PersonalAgentReconciliationProcessor({
  jobs: repositories.jobs,
  service,
  workerId: `personal-agent-worker:${process.pid}:${randomUUID()}`,
});

console.info("Worker ready");

await new Promise<void>((resolve) => {
  let running = false;
  const poll = async () => {
    if (running) return;
    running = true;
    try {
      await processor.runOnce();
    } catch (error) {
      console.error("Personal Agent reconciliation poll failed", error);
    } finally {
      running = false;
    }
  };
  const interval = setInterval(() => void poll(), 1_000);
  void poll();
  const shutdown = async () => {
    clearInterval(interval);
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    await database.close();
    resolve();
  };

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
});

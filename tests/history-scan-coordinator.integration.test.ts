import { afterEach, describe, expect, it, vi } from "vitest";
import { createRepositories } from "../packages/db/src/index.js";
import { createSessionDeliveryRepository } from "../packages/db/src/session-delivery-repository.js";
import { SessionDeliveryService } from "../packages/domain/src/session-delivery.js";
import { SessionService } from "../packages/domain/src/index.js";
import { createHistoryScanCoordinator } from "../apps/worker/src/history-scan-coordinator.js";
import { SessionHistoryProcessor } from "../apps/worker/src/session-history.js";
import { createTestDatabase, id } from "./support/test-database.js";

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

async function setup() {
  const database = await createTestDatabase();
  databases.push(database);
  const userId = id();
  const sessionId = id();
  const agentId = id();
  await database.client.query(
    "insert into users (id,auth_subject,email) values ($1,$2,$3)",
    [userId, userId, `${userId}@example.com`],
  );
  await database.client.query(
    "insert into personal_agents (id,owner_user_id,ark_agent_id,name,model_id,system_prompt,ark_version,status) values ($1,$2,'agent','Agent','model','Prompt','1','active')",
    [agentId, userId],
  );
  await database.client.query(
    `insert into sessions (id,owner_user_id,personal_agent_id,ark_session_id,agent_kind,ark_agent_id,agent_name,agent_version,environment_id,title,status)
    values ($1,$2,$3,'ark-ready','personal','agent','Agent','1','env','Task','idle')`,
    [sessionId, userId, agentId],
  );
  // Make both lanes select the Session in their first pass: repair is due
  // (next_attempt_at is null) while the last scan is still certified complete.
  await database.client.query(
    `insert into session_event_cursors
      (session_id,history_backfilled_at,history_scanned_at,history_repair_required,history_scan_generation)
    values ($1,now(),now(),false,1)`,
    [sessionId],
  );
  return {
    database,
    userId,
    sessionId,
    repositories: createRepositories(database.db),
  };
}

describe("worker history scan coordination", () => {
  it("runs one upstream scan when delivery discovery and periodic repair start together", async () => {
    const { database, userId, sessionId, repositories } = await setup();
    const listEvents = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return [];
    });
    const service = new SessionService({
      repository: repositories.sessionLifecycle,
      ark: {
        listEvents,
        getSession: async () => ({ status: "idle" }),
        createSession: async () => undefined,
        submitEvent: async () => undefined,
        streamEvents: async () => undefined,
      } as never,
      agentResolver: {} as never,
      environmentId: "env",
      createId: id,
    });
    const historyScans = createHistoryScanCoordinator(service);
    const reportHistoryError = vi.fn();
    const reportDeliveryError = vi.fn();
    const history = new SessionHistoryProcessor({
      repository: repositories.sessionLifecycle,
      service: historyScans,
      workerId: "history-worker",
      reportError: reportHistoryError,
    });
    const delivery = new SessionDeliveryService({
      repository: createSessionDeliveryRepository(database.db),
      sessions: historyScans,
      ark: { getSession: async () => ({ status: "idle" }) } as never,
      artifacts: {} as never,
      reportError: reportDeliveryError,
    });

    await Promise.all([history.runOnce(), delivery.discoverOnce()]);

    expect(listEvents).toHaveBeenCalledTimes(1);
    expect(reportHistoryError).not.toHaveBeenCalled();
    expect(reportDeliveryError).not.toHaveBeenCalled();
    expect(
      await repositories.sessionLifecycle.historyState(userId, sessionId),
    ).toMatchObject({ complete: true, repairRequired: false });
  });
});

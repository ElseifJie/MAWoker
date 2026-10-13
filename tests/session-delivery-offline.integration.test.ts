import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createRepositories } from "../packages/db/src/index.js";
import {
  ArtifactService,
  DriveFileService,
  SessionDeliveryService,
  SessionService,
} from "../packages/domain/src/index.js";
import { InMemoryArtifactStorage } from "../packages/storage/src/index.js";
import { SessionReconciliationProcessor } from "../apps/worker/src/session-reconciliation.js";
import { createTestDatabase } from "./support/test-database.js";

describe("offline result delivery", () => {
  it("delivers a late output without a browser and does not duplicate files or notifications after worker restart", async () => {
    const database = await createTestDatabase();
    try {
      const repositories = createRepositories(database.db);
      const userId = randomUUID();
      const agentId = randomUUID();
      const sessionId = randomUUID();
      const remote = `remote-${sessionId}`;
      const now = new Date();
      await database.client.query(
        "insert into users(id,auth_subject,email) values($1,$2,$3)",
        [userId, userId, `${userId}@example.com`],
      );
      await database.client.query(
        "insert into personal_agents(id,owner_user_id,ark_agent_id,name,model_id,system_prompt,ark_version,status) values($1,$2,$3,'Agent','model','prompt','1','active')",
        [agentId, userId, `agent-${agentId}`],
      );
      await database.client.query(
        "insert into sessions(id,owner_user_id,personal_agent_id,ark_session_id,agent_kind,ark_agent_id,agent_version,environment_id,title,status) values($1,$2,$3,$4,'personal',$5,'1','env','Task','idle')",
        [sessionId, userId, agentId, remote, `agent-${agentId}`],
      );
      const makeEvent = (
        id: string,
        type: string,
        data: Record<string, unknown>,
        age: number,
      ) => ({
        id,
        type,
        data,
        createdAt: new Date(now.getTime() - age).toISOString(),
      });
      const events = [
        makeEvent("input", "user.message", { content: "create report" }, 3000),
        makeEvent(
          "answer",
          "agent.message",
          { content: "成果在 /mnt/session/outputs/report.txt" },
          2000,
        ),
        makeEvent(
          "end",
          "session.status_idle",
          { stop_reason: { type: "end_turn" } },
          1000,
        ),
      ];
      let visible = false;
      const file = {
        id: "remote-file",
        sessionId: remote,
        name: "report.txt",
        contentType: "text/plain",
        size: 6,
        createdAt: new Date(now.getTime() - 1500).toISOString(),
        tos: { bucket: "exports", objectKey: "report" },
      };
      const ark = {
        listEvents: async () => events,
        getSession: async () => ({ status: "idle" as const }),
        listArtifacts: async () => (visible ? [file] : []),
      };
      const storage = new InMemoryArtifactStorage();
      storage.putExternal(
        file.tos,
        new TextEncoder().encode("report"),
        "text/plain",
      );
      const drive = new DriveFileService({
        repository: repositories.driveFiles,
        storage,
        createId: randomUUID,
      });
      const artifacts = new ArtifactService({
        repository: repositories.artifacts,
        drive,
        ark,
        storage,
        createId: randomUUID,
      });
      const sessions = new SessionService({
        repository: repositories.sessionLifecycle,
        ark: ark as never,
        agentResolver: {} as never,
        environmentId: "env",
        createId: randomUUID,
      });
      const delivery = new SessionDeliveryService({
        repository: repositories.sessionDelivery,
        sessions,
        ark: ark as never,
        artifacts,
        now: () => now,
      });
      await delivery.discoverOnce();
      const firstWorker = new SessionReconciliationProcessor({
        jobs: repositories.jobs,
        service: sessions,
        delivery,
        workerId: "worker-1",
      });
      await firstWorker.runOnce();
      expect(
        (await repositories.sessionDelivery.listTurns(userId, sessionId))[0]
          ?.artifactState,
      ).toBe("pending");
      expect(await artifacts.list(userId)).toEqual([]);
      visible = true;
      await database.client.query(
        "update background_jobs set run_after=now()-interval '1 second' where payload->>'operation'='sync_artifacts'",
      );
      const restartedWorker = new SessionReconciliationProcessor({
        jobs: createRepositories(database.db).jobs,
        service: sessions,
        delivery,
        workerId: "worker-2",
      });
      await restartedWorker.runOnce();
      const files = await artifacts.list(userId);
      expect(files).toHaveLength(1);
      expect(files[0]?.name).toBe("report.txt");
      expect(
        (await repositories.sessionDelivery.listTurns(userId, sessionId))[0],
      ).toMatchObject({
        artifactState: "synced",
        artifactIds: [files[0]!.id],
      });
      await delivery.discoverOnce();
      await restartedWorker.runOnce();
      expect(await artifacts.list(userId)).toHaveLength(1);
      expect(
        (
          await repositories.sessionDelivery.listNotifications(userId, 20)
        ).filter((n) => n.kind === "completed"),
      ).toHaveLength(1);
      expect(
        (await database.client.query("select count(*)::int n from drive_files"))
          .rows[0]?.n,
      ).toBe(1);
    } finally {
      await database.close();
    }
  });
});

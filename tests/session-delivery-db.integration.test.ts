import { afterEach, describe, expect, it, vi } from "vitest";
import { createRepositories } from "../packages/db/src/index.js";
import { createSessionDeliveryRepository } from "../packages/db/src/session-delivery-repository.js";
import { createTestDatabase, id } from "./support/test-database.js";

import { ArtifactService } from "../packages/domain/src/artifacts.js";
import { DriveFileService } from "../packages/domain/src/drive-files.js";
import { Readable } from "node:stream";

import { SessionDeliveryService } from "../packages/domain/src/session-delivery.js";

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

async function fixture() {
  const database = await createTestDatabase();
  databases.push(database);
  const userId = id();
  const sessionId = id();
  const agentId = id();
  await database.client.query(
    "insert into users(id,auth_subject,email) values($1::uuid,$1::text,$2)",
    [userId, `${userId}@example.com`],
  );
  await database.client.query(
    "insert into personal_agents(id,owner_user_id,ark_agent_id,name,model_id,system_prompt,ark_version,status) values($1,$2,$3,'Agent','model','prompt','1','active')",
    [agentId, userId, `remote-${agentId}`],
  );
  await database.client.query(
    "insert into sessions(id,owner_user_id,personal_agent_id,ark_session_id,agent_kind,ark_agent_id,agent_version,environment_id,title,status) values($1,$2,$3,$4,'personal',$5,'1','env','Task','idle')",
    [sessionId, userId, agentId, `remote-${sessionId}`, `remote-${agentId}`],
  );
  const repository = createSessionDeliveryRepository(database.db);
  const now = new Date();
  const observation = {
    boundaryEventId: "end",
    inputEventId: "input",
    outcome: "completed" as const,
    summary: "Work done",
    expectedNames: [] as string[],
    startedAt: new Date(now.getTime() - 2000),
    endedAt: new Date(now.getTime() - 1000),
    usageState: "pending" as const,
  };
  return { ...database, repository, userId, sessionId, observation, now };
}

describe("durable turn completion records", () => {
  it("promotes repaired confirming records and suppresses waits already followed by completion", async () => {
    const f = await fixture();
    const input = {
      now: f.now,
      upstreamStatus: "idle",
      retryWindowMs: 300_000,
    };
    await f.repository.recordObservations(
      f.userId,
      f.sessionId,
      [{ ...f.observation, outcome: "confirming" }],
      input,
    );
    await f.repository.recordObservations(
      f.userId,
      f.sessionId,
      [f.observation],
      input,
    );
    expect(
      (await f.repository.listTurns(f.userId, f.sessionId))[0],
    ).toMatchObject({ outcome: "completed", artifactState: "pending" });
    await f.repository.recordObservations(
      f.userId,
      f.sessionId,
      [
        {
          ...f.observation,
          outcome: "waiting",
          boundaryEventId: "old-wait",
          endedAt: new Date(f.now.getTime() - 2000),
        },
        f.observation,
      ],
      input,
    );
    expect(
      (await f.repository.listNotifications(f.userId, 20)).filter(
        (n) => n.kind === "needs_action",
      ),
    ).toEqual([]);
  });

  it("reserves discovery candidates and respects the durable history backoff", async () => {
    const f = await fixture();
    await f.client.query(
      "insert into session_event_cursors(session_id,history_repair_required,history_next_attempt_at) values($1,true,$2)",
      [f.sessionId, new Date(f.now.getTime() + 600_000)],
    );
    expect(
      await f.repository.listDiscoveryCandidates({ now: f.now, limit: 2 }),
    ).toEqual([]);
    await f.client.query(
      "update session_event_cursors set history_next_attempt_at=null where session_id=$1",
      [f.sessionId],
    );
    expect(
      await f.repository.listDiscoveryCandidates({ now: f.now, limit: 2 }),
    ).toHaveLength(1);
    expect(
      await f.repository.listDiscoveryCandidates({ now: f.now, limit: 2 }),
    ).toEqual([]);
  });

  it("preserves recoverable failure when a sync worker crashes on its final attempt", async () => {
    const f = await fixture();
    await f.repository.recordObservations(
      f.userId,
      f.sessionId,
      [f.observation],
      { now: f.now, upstreamStatus: "idle", retryWindowMs: 300_000 },
    );
    const [turn] = await f.repository.listTurns(f.userId, f.sessionId);
    const jobs = createRepositories(f.db).jobs;
    const [job] = await jobs.claim({
      workerId: "worker",
      limit: 1,
      types: ["reconcile_session"],
    });
    await f.repository.claimSync(
      f.userId,
      turn!.id,
      "worker",
      job!.leaseGeneration,
    );
    await f.client.query(
      "update background_jobs set attempts=max_attempts,locked_at=now()-interval '10 minutes' where id=$1",
      [job!.id],
    );
    await f.repository.recoverSyncJobs(f.now);
    expect(
      (await f.repository.listTurns(f.userId, f.sessionId))[0]?.artifactState,
    ).toBe("failed");
    expect((await f.repository.listNotifications(f.userId, 20))[0]?.kind).toBe(
      "sync_failed",
    );
    expect(
      await f.repository.requestSyncRetry(f.userId, turn!.id, f.now, 300_000),
    ).toBe(true);
  });

  it("deduplicates rounds and jobs, then emits one owner-scoped completion notification", async () => {
    const f = await fixture();
    const input = {
      now: f.now,
      upstreamStatus: "idle",
      retryWindowMs: 300_000,
    };
    await f.repository.recordObservations(
      f.userId,
      f.sessionId,
      [f.observation],
      input,
    );
    await f.repository.recordObservations(
      f.userId,
      f.sessionId,
      [f.observation],
      input,
    );
    const turns = await f.repository.listTurns(f.userId, f.sessionId);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      outcome: "completed",
      artifactState: "pending",
      usageState: "pending",
    });
    expect(
      (
        await f.client.query(
          "select * from background_jobs where payload->>'operation'='sync_artifacts'",
        )
      ).rows,
    ).toHaveLength(1);
    const [job] = await createRepositories(f.db).jobs.claim({
      workerId: "worker",
      limit: 1,
      types: ["reconcile_session"],
    });
    const claimed = await f.repository.claimSync(
      f.userId,
      turns[0]!.id,
      "worker",
      job!.leaseGeneration,
    );
    expect(claimed?.turn.id).toBe(turns[0]!.id);
    const finish = {
      artifactState: "synced" as const,
      artifactIds: [],
      errorCode: null,
      now: f.now,
    };
    expect(
      await f.repository.finishSync(
        f.userId,
        turns[0]!.id,
        "worker",
        job!.leaseGeneration,
        finish,
      ),
    ).toBe(true);
    expect(
      await f.repository.finishSync(
        f.userId,
        turns[0]!.id,
        "worker",
        job!.leaseGeneration,
        finish,
      ),
    ).toBe(true);
    const notifications = await f.repository.listNotifications(f.userId, 20);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      kind: "completed",
      readAt: null,
      sessionId: f.sessionId,
    });
    expect(await f.repository.listTurns(id(), f.sessionId)).toEqual([]);
    expect(await f.repository.listNotifications(id(), 20)).toEqual([]);
    expect(
      await f.repository.markNotificationRead(id(), notifications[0]!.id),
    ).toBe(false);
    expect(
      await f.repository.markNotificationRead(f.userId, notifications[0]!.id),
    ).toBe(true);
  });

  it("does not burn artifact retry attempts while background delivery is paused", async () => {
    const f = await fixture();
    await f.repository.recordObservations(
      f.userId,
      f.sessionId,
      [f.observation],
      { now: f.now, upstreamStatus: "idle", retryWindowMs: 300_000 },
    );
    const jobs = createRepositories(f.db).jobs;
    const [job] = await jobs.claim({
      workerId: "worker",
      limit: 1,
      types: ["reconcile_session"],
    });
    const resumed = new Date(f.now.getTime() + 600_000);
    await jobs.retry(
      job!.id,
      "worker",
      "ARTIFACT_SYNC_PAUSED",
      false,
      job!.leaseGeneration,
      resumed,
    );
    expect(
      (
        await f.client.query(
          "select attempts,status from background_jobs where id=$1",
          [job!.id],
        )
      ).rows[0],
    ).toMatchObject({ attempts: 0, status: "pending" });
    const [turn] = await f.repository.listTurns(f.userId, f.sessionId);
    expect(turn!.retryUntil.getTime()).toBeGreaterThanOrEqual(
      resumed.getTime() + 300_000,
    );
  });

  it("bounds an earlier turn with a later input even before the later turn ends", async () => {
    const f = await fixture();
    await f.repository.recordObservations(
      f.userId,
      f.sessionId,
      [f.observation],
      { now: f.now, upstreamStatus: "idle", retryWindowMs: 300_000 },
    );
    const nextStartedAt = new Date(f.now.getTime() + 1000);
    await f.client.query(
      "insert into session_events(session_id,event_id,source_type,type,occurred_at,payload) values($1,'next-input','user.message','message',$2,'{}')",
      [f.sessionId, nextStartedAt],
    );
    const [job] = await createRepositories(f.db).jobs.claim({
      workerId: "worker",
      limit: 1,
      types: ["reconcile_session"],
    });
    expect(
      await f.repository.claimSync(
        f.userId,
        job!.id,
        "worker",
        job!.leaseGeneration,
      ),
    ).toMatchObject({ nextStartedAt });
  });

  it("uses upstream order at a tied boundary and cannot copy or refresh the next turn output", async () => {
    const f = await fixture();
    await f.repository.recordObservations(
      f.userId,
      f.sessionId,
      [{ ...f.observation, expectedNames: ["report.txt"] }],
      { now: f.now, upstreamStatus: "idle", retryWindowMs: 300_000 },
    );
    await f.client.query(
      "insert into session_events(session_id,event_id,source_type,type,occurred_at,history_position,payload) values($1,'end','session.status_idle','status',$2,2,'{}'),($1,'next-input','user.message','message',$2,3,'{}')",
      [f.sessionId, f.observation.endedAt],
    );
    const [job] = await createRepositories(f.db).jobs.claim({
      workerId: "worker",
      limit: 1,
      types: ["reconcile_session"],
    });
    const repositories = createRepositories(f.db);
    const did = id(),
      fid = id();
    const objectKey = `tenants/${f.userId}/drive/artifact/${did}/report.txt`;
    await repositories.driveFiles.stage({
      id: did,
      ownerUserId: f.userId,
      origin: "artifact",
      objectKey,
      name: "report.txt",
      mimeType: "text/plain",
      sizeBytes: 3,
      sourceSessionId: f.sessionId,
      runAfter: new Date(f.now.getTime() + 60_000),
      writeLeaseUntil: new Date(f.now.getTime() + 60_000),
    });
    await repositories.driveFiles.commit({ id: did, ownerUserId: f.userId });
    await repositories.artifacts.upsertAssociation({
      id: fid,
      ownerUserId: f.userId,
      sessionId: f.sessionId,
      arkFileId: "next-file",
      driveFileId: did,
      tosObjectKey: objectKey,
      name: "report.txt",
      mimeType: "text/plain",
      sizeBytes: 3,
      generatedAt: f.observation.endedAt,
      deletionState: "none",
      lastErrorCode: null,
      createdAt: f.now,
      updatedAt: f.now,
    });
    const write = vi.fn(async () => {});
    const storage = {
      readExternal: async () => Readable.from(["new bytes"]),
      write,
      delete: async () => {},
    };
    const drive = new DriveFileService({
      repository: repositories.driveFiles,
      storage,
      createId: id,
    });
    const ark = {
      getSession: async () => ({ status: "idle" }),
      listArtifacts: async () => [
        {
          id: "next-file",
          name: "report.txt",
          sessionId: `remote-${f.sessionId}`,
          createdAt: f.observation.endedAt.toISOString(),
          contentType: "text/plain",
          size: 3,
          tos: { bucket: "test", objectKey: "next-bytes" },
        },
      ],
    };
    const artifacts = new ArtifactService({
      repository: repositories.artifacts,
      drive,
      ark: ark as never,
      storage: {} as never,
      createId: id,
    });
    const service = new SessionDeliveryService({
      repository: f.repository,
      sessions: { reconcileHistory: vi.fn() } as never,
      ark: ark as never,
      artifacts,
      now: () => f.now,
    });
    await expect(
      service.syncArtifacts(job!.id, {
        userId: f.userId,
        workerId: "worker",
        leaseGeneration: job!.leaseGeneration,
        requestId: "tie",
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_SYNC_PENDING" });
    expect(write).not.toHaveBeenCalled();
    expect(
      (await repositories.driveFiles.findOwned(f.userId, did))?.tosObjectKey,
    ).toBe(objectKey);
    const [turn] = await f.repository.listTurns(f.userId, f.sessionId);
    expect(turn).toMatchObject({ artifactState: "pending", artifactIds: [] });
  });

  it("preserves waiting, failure and unknown boundaries without claiming completed delivery", async () => {
    const f = await fixture();
    for (const outcome of ["waiting", "failed", "confirming"] as const) {
      await f.repository.recordObservations(
        f.userId,
        f.sessionId,
        [{ ...f.observation, boundaryEventId: outcome, outcome }],
        { now: f.now, upstreamStatus: "idle", retryWindowMs: 300_000 },
      );
    }
    expect(
      (await f.repository.listTurns(f.userId, f.sessionId))
        .map((turn) => turn.outcome)
        .sort(),
    ).toEqual(["confirming", "failed", "waiting"]);
    expect(
      (
        await f.client.query(
          "select * from background_jobs where payload->>'operation'='sync_artifacts'",
        )
      ).rows,
    ).toHaveLength(0);
    const kinds = (await f.repository.listNotifications(f.userId, 20)).map(
      (item) => item.kind,
    );
    expect(kinds).not.toContain("completed");
    expect(kinds).toContain("failed");
    expect(kinds).toContain("needs_action");
  });

  it("rejects stale leases and suppresses completion during unknown delivery or deletion", async () => {
    const f = await fixture();
    await f.repository.recordObservations(
      f.userId,
      f.sessionId,
      [f.observation],
      { now: f.now, upstreamStatus: "idle", retryWindowMs: 300_000 },
    );
    const [turn] = await f.repository.listTurns(f.userId, f.sessionId);
    const [job] = await createRepositories(f.db).jobs.claim({
      workerId: "worker",
      limit: 1,
      types: ["reconcile_session"],
    });
    expect(
      await f.repository.claimSync(
        f.userId,
        turn!.id,
        "stale",
        job!.leaseGeneration,
      ),
    ).toBeUndefined();
    await f.client.query(
      "update sessions set message_unknown_outcome=true where id=$1",
      [f.sessionId],
    );
    expect(
      (
        await f.repository.claimSync(
          f.userId,
          turn!.id,
          "worker",
          job!.leaseGeneration,
        )
      )?.blocked,
    ).toBe(true);
    expect(
      await f.repository.finishSync(
        f.userId,
        turn!.id,
        "worker",
        job!.leaseGeneration,
        {
          artifactState: "synced",
          artifactIds: [],
          errorCode: null,
          now: f.now,
        },
      ),
    ).toBe(false);
    await f.client.query(
      "update sessions set message_unknown_outcome=false,deletion_state='pending' where id=$1",
      [f.sessionId],
    );
    expect(
      await f.repository.claimSync(
        f.userId,
        turn!.id,
        "worker",
        job!.leaseGeneration,
      ),
    ).toBeUndefined();
    expect(await f.repository.listNotifications(f.userId, 20)).toEqual([]);
  });

  it("recovers failed synchronization into the same round and job without duplicate notifications", async () => {
    const f = await fixture();
    await f.repository.recordObservations(
      f.userId,
      f.sessionId,
      [f.observation],
      { now: f.now, upstreamStatus: "idle", retryWindowMs: 300_000 },
    );
    const [turn] = await f.repository.listTurns(f.userId, f.sessionId);
    const jobs = createRepositories(f.db).jobs;
    const [job] = await jobs.claim({
      workerId: "worker",
      limit: 1,
      types: ["reconcile_session"],
    });
    await f.repository.claimSync(
      f.userId,
      turn!.id,
      "worker",
      job!.leaseGeneration,
    );
    await f.repository.finishSync(
      f.userId,
      turn!.id,
      "worker",
      job!.leaseGeneration,
      {
        artifactState: "failed",
        artifactIds: [],
        errorCode: "ARTIFACT_SYNC_FAILED",
        now: f.now,
      },
    );
    await jobs.succeed(job!.id, "worker", job!.leaseGeneration);
    expect(
      await f.repository.requestSyncRetry(id(), turn!.id, f.now, 300_000),
    ).toBe(false);
    expect(
      await f.repository.requestSyncRetry(f.userId, turn!.id, f.now, 300_000),
    ).toBe(true);
    const [retry] = await jobs.claim({
      workerId: "recovery",
      limit: 1,
      types: ["reconcile_session"],
    });
    expect(retry?.id).toBe(job!.id);
    expect(retry!.leaseGeneration).toBeGreaterThan(job!.leaseGeneration);
    await f.repository.claimSync(
      f.userId,
      turn!.id,
      "recovery",
      retry!.leaseGeneration,
    );
    expect(
      await f.repository.finishSync(
        f.userId,
        turn!.id,
        "worker",
        job!.leaseGeneration,
        {
          artifactState: "synced",
          artifactIds: [],
          errorCode: null,
          now: f.now,
        },
      ),
    ).toBe(false);
    await f.repository.finishSync(
      f.userId,
      turn!.id,
      "recovery",
      retry!.leaseGeneration,
      { artifactState: "synced", artifactIds: [], errorCode: null, now: f.now },
    );
    expect(
      (await f.repository.listTurns(f.userId, f.sessionId))[0]?.artifactState,
    ).toBe("synced");
    expect(
      (await f.repository.listNotifications(f.userId, 20)).filter(
        (n) => n.kind === "completed",
      ),
    ).toHaveLength(1);
  });
});

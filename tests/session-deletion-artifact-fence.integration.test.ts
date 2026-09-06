import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { ArtifactObjectCleanupProcessor } from "../apps/worker/src/artifact-object-cleanup.js";
import { SessionDeletionProcessor } from "../apps/worker/src/session-deletion.js";
import { createRepositories } from "../packages/db/src/index.js";
import {
  ArtifactService,
  type SessionRecord,
} from "../packages/domain/src/index.js";
import { createTestDatabase, id } from "./support/test-database.js";

async function seedSession(
  client: Awaited<ReturnType<typeof createTestDatabase>>["client"],
  repositories: ReturnType<typeof createRepositories>,
) {
  const userId = id();
  const agentId = id();
  const sessionId = id();
  const timestamp = new Date("2026-09-06T00:00:00.000Z");
  await client.query(
    `insert into users (id, auth_subject, email)
     values ($1, $2, $3)`,
    [userId, `subject-${userId}`, `${userId}@example.com`],
  );
  await client.query(
    `insert into quota_policies
      (key, personal_agent_limit, concurrent_session_limit,
       daily_session_limit, monthly_token_limit)
     values ('default', 10, 2, 5, 1000)`,
  );
  await client.query(
    `insert into personal_agents
      (id, owner_user_id, ark_agent_id, name, model_id, system_prompt,
       ark_version, status)
     values ($1, $2, 'ark-agent-1', 'Agent', 'model-a', 'Prompt', '1', 'active')`,
    [agentId, userId],
  );
  const intent: SessionRecord = {
    id: sessionId,
    ownerUserId: userId,
    arkSessionId: `pending:${sessionId}`,
    agentKind: "personal",
    platformAgentId: null,
    personalAgentId: agentId,
    arkAgentId: "ark-agent-1",
    agentName: "Agent",
    agentVersion: "1",
    environmentId: "environment-1",
    title: "Task",
    status: "idle",
    lastErrorCode: null,
    errorRecoverable: null,
    archivedAt: null,
    deletionState: "none",
    lastEventAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await repositories.sessionLifecycle.prepareCreate(intent);
  await repositories.sessionLifecycle.completeCreate(sessionId, userId, {
    arkSessionId: "ark-session-1",
    arkAgentId: "ark-agent-1",
    agentVersion: "1",
    status: "idle",
  });
  return { sessionId, userId };
}

function deletionArk() {
  return {
    getSession: vi.fn(async () => ({
      id: "ark-session-1",
      agentId: "ark-agent-1",
      agentVersion: 1,
      environmentId: "environment-1",
      status: "idle" as const,
    })),
    submitEvent: vi.fn(async () => ({
      id: "event-1",
      type: "user.interrupt",
      createdAt: "2026-09-06T00:00:00.000Z",
      data: {},
    })),
    deleteSession: vi.fn(async () => undefined),
  };
}

describe("Session deletion artifact fence", () => {
  it("waits for an in-flight staged upload cleanup before reporting deletion success", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { sessionId, userId } = await seedSession(
      database.client,
      repositories,
    );
    const artifactId = id();
    const cleanupJobId = id();
    const replacementCleanupJobId = id();
    const objectKey = `tenants/${userId}/sessions/${sessionId}/artifacts/file/version`;
    const objects = new Set<string>();
    const missingDeletes: string[] = [];
    const existingDeletes: string[] = [];
    let signalWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      signalWriteStarted = resolve;
    });
    let releaseWrite!: () => void;
    const writeReleased = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const storage = {
      write: vi.fn(async (key: string, stream: Readable) => {
        signalWriteStarted();
        await writeReleased;
        for await (const chunk of stream) {
          // Consume the stream before making the staged object visible.
          void chunk;
        }
        objects.add(key);
      }),
      openRead: vi.fn(async () => Readable.from([])),
      delete: vi.fn(async (key: string) => {
        (objects.has(key) ? existingDeletes : missingDeletes).push(key);
        objects.delete(key);
      }),
    };
    const syncArk = {
      listArtifacts: vi.fn(async () => [
        {
          id: "ark-output-1",
          sessionId: "ark-session-1",
          mountPath: "/mnt/session/outputs/report.txt",
          name: "report.txt",
          contentType: "text/plain",
          size: 4,
          createdAt: "2026-09-06T00:00:00.000Z",
        },
      ]),
      downloadFile: vi.fn(async () => ({
        stream: Readable.from(["data"]),
        contentLength: 4,
      })),
    };
    const ids = [artifactId, cleanupJobId, replacementCleanupJobId];
    const artifacts = new ArtifactService({
      repository: repositories.artifacts,
      ark: syncArk,
      storage,
      createId: () => ids.shift()!,
      objectKey: () => objectKey,
      now: () => new Date("2099-09-06T00:00:00.000Z"),
    });
    const deletion = new SessionDeletionProcessor({
      jobs: repositories.jobs,
      repository: repositories.sessionDeletion,
      ark: deletionArk(),
      storage,
      workerId: "session-delete-worker",
    });
    const cleanup = new ArtifactObjectCleanupProcessor({
      jobs: repositories.jobs,
      service: artifacts,
      workerId: "artifact-cleanup-worker",
    });

    const sync = artifacts.syncSession(sessionId, {
      userId,
      requestId: "racing-sync",
    });
    await writeStarted;
    await repositories.sessionLifecycle.beginDelete(userId, sessionId);
    await database.client.query(
      `update background_jobs
          set run_after = now()
        where id = $1 and type = 'cleanup_artifact_object'`,
      [cleanupJobId],
    );
    await cleanup.runOnce();
    await deletion.runOnce();
    const blocked = await database.client.query<{
      session_count: number;
      deletion_status: string;
      cleanup_status: string;
    }>(
      `select
         (select count(*)::integer from sessions where id = $1) session_count,
         (select status::text from background_jobs where id = $1)
           deletion_status,
         (select status::text from background_jobs where id = $2)
           cleanup_status`,
      [sessionId, cleanupJobId],
    );

    releaseWrite();
    const synced = await sync;
    await cleanup.runOnce();
    await database.client.query(
      `update background_jobs
          set run_after = now()
        where id = $1 and type = 'delete_session' and status = 'pending'`,
      [sessionId],
    );
    await deletion.runOnce();
    const settled = await database.client.query<{
      session_count: number;
      deletion_status: string;
      cleanup_status: string;
    }>(
      `select
         (select count(*)::integer from sessions where id = $1) session_count,
         (select status::text from background_jobs where id = $1)
           deletion_status,
         (select status::text from background_jobs where id = $2)
           cleanup_status`,
      [sessionId, cleanupJobId],
    );
    await database.close();

    expect(blocked.rows[0]).toEqual({
      session_count: 1,
      deletion_status: "pending",
      cleanup_status: "pending",
    });
    expect(synced).toEqual([]);
    expect(settled.rows[0]).toEqual({
      session_count: 0,
      deletion_status: "succeeded",
      cleanup_status: "succeeded",
    });
    expect(objects).toEqual(new Set());
    expect(missingDeletes).toContain(objectKey);
    expect(existingDeletes).toEqual([objectKey]);
  });

  it("resets an exact-maxAttempts cleanup generation for one fresh leased DELETE", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { sessionId, userId } = await seedSession(
      database.client,
      repositories,
    );
    const artifactId = id();
    const cleanupJobId = id();
    const replacementCleanupJobId = id();
    const ids = [artifactId, cleanupJobId, replacementCleanupJobId];
    const objectKey = `tenants/${userId}/sessions/${sessionId}/artifacts/file/late`;
    const uploadStartedAt = new Date("2099-09-06T00:00:00.000Z");
    const expiryCleanupAt = new Date("2099-09-06T00:05:00.000Z");
    const beforeLeaseExpiryAt = new Date("2099-09-06T00:09:59.999Z");
    const leaseExpiryAt = new Date("2099-09-06T00:10:00.000Z");
    let recoveryNow = beforeLeaseExpiryAt;
    const objects = new Set<string>();
    const deletes: Array<{ key: string; existed: boolean }> = [];
    let signalWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      signalWriteStarted = resolve;
    });
    let releaseWrite!: () => void;
    const writeReleased = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let signalExpiryDelete!: () => void;
    const expiryDeleteStarted = new Promise<void>((resolve) => {
      signalExpiryDelete = resolve;
    });
    let releaseExpiryDelete!: () => void;
    const expiryDeleteReleased = new Promise<void>((resolve) => {
      releaseExpiryDelete = resolve;
    });
    const storage = {
      write: vi.fn(async (key: string, stream: Readable) => {
        signalWriteStarted();
        await writeReleased;
        for await (const chunk of stream) void chunk;
        objects.add(key);
      }),
      openRead: vi.fn(async () => Readable.from([])),
      delete: vi.fn(async (key: string) => {
        const existed = objects.delete(key);
        deletes.push({ key, existed });
        if (deletes.length === 1) {
          signalExpiryDelete();
          await expiryDeleteReleased;
        }
      }),
    };
    const artifacts = new ArtifactService({
      repository: repositories.artifacts,
      ark: {
        listArtifacts: vi.fn(async () => [
          {
            id: "ark-output-1",
            sessionId: "ark-session-1",
            mountPath: "/mnt/session/outputs/report.txt",
            name: "report.txt",
            contentType: "text/plain",
            size: 4,
            createdAt: "2026-09-06T00:00:00.000Z",
          },
        ]),
        downloadFile: vi.fn(async () => ({
          stream: Readable.from(["data"]),
          contentLength: 4,
        })),
      },
      storage,
      createId: () => ids.shift()!,
      objectKey: () => objectKey,
      now: () => uploadStartedAt,
    });
    const staleCleanup = new ArtifactObjectCleanupProcessor({
      jobs: repositories.jobs,
      service: artifacts,
      workerId: "stale-cleanup-worker",
      now: () => expiryCleanupAt,
    });
    const recoveryCleanup = new ArtifactObjectCleanupProcessor({
      jobs: repositories.jobs,
      service: artifacts,
      workerId: "recovery-cleanup-worker",
      now: () => recoveryNow,
    });
    const deletion = new SessionDeletionProcessor({
      jobs: repositories.jobs,
      repository: repositories.sessionDeletion,
      ark: deletionArk(),
      storage,
      workerId: "session-delete-worker",
    });

    const sync = artifacts.syncSession(sessionId, {
      userId,
      requestId: "late-put-after-expiry",
    });
    await writeStarted;
    await repositories.sessionLifecycle.beginDelete(userId, sessionId);
    await database.client.query(
      `update background_jobs
          set attempts = 2, max_attempts = 3
        where id = $1 and type = 'cleanup_artifact_object'`,
      [cleanupJobId],
    );

    const staleRun = staleCleanup.runOnce();
    await expiryDeleteStarted;
    const exhaustedLease = await database.client.query<{
      status: string;
      attempts: number;
      max_attempts: number;
      locked_by: string;
    }>(
      `select status::text, attempts, max_attempts, locked_by
         from background_jobs
        where id = $1`,
      [cleanupJobId],
    );
    expect(exhaustedLease.rows[0]).toEqual({
      status: "running",
      attempts: 3,
      max_attempts: 3,
      locked_by: "stale-cleanup-worker",
    });
    await deletion.runOnce();
    releaseWrite();
    await expect(sync).resolves.toEqual([]);
    releaseExpiryDelete();
    await staleRun;

    await database.client.query(
      `update background_jobs
          set run_after = now()
        where id = $1 and type = 'delete_session' and status = 'pending'`,
      [sessionId],
    );
    await deletion.runOnce();
    const fenced = await database.client.query<{
      session_count: number;
      deletion_status: string;
      cleanup_status: string;
      cleanup_attempts: number;
      cleanup_locked_at: Date;
      cleanup_locked_by: string;
      cleanup_generation: number;
      cleanup_max_attempts: number;
    }>(
      `select
         (select count(*)::integer from sessions where id = $1) session_count,
         (select status::text from background_jobs where id = $1)
           deletion_status,
         (select status::text from background_jobs where id = $2)
           cleanup_status,
         (select attempts from background_jobs where id = $2)
           cleanup_attempts,
         (select locked_at from background_jobs where id = $2)
           cleanup_locked_at,
         (select locked_by from background_jobs where id = $2)
           cleanup_locked_by,
         (select (payload ->> 'cleanupGeneration')::integer
            from background_jobs where id = $2)
           cleanup_generation,
         (select max_attempts from background_jobs where id = $2)
           cleanup_max_attempts`,
      [sessionId, cleanupJobId],
    );

    await expect(recoveryCleanup.runOnce()).resolves.toBe(0);
    expect(deletes).toHaveLength(2);
    recoveryNow = leaseExpiryAt;
    await expect(recoveryCleanup.runOnce()).resolves.toBe(1);
    await database.client.query(
      `update background_jobs
          set run_after = now()
        where id = $1 and type = 'delete_session' and status = 'pending'`,
      [sessionId],
    );
    await deletion.runOnce();
    const recovered = await database.client.query<{
      session_count: number;
      deletion_status: string;
      cleanup_status: string;
      cleanup_attempts: number;
      cleanup_max_attempts: number;
    }>(
      `select
         (select count(*)::integer from sessions where id = $1) session_count,
         (select status::text from background_jobs where id = $1)
           deletion_status,
         (select status::text from background_jobs where id = $2)
           cleanup_status,
         (select attempts from background_jobs where id = $2)
           cleanup_attempts,
         (select max_attempts from background_jobs where id = $2)
           cleanup_max_attempts`,
      [sessionId, cleanupJobId],
    );
    await expect(recoveryCleanup.runOnce()).resolves.toBe(0);
    await database.close();

    expect(fenced.rows[0]).toEqual({
      session_count: 1,
      deletion_status: "pending",
      cleanup_status: "running",
      cleanup_attempts: 0,
      cleanup_locked_at: expiryCleanupAt,
      cleanup_locked_by: "stale-cleanup-worker",
      cleanup_generation: 1,
      cleanup_max_attempts: 3,
    });
    expect(recovered.rows[0]).toEqual({
      session_count: 0,
      deletion_status: "succeeded",
      cleanup_status: "succeeded",
      cleanup_attempts: 1,
      cleanup_max_attempts: 3,
    });
    expect(objects).toEqual(new Set());
    expect(deletes).toEqual([
      { key: objectKey, existed: false },
      { key: objectKey, existed: false },
      { key: objectKey, existed: true },
    ]);
  });

  it("stops waiting after a crashed uploader fence expires", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { sessionId, userId } = await seedSession(
      database.client,
      repositories,
    );
    const cleanupJobId = id();
    const objectKey = `tenants/${userId}/sessions/${sessionId}/artifacts/file/crashed`;
    let cleanupNow = new Date("2099-09-06T00:00:00.000Z");
    const uploadInProgressUntil = new Date("2099-09-06T00:05:00.000Z");
    const storage = {
      delete: vi.fn(async () => undefined),
    };
    await repositories.artifacts.stageCleanup({
      id: cleanupJobId,
      ownerUserId: userId,
      sessionId,
      objectKey,
      runAfter: cleanupNow,
      uploadInProgressUntil,
    });
    await repositories.sessionLifecycle.beginDelete(userId, sessionId);
    const cleanup = new ArtifactObjectCleanupProcessor({
      jobs: repositories.jobs,
      service: new ArtifactService({
        repository: repositories.artifacts,
        ark: {
          listArtifacts: vi.fn(async () => []),
          downloadFile: vi.fn(),
        },
        storage: {
          ...storage,
          write: vi.fn(),
          openRead: vi.fn(),
        },
        createId: id,
      }),
      workerId: "artifact-cleanup-worker",
      now: () => cleanupNow,
    });
    const deletion = new SessionDeletionProcessor({
      jobs: repositories.jobs,
      repository: repositories.sessionDeletion,
      ark: deletionArk(),
      storage,
      workerId: "session-delete-worker",
    });

    await cleanup.runOnce();
    await deletion.runOnce();
    const blocked = await database.client.query<{
      session_count: number;
      cleanup_status: string;
    }>(
      `select
         (select count(*)::integer from sessions where id = $1) session_count,
         (select status::text from background_jobs where id = $2)
           cleanup_status`,
      [sessionId, cleanupJobId],
    );

    cleanupNow = new Date("2099-09-06T00:05:01.000Z");
    await cleanup.runOnce();
    await database.client.query(
      `update background_jobs
          set run_after = now()
        where id = $1 and type = 'delete_session' and status = 'pending'`,
      [sessionId],
    );
    await deletion.runOnce();
    const settled = await database.client.query<{
      session_count: number;
      deletion_status: string;
      cleanup_status: string;
    }>(
      `select
         (select count(*)::integer from sessions where id = $1) session_count,
         (select status::text from background_jobs where id = $1)
           deletion_status,
         (select status::text from background_jobs where id = $2)
           cleanup_status`,
      [sessionId, cleanupJobId],
    );
    await database.close();

    expect(blocked.rows[0]).toEqual({
      session_count: 1,
      cleanup_status: "pending",
    });
    expect(settled.rows[0]).toEqual({
      session_count: 0,
      deletion_status: "succeeded",
      cleanup_status: "succeeded",
    });
  });

  it("prevents a sync that passed authorization from staging after deletion wins", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { sessionId, userId } = await seedSession(
      database.client,
      repositories,
    );
    let signalArtifactListStarted!: () => void;
    const artifactListStarted = new Promise<void>((resolve) => {
      signalArtifactListStarted = resolve;
    });
    let releaseArtifactList!: () => void;
    const artifactListReleased = new Promise<void>((resolve) => {
      releaseArtifactList = resolve;
    });
    const objectKey = `tenants/${userId}/sessions/${sessionId}/artifacts/file/version`;
    const objects = new Set<string>();
    const storage = {
      write: vi.fn(async (key: string) => {
        objects.add(key);
      }),
      openRead: vi.fn(async () => Readable.from([])),
      delete: vi.fn(async (key: string) => {
        objects.delete(key);
      }),
    };
    const artifacts = new ArtifactService({
      repository: repositories.artifacts,
      ark: {
        listArtifacts: vi.fn(async () => {
          signalArtifactListStarted();
          await artifactListReleased;
          return [
            {
              id: "ark-output-1",
              sessionId: "ark-session-1",
              mountPath: "/mnt/session/outputs/report.txt",
              name: "report.txt",
              contentType: "text/plain",
              size: 4,
              createdAt: "2026-09-06T00:00:00.000Z",
            },
          ];
        }),
        downloadFile: vi.fn(async () => ({
          stream: Readable.from(["data"]),
          contentLength: 4,
        })),
      },
      storage,
      createId: id,
      objectKey: () => objectKey,
    });
    const deletion = new SessionDeletionProcessor({
      jobs: repositories.jobs,
      repository: repositories.sessionDeletion,
      ark: deletionArk(),
      storage,
      workerId: "session-delete-worker",
    });

    const sync = artifacts.syncSession(sessionId, {
      userId,
      requestId: "pre-fence-sync",
    });
    await artifactListStarted;
    await repositories.sessionLifecycle.beginDelete(userId, sessionId);
    await deletion.runOnce();
    releaseArtifactList();
    const syncResult = await sync.catch((error: unknown) => error);
    const cleanupJobs = await database.client.query<{ count: number }>(
      `select count(*)::integer count
         from background_jobs
        where owner_user_id = $1
          and type = 'cleanup_artifact_object'
          and payload ->> 'objectKey' like $2`,
      [userId, `tenants/${userId}/sessions/${sessionId}/artifacts/%`],
    );
    await database.close();

    expect(syncResult).toMatchObject({ name: "ResourceNotFoundError" });
    expect(storage.write).not.toHaveBeenCalled();
    expect(objects).toEqual(new Set());
    expect(cleanupJobs.rows[0]?.count).toBe(0);
  });

  it("keeps the Session and deletion failure visible when cleanup is exhausted", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { sessionId, userId } = await seedSession(
      database.client,
      repositories,
    );
    const cleanupJobId = id();
    const objectKey = `tenants/${userId}/sessions/${sessionId}/artifacts/file/version`;
    await repositories.artifacts.stageCleanup({
      id: cleanupJobId,
      ownerUserId: userId,
      sessionId,
      objectKey,
      runAfter: new Date("2026-09-06T00:00:00.000Z"),
    });
    await database.client.query(
      `update background_jobs
          set status = 'failed', attempts = max_attempts,
              last_error = 'ARTIFACT_CLEANUP_FAILED'
        where id = $1`,
      [cleanupJobId],
    );
    await repositories.sessionLifecycle.beginDelete(userId, sessionId);
    await database.client.query(
      `update background_jobs set max_attempts = 1 where id = $1`,
      [sessionId],
    );
    const deletion = new SessionDeletionProcessor({
      jobs: repositories.jobs,
      repository: repositories.sessionDeletion,
      ark: deletionArk(),
      storage: { delete: vi.fn(async () => undefined) },
      workerId: "session-delete-worker",
    });

    await deletion.runOnce();
    const state = await database.client.query<{
      deletion_state: string;
      deletion_status: string;
      deletion_error: string;
      cleanup_status: string;
    }>(
      `select session.deletion_state,
              deletion.status::text deletion_status,
              deletion.last_error deletion_error,
              cleanup.status::text cleanup_status
         from sessions session
         join background_jobs deletion on deletion.id = session.id
         join background_jobs cleanup on cleanup.id = $2
        where session.id = $1`,
      [sessionId, cleanupJobId],
    );
    await database.close();

    expect(state.rows[0]).toEqual({
      deletion_state: "deletion_failed",
      deletion_status: "failed",
      deletion_error: "SESSION_DELETE_FAILED",
      cleanup_status: "failed",
    });
  });
});

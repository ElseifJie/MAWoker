import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { DriveObjectCleanupProcessor } from "../apps/worker/src/drive-object-cleanup.js";
import { SessionDeletionProcessor } from "../apps/worker/src/session-deletion.js";
import { createRepositories } from "../packages/db/src/index.js";
import {
  ArtifactService,
  DriveFileService,
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
    `insert into users (id, auth_subject, email) values ($1, $2, $3)`,
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
    createAttemptedAt: null,
    modelId: null,
    configSnapshot: null,
    configSnapshotState: "unverified",
    configSnapshotErrorCode: null,
    title: "Task",
    status: "idle",
    lastErrorCode: null,
    errorRecoverable: null,
    archivedAt: null,
    pinnedAt: null,
    deletionState: "none",
    lastEventAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await repositories.sessionLifecycle.prepareCreate(intent);
  await repositories.sessionLifecycle.completeCreate(sessionId, userId, {
    arkSessionId: "ark-session-1",
    status: "idle",
    modelId: "model-a",
    configSnapshot: {
      agentId: "ark-agent-1",
      agentVersion: "1",
      environmentId: "environment-1",
      modelId: "model-a",
      skills: [],
      tools: [],
      environment: {
        id: "environment-1",
        type: "environment",
        configType: "cloud",
        scope: "account",
      },
      completeness: "complete",
    },
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
      configSnapshot: {
        modelId: "model-a",
        skills: [],
        tools: [],
        environment: {
          id: "environment-1",
          type: "environment",
          configType: "cloud",
          scope: "account",
        },
        completeness: "complete" as const,
      },
    })),
    submitEvent: vi.fn(async () => ({
      id: "event-1",
      type: "user.interrupt",
      createdAt: "2026-09-06T00:00:00.000Z",
      data: {},
    })),
    deleteSession: vi.fn(async () => undefined),
    // The settlement gate reads the full history: an empty event list is a
    // confirmed empty task, which is the normal shape for these fixtures.
    listEvents: vi.fn(async () => []),
  };
}

describe("Session deletion and drive cleanup fencing", () => {
  it("preserves a staged object with an unknown write outcome while removing the Session", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { sessionId, userId } = await seedSession(
      database.client,
      repositories,
    );
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
    const storage = {
      write: vi.fn(async (key: string, stream: Readable) => {
        signalWriteStarted();
        await writeReleased;
        for await (const chunk of stream) void chunk;
        objects.add(key);
      }),
      openRead: vi.fn(async () => Readable.from([])),
      readExternal: vi.fn(async () => Readable.from(["data"])),
      delete: vi.fn(async (key: string) => {
        deletes.push({ key, existed: objects.delete(key) });
      }),
    };
    const drive = new DriveFileService({
      repository: repositories.driveFiles,
      storage,
      createId: id,
      // A realistic clock: the staged write lease (now + 5 minutes) is long
      // expired by the time the cleanup intent runs, exactly like production
      // where the intent's run_after is the lease end. The 2099 clock on the
      // other services only fixes deterministic row timestamps.
      now: () => new Date("2026-09-06T00:00:00.000Z"),
    });
    const artifacts = new ArtifactService({
      repository: repositories.artifacts,
      drive,
      ark: {
        listArtifacts: vi.fn(async () => [
          {
            id: "ark-output-1",
            sessionId: "ark-session-1",
            name: "report.txt",
            contentType: "text/plain",
            size: 4,
            createdAt: "2026-09-06T00:00:00.000Z",
            tos: {
              bucket: "ark-exports",
              objectKey: "ark/outputs/ark-session-1/report.txt",
            },
          },
        ]),
      },
      storage,
      createId: id,
      now: () => new Date("2099-09-06T00:00:00.000Z"),
    });
    const deletion = new SessionDeletionProcessor({
      jobs: repositories.jobs,
      repository: repositories.sessionDeletion,
      ark: deletionArk(),
      settlement: {
        verify: async () => "confirmed" as const,
      },
      workerId: "session-delete-worker",
      now: () => new Date("2099-09-06T00:00:00.000Z"),
    });
    const cleanup = new DriveObjectCleanupProcessor({
      jobs: repositories.jobs,
      guards: {
        findDriveCleanupGuard: repositories.driveFiles.findCleanupGuard,
        findCleanupJobClaim: repositories.driveFiles.findCleanupJobClaim,
      },
      service: drive,
      workerId: "drive-cleanup-worker",
    });

    // The sync stages its drive row, then pauses mid-write.
    const sync = artifacts.syncSession(sessionId, {
      userId,
      requestId: "racing-sync",
    });
    await writeStarted;

    // Deletion wins while the write is still open.
    await repositories.sessionLifecycle.beginDelete(userId, sessionId);
    releaseWrite();
    const synced = await sync;

    // The commit fence refused to activate the row, so no association exists.
    expect(synced).toEqual([]);
    const associations = await database.client.query<{ count: string }>(
      `select count(*)::text as count from artifacts where session_id = $1`,
      [sessionId],
    );
    expect(associations.rows[0]!.count).toBe("0");
    // The object we wrote is unreferenced but its staging intent survived.
    expect(objects.size).toBe(1);
    const [stagedKey] = [...objects];

    await database.client.query(
      `update background_jobs
          set run_after = now()
        where type = 'cleanup_drive_object' and status = 'pending'`,
    );
    await cleanup.runOnce();
    await deletion.runOnce();

    const sessionCount = await database.client.query<{ count: string }>(
      `select count(*)::text as count from sessions where id = $1`,
      [sessionId],
    );
    expect(sessionCount.rows[0]!.count).toBe("0");
    expect(objects).toEqual(new Set([stagedKey]));
    expect(deletes).toEqual([]);
    const cleanupState = await database.client.query<{
      status: string;
      last_error: string | null;
      deletion_state: string;
      last_error_code: string | null;
    }>(
      `select job.status::text as status,
              job.last_error,
              drive.deletion_state::text as deletion_state,
              drive.last_error_code
         from background_jobs job
         join drive_files drive on drive.id = job.id
        where job.type = 'cleanup_drive_object'
          and drive.tos_object_key = $1`,
      [stagedKey],
    );
    expect(cleanupState.rows).toEqual([
      {
        status: "failed",
        last_error: "DRIVE_CLEANUP_OBJECT_UNVERIFIED",
        deletion_state: "deletion_failed",
        last_error_code: "DRIVE_CLEANUP_OBJECT_UNVERIFIED",
      },
    ]);
    await database.close();
  });

  it("does not let a sync stage once the Session is already deleting", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { sessionId, userId } = await seedSession(
      database.client,
      repositories,
    );
    await repositories.sessionLifecycle.beginDelete(userId, sessionId);

    const staged = await repositories.driveFiles.stage({
      id: id(),
      ownerUserId: userId,
      origin: "artifact",
      objectKey: `tenants/${userId}/drive/artifact/${id()}/report.txt`,
      name: "report.txt",
      mimeType: "text/plain",
      sizeBytes: 4,
      sourceSessionId: sessionId,
      runAfter: new Date("2099-09-06T00:00:00.000Z"),
      writeLeaseUntil: new Date("2099-09-06T00:00:00.000Z"),
    });
    expect(staged).toBe(false);
    await database.close();
  });

  it("ignores a stale drive cleanup completion after the job was re-armed", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { sessionId, userId } = await seedSession(
      database.client,
      repositories,
    );
    const staged = id();
    await repositories.driveFiles.stage({
      id: staged,
      ownerUserId: userId,
      origin: "artifact",
      objectKey: `tenants/${userId}/drive/artifact/${staged}/report.txt`,
      name: "report.txt",
      mimeType: "text/plain",
      sizeBytes: 4,
      sourceSessionId: sessionId,
      runAfter: new Date("2099-09-06T00:00:00.000Z"),
      writeLeaseUntil: new Date("2099-09-06T00:00:00.000Z"),
    });

    const [claimed] = await repositories.jobs.claim({
      workerId: "drive-worker",
      limit: 1,
      now: new Date("2099-09-06T00:00:00.000Z"),
      types: ["cleanup_drive_object"],
    });
    expect(claimed).toBeDefined();
    // A failed write re-arms the intent, bumping its generation.
    await repositories.driveFiles.release(staged, userId);

    // The in-flight worker's completion is now stale and must be refused.
    await expect(
      repositories.jobs.succeedDriveCleanup(staged, "drive-worker", 0, 0),
    ).resolves.toBe(false);
    const drive = await repositories.driveFiles.findOwned(userId, staged);
    expect(drive!.deletionState).toBe("pending");
    await database.close();
  });

  it("preserves unverified error codes behind cleanup generation fences", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId } = await seedSession(database.client, repositories);
    const artifactJobId = id();
    const driveJobId = id();
    const lockedAt = new Date("2026-09-06T00:00:00.000Z");

    await database.client.query(
      `insert into background_jobs
        (id, owner_user_id, type, status, priority, payload, attempts,
         run_after, locked_at, locked_by)
       values
        ($1, $3, 'cleanup_artifact_object', 'running', 90, $4::jsonb, 1,
         $6, $6, 'cleanup-worker'),
        ($2, $3, 'cleanup_drive_object', 'running', 90, $5::jsonb, 1,
         $6, $6, 'cleanup-worker')`,
      [
        artifactJobId,
        driveJobId,
        userId,
        JSON.stringify({
          objectKey: `tenants/${userId}/sessions/legacy/artifacts/file/version`,
          cleanupGeneration: 7,
        }),
        JSON.stringify({
          driveFileId: driveJobId,
          cleanupGeneration: 11,
        }),
        lockedAt,
      ],
    );

    await expect(
      repositories.jobs.retryArtifactCleanup(
        artifactJobId,
        "cleanup-worker",
        6,
        0,
        "ARTIFACT_CLEANUP_OBJECT_UNVERIFIED",
        true,
        lockedAt,
      ),
    ).resolves.toBe(false);
    await expect(
      repositories.jobs.retryDriveCleanup(
        driveJobId,
        "cleanup-worker",
        10,
        0,
        "DRIVE_CLEANUP_OBJECT_UNVERIFIED",
        true,
        lockedAt,
      ),
    ).resolves.toBe(false);
    await expect(
      repositories.jobs.retryArtifactCleanup(
        artifactJobId,
        "cleanup-worker",
        7,
        0,
        "ARTIFACT_CLEANUP_OBJECT_UNVERIFIED",
        true,
        lockedAt,
      ),
    ).resolves.toBe(true);
    await expect(
      repositories.jobs.retryDriveCleanup(
        driveJobId,
        "cleanup-worker",
        11,
        0,
        "DRIVE_CLEANUP_OBJECT_UNVERIFIED",
        true,
        lockedAt,
      ),
    ).resolves.toBe(true);

    const states = await database.client.query<{
      id: string;
      status: string;
      last_error: string;
    }>(
      `select id, status::text as status, last_error
         from background_jobs
        where id in ($1, $2)`,
      [artifactJobId, driveJobId],
    );
    expect(
      Object.fromEntries(
        states.rows.map((row) => [
          row.id,
          { status: row.status, lastError: row.last_error },
        ]),
      ),
    ).toEqual({
      [artifactJobId]: {
        status: "failed",
        lastError: "ARTIFACT_CLEANUP_OBJECT_UNVERIFIED",
      },
      [driveJobId]: {
        status: "failed",
        lastError: "DRIVE_CLEANUP_OBJECT_UNVERIFIED",
      },
    });
    await database.close();
  });
});

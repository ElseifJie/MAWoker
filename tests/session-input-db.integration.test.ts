import { describe, expect, it, vi } from "vitest";
import { UploadCleanupProcessor } from "../apps/worker/src/upload-cleanup.js";
import { createRepositories } from "../packages/db/src/index.js";
import type {
  SessionInputRecord,
  SessionRecord,
} from "../packages/domain/src/index.js";
import { SessionInputService } from "../packages/domain/src/index.js";
import { createTestDatabase, id } from "./support/test-database.js";

const now = new Date("2026-09-06T00:00:00.000Z");

async function seed(
  client: Awaited<ReturnType<typeof createTestDatabase>>["client"],
) {
  const userId = id();
  const otherUserId = id();
  const agentId = id();
  await client.query(
    `insert into users (id, auth_subject, email)
     values ($1, $2, $3), ($4, $5, $6)`,
    [
      userId,
      `subject-${userId}`,
      `${userId}@example.com`,
      otherUserId,
      `subject-${otherUserId}`,
      `${otherUserId}@example.com`,
    ],
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
  return { userId, otherUserId, agentId };
}

function upload(ownerUserId: string): SessionInputRecord {
  const uploadId = id();
  return {
    id: uploadId,
    ownerUserId,
    sessionId: null,
    arkFileId: null,
    originalName: "brief.txt",
    mimeType: "text/plain",
    sizeBytes: 3,
    mountPath: `/mnt/session/inputs/${uploadId}-brief.txt`,
    status: "uploading",
    expiresAt: new Date("2026-09-06T01:00:00.000Z"),
    lastErrorCode: null,
    createdAt: now,
    updatedAt: now,
  };
}

function session(ownerUserId: string, agentId: string): SessionRecord {
  const sessionId = id();
  return {
    id: sessionId,
    ownerUserId,
    arkSessionId: `pending:${sessionId}`,
    agentKind: "personal",
    platformAgentId: null,
    personalAgentId: agentId,
    arkAgentId: "ark-agent-1",
    agentName: "Agent",
    agentVersion: "1",
    environmentId: "environment-1",
    title: "",
    status: "idle",
    lastErrorCode: null,
    errorRecoverable: null,
    archivedAt: null,
    deletionState: "none",
    lastEventAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe("Session input database integration", () => {
  it("persists upload metadata and schedules expiry cleanup", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId } = await seed(database.client);
    const input = upload(userId);

    await repositories.sessionInputs.prepareUpload(input);
    const completed = await repositories.sessionInputs.completeUpload(
      input.id,
      userId,
      {
        arkFileId: "ark-file-1",
        mimeType: "text/plain",
        sizeBytes: 3,
      },
    );

    expect(completed).toMatchObject({
      id: input.id,
      ownerUserId: userId,
      status: "uploaded",
      arkFileId: "ark-file-1",
    });
    const job = await database.client.query<{
      type: string;
      status: string;
      run_after: Date;
      payload: Record<string, unknown>;
    }>(
      `select type, status, run_after, payload
         from background_jobs where id = $1`,
      [input.id],
    );
    expect(job.rows[0]).toMatchObject({
      type: "cleanup_upload",
      status: "pending",
      payload: { uploadId: input.id },
    });
    expect(new Date(job.rows[0]!.run_after).toISOString()).toBe(
      input.expiresAt.toISOString(),
    );
    await database.close();
  });

  it("keeps a failed upload cleanup job pending until expiry", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId } = await seed(database.client);
    const input = upload(userId);
    await repositories.sessionInputs.prepareUpload(input);

    await repositories.sessionInputs.failUpload(
      input.id,
      userId,
      "ARK_UNAVAILABLE",
    );

    const state = await database.client.query<{
      upload_status: string;
      job_status: string;
      last_error: string | null;
    }>(
      `select input.status as upload_status, job.status as job_status,
              job.last_error
         from session_inputs input
         join background_jobs job on job.id = input.id
        where input.id = $1`,
      [input.id],
    );
    expect(state.rows[0]).toEqual({
      upload_status: "failed",
      job_status: "pending",
      last_error: "ARK_UNAVAILABLE",
    });
    await database.close();
  });

  it("discovers every expired unbound cleanup state", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId } = await seed(database.client);
    const states = [
      { status: "uploaded", arkFileId: "ark-uploaded" },
      { status: "failed", arkFileId: null },
      { status: "deleting", arkFileId: "ark-deleting" },
      { status: "uploading", arkFileId: null },
      { status: "uploading", arkFileId: "ark-crash-outcome" },
    ] as const;

    for (const state of states) {
      const input = upload(userId);
      input.expiresAt = new Date("2026-09-05T00:00:00.000Z");
      await repositories.sessionInputs.prepareUpload(input);
      await database.client.query(
        `update session_inputs
            set status = $2, ark_file_id = $3
          where id = $1`,
        [input.id, state.status, state.arkFileId],
      );

      await expect(
        repositories.sessionInputs.findExpiredUnbound(userId, input.id, now),
      ).resolves.toMatchObject({
        id: input.id,
        status: "deleting",
        arkFileId: state.arkFileId,
      });
    }
    await database.close();
  });

  it("recovers a crash-left uploading cleanup job after its lease expires", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId } = await seed(database.client);
    const input = upload(userId);
    input.expiresAt = new Date("2020-01-01T00:00:00.000Z");
    await repositories.sessionInputs.prepareUpload(input);
    await database.client.query(
      `update background_jobs
          set status = 'running', attempts = 1,
              locked_at = '2020-01-01T00:00:00.000Z',
              locked_by = 'dead-worker'
        where id = $1`,
      [input.id],
    );
    const ark = {
      uploadFile: vi.fn(),
      deleteFile: vi.fn(async () => undefined),
    };
    const service = new SessionInputService({
      repository: repositories.sessionInputs,
      ark,
      createId: id,
    });
    const processor = new UploadCleanupProcessor({
      jobs: repositories.jobs,
      service,
      workerId: "recovery-worker",
    });

    await expect(processor.runOnce()).resolves.toBe(1);

    await expect(
      repositories.sessionInputs.findOwned(userId, input.id),
    ).resolves.toBeUndefined();
    expect(ark.deleteFile).not.toHaveBeenCalled();
    const job = await database.client.query<{ status: string }>(
      `select status from background_jobs where id = $1`,
      [input.id],
    );
    expect(job.rows[0]?.status).toBe("succeeded");
    await database.close();
  });

  it("reserves only owned uploaded inputs and rolls back a mixed set", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, otherUserId, agentId } = await seed(database.client);
    const owned = upload(userId);
    const foreign = upload(otherUserId);
    for (const input of [owned, foreign]) {
      await repositories.sessionInputs.prepareUpload(input);
      await repositories.sessionInputs.completeUpload(
        input.id,
        input.ownerUserId,
        {
          arkFileId: `ark-${input.id}`,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
        },
      );
    }
    const intent = session(userId, agentId);

    await expect(
      repositories.sessionLifecycle.prepareCreate(intent, [
        owned.id,
        foreign.id,
      ]),
    ).rejects.toMatchObject({ name: "ResourceNotFoundError" });

    const state = await database.client.query<{
      session_id: string | null;
    }>(`select session_id from session_inputs where id = $1`, [owned.id]);
    expect(state.rows[0]?.session_id).toBeNull();
    await expect(
      repositories.sessionLifecycle.findCreateIntent(userId, intent.id),
    ).resolves.toBeUndefined();
    await database.close();
  });

  it("atomically reserves, lists, and binds Session inputs", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, otherUserId, agentId } = await seed(database.client);
    const input = upload(userId);
    await repositories.sessionInputs.prepareUpload(input);
    await repositories.sessionInputs.completeUpload(input.id, userId, {
      arkFileId: "ark-file-1",
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
    });
    const intent = session(userId, agentId);

    await expect(
      repositories.sessionLifecycle.prepareCreate(intent, [input.id]),
    ).resolves.toEqual([
      expect.objectContaining({
        id: input.id,
        sessionId: intent.id,
        status: "uploaded",
      }),
    ]);
    await expect(
      repositories.sessionLifecycle.listInputs(userId, intent.id),
    ).resolves.toEqual([
      expect.objectContaining({ id: input.id, status: "uploaded" }),
    ]);
    const reuse = session(userId, agentId);
    await expect(
      repositories.sessionLifecycle.prepareCreate(reuse, [input.id]),
    ).rejects.toMatchObject({ name: "ResourceNotFoundError" });
    await expect(
      repositories.sessionLifecycle.findCreateIntent(userId, reuse.id),
    ).resolves.toBeUndefined();

    await repositories.sessionLifecycle.completeCreate(intent.id, userId, {
      arkSessionId: "ark-session-1",
      arkAgentId: "ark-agent-1",
      agentVersion: "1",
      status: "idle",
    });
    await expect(
      repositories.sessionLifecycle.listInputs(userId, intent.id),
    ).resolves.toEqual([
      expect.objectContaining({ id: input.id, status: "bound" }),
    ]);
    await expect(
      repositories.sessionLifecycle.listInputs(otherUserId, intent.id),
    ).resolves.toEqual([]);
    await database.close();
  });

  it("keeps cleanup retryable before marking the final failure", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId } = await seed(database.client);
    const input = upload(userId);
    input.expiresAt = new Date("2026-09-05T00:00:00.000Z");
    await repositories.sessionInputs.prepareUpload(input);
    await repositories.sessionInputs.completeUpload(input.id, userId, {
      arkFileId: "ark-file-1",
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
    });
    await database.client.query(
      `update background_jobs set max_attempts = 2 where id = $1`,
      [input.id],
    );
    const [claimed] = await repositories.jobs.claim({
      workerId: "cleanup-worker",
      limit: 1,
      now,
      types: ["cleanup_upload"],
    });
    expect(claimed).toBeDefined();
    await repositories.sessionInputs.findExpiredUnbound(userId, input.id, now);

    await repositories.jobs.retry(
      input.id,
      "cleanup-worker",
      "Ark unavailable",
      false,
      now,
    );

    await expect(
      repositories.sessionInputs.findOwned(userId, input.id),
    ).resolves.toMatchObject({
      status: "deleting",
      lastErrorCode: "Ark unavailable",
    });
    const pending = await database.client.query<{
      status: string;
      last_error: string | null;
    }>(`select status, last_error from background_jobs where id = $1`, [
      input.id,
    ]);
    expect(pending.rows[0]).toEqual({
      status: "pending",
      last_error: "Ark unavailable",
    });

    const retryAt = new Date(now.getTime() + 60_001);
    const [retried] = await repositories.jobs.claim({
      workerId: "cleanup-worker",
      limit: 1,
      now: retryAt,
      types: ["cleanup_upload"],
    });
    expect(retried?.attempts).toBe(2);
    await repositories.sessionInputs.findExpiredUnbound(
      userId,
      input.id,
      retryAt,
    );
    await repositories.jobs.retry(
      input.id,
      "cleanup-worker",
      "Ark still unavailable",
      true,
      retryAt,
    );

    await expect(
      repositories.sessionInputs.findOwned(userId, input.id),
    ).resolves.toMatchObject({
      status: "failed",
      lastErrorCode: "Ark still unavailable",
    });
    const failed = await database.client.query<{ status: string }>(
      `select status from background_jobs where id = $1`,
      [input.id],
    );
    expect(failed.rows[0]?.status).toBe("failed");
    await database.close();
  });
});

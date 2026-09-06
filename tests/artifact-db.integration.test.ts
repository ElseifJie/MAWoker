import { describe, expect, it } from "vitest";
import { createRepositories } from "../packages/db/src/index.js";
import type { ArtifactRecord } from "../packages/domain/src/index.js";
import { createTestDatabase, id } from "./support/test-database.js";

const now = new Date("2026-09-06T00:00:00.000Z");

async function seed(
  client: Awaited<ReturnType<typeof createTestDatabase>>["client"],
) {
  const userId = id();
  const otherUserId = id();
  const agentId = id();
  const sessionId = id();
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
    `insert into personal_agents
      (id, owner_user_id, ark_agent_id, name, model_id, system_prompt,
       ark_version, status)
     values ($1, $2, 'ark-agent-1', 'Agent', 'model-a', 'Prompt', '1', 'active')`,
    [agentId, userId],
  );
  await client.query(
    `insert into sessions
      (id, owner_user_id, ark_session_id, agent_kind, personal_agent_id,
       ark_agent_id, agent_name, agent_version, environment_id)
     values ($1, $2, 'ark-session-1', 'personal', $3, 'ark-agent-1',
             'Agent', '1', 'environment-1')`,
    [sessionId, userId, agentId],
  );
  return { userId, otherUserId, sessionId };
}

function artifact(
  ownerUserId: string,
  sessionId: string,
  overrides: Partial<ArtifactRecord> = {},
): ArtifactRecord {
  return {
    id: id(),
    ownerUserId,
    sessionId,
    arkFileId: "ark-output-1",
    tosObjectKey: `private/${ownerUserId}/${sessionId}/ark-output-1`,
    name: "report.txt",
    mimeType: "text/plain",
    sizeBytes: 5,
    generatedAt: now,
    deletionState: "none",
    lastErrorCode: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function commitArtifact(
  repository: ReturnType<typeof createRepositories>["artifacts"],
  record: ArtifactRecord,
) {
  const stagingCleanupJobId = id();
  await repository.stageCleanup({
    id: stagingCleanupJobId,
    ownerUserId: record.ownerUserId,
    objectKey: record.tosObjectKey,
    runAfter: new Date("2030-09-06T00:00:00.000Z"),
  });
  return repository.commitCandidate({
    record,
    stagingCleanupJobId,
    replacementCleanupJobId: id(),
  });
}

describe("Artifact database integration", () => {
  it("upserts Session-scoped metadata and lists only owned artifacts", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, otherUserId, sessionId } = await seed(database.client);
    const initial = artifact(userId, sessionId);

    await commitArtifact(repositories.artifacts, initial);
    const refreshedKey = `${initial.tosObjectKey}/refresh`;
    const updated = await commitArtifact(repositories.artifacts, {
      ...initial,
      id: id(),
      tosObjectKey: refreshedKey,
      name: "renamed.md",
      mimeType: "text/markdown",
      sizeBytes: 7,
      generatedAt: new Date("2026-09-06T01:00:00.000Z"),
    });

    expect(updated).toMatchObject({
      activated: true,
      artifact: {
        id: initial.id,
        tosObjectKey: refreshedKey,
        name: "renamed.md",
        mimeType: "text/markdown",
        sizeBytes: 7,
      },
    });
    const oldKeyCleanup = await database.client.query<{
      status: string;
      object_key: string;
    }>(
      `select status::text, payload ->> 'objectKey' as object_key
         from background_jobs
        where type = 'cleanup_artifact_object'
          and status = 'pending'
          and payload ->> 'objectKey' = $1`,
      [initial.tosObjectKey],
    );
    expect(oldKeyCleanup.rows).toEqual([
      { status: "pending", object_key: initial.tosObjectKey },
    ]);
    await expect(
      repositories.artifacts.listOwned(userId),
    ).resolves.toHaveLength(1);
    await expect(
      repositories.artifacts.listOwned(userId, sessionId),
    ).resolves.toHaveLength(1);
    await expect(
      repositories.artifacts.listOwned(userId, id()),
    ).resolves.toEqual([]);
    await expect(
      repositories.artifacts.listOwned(otherUserId),
    ).resolves.toEqual([]);
    await database.close();
  });

  it("queues one deletion job and exposes retry/final-failure state", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, sessionId } = await seed(database.client);
    const record = artifact(userId, sessionId);
    await commitArtifact(repositories.artifacts, record);

    await repositories.artifacts.beginDelete(record.id, userId);
    await repositories.artifacts.beginDelete(record.id, userId);
    const jobs = await database.client.query<{
      count: number;
      status: string;
    }>(
      `select count(*)::integer as count, min(status::text) as status
         from background_jobs where id = $1 group by id`,
      [record.id],
    );
    expect(jobs.rows[0]).toEqual({ count: 1, status: "pending" });

    const [claimed] = await repositories.jobs.claim({
      workerId: "artifact-worker",
      limit: 1,
      now: new Date("2030-09-06T00:00:00.000Z"),
      types: ["delete_artifact"],
    });
    expect(claimed).toBeDefined();
    await repositories.jobs.retry(
      record.id,
      "artifact-worker",
      "provider leaked private/object/key",
      true,
      new Date("2030-09-06T00:00:00.000Z"),
    );

    await expect(
      repositories.artifacts.findOwned(userId, record.id),
    ).resolves.toMatchObject({
      deletionState: "deletion_failed",
      lastErrorCode: "ARTIFACT_DELETE_FAILED",
    });
    const failedJob = await database.client.query<{ last_error: string }>(
      `select last_error from background_jobs where id = $1`,
      [record.id],
    );
    expect(failedJob.rows[0]?.last_error).toBe("ARTIFACT_DELETE_FAILED");
    await database.close();
  });

  it("retains a minimal tombstone that rejects later artifact upserts", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, sessionId } = await seed(database.client);
    const record = artifact(userId, sessionId);
    await commitArtifact(repositories.artifacts, record);
    await repositories.artifacts.beginDelete(record.id, userId);

    await expect(
      repositories.artifacts.markDeleted(record.id, userId),
    ).resolves.toBe(true);
    await database.client.query(
      `update background_jobs
          set status = 'succeeded',
              locked_at = null,
              locked_by = null
        where id = $1`,
      [record.id],
    );
    await expect(
      commitArtifact(repositories.artifacts, {
        ...record,
        id: id(),
        tosObjectKey: `${record.tosObjectKey}/staging`,
        name: "resurrected.txt",
        updatedAt: new Date("2030-09-06T00:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      activated: false,
      artifact: {
        id: record.id,
        deletionState: "deleted",
        name: "",
        sizeBytes: 0,
      },
    });
    await expect(
      repositories.artifacts.findDeleting(userId, record.id),
    ).resolves.toMatchObject({ deletionState: "deleted" });
    await expect(repositories.artifacts.listOwned(userId)).resolves.toEqual([]);

    const retained = await database.client.query<{
      owner_user_id: string;
      session_id: string;
      ark_file_id: string;
      deletion_state: string;
      job_status: string;
    }>(
      `select artifact.owner_user_id, artifact.session_id,
              artifact.ark_file_id, artifact.deletion_state,
              job.status as job_status
         from artifacts artifact
         join background_jobs job on job.id = artifact.id
        where artifact.id = $1`,
      [record.id],
    );
    expect(retained.rows[0]).toEqual({
      owner_user_id: userId,
      session_id: sessionId,
      ark_file_id: record.arkFileId,
      deletion_state: "deleted",
      job_status: "succeeded",
    });
    await database.close();
  });

  it("rearms only failed repeated deletion requests", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, sessionId } = await seed(database.client);
    const record = artifact(userId, sessionId);
    await commitArtifact(repositories.artifacts, record);
    await repositories.artifacts.beginDelete(record.id, userId);
    await database.client.query(
      `update background_jobs
          set attempts = 3,
              run_after = '2040-09-06T00:00:00.000Z',
              last_error = 'retry failure'
        where id = $1`,
      [record.id],
    );
    const pending = await database.client.query<{
      status: string;
      attempts: number;
      run_after: Date;
      locked_at: Date | null;
      locked_by: string | null;
      last_error: string | null;
    }>(
      `select status::text, attempts, run_after, locked_at, locked_by,
              last_error
         from background_jobs
        where id = $1`,
      [record.id],
    );

    await repositories.artifacts.beginDelete(record.id, userId);
    const unchanged = await database.client.query<{
      status: string;
      attempts: number;
      run_after: Date;
      locked_at: Date | null;
      locked_by: string | null;
      last_error: string | null;
    }>(
      `select status::text, attempts, run_after, locked_at, locked_by,
              last_error
         from background_jobs
        where id = $1`,
      [record.id],
    );
    expect(unchanged.rows).toEqual(pending.rows);

    await database.client.query(
      `update background_jobs
          set status = 'failed',
              attempts = max_attempts,
              locked_at = '2030-09-06T00:00:00.000Z',
              locked_by = 'terminal-worker',
              last_error = 'terminal failure'
        where id = $1`,
      [record.id],
    );
    await repositories.artifacts.beginDelete(record.id, userId);
    const rearmed = await database.client.query<{
      status: string;
      attempts: number;
      locked_at: Date | null;
      locked_by: string | null;
      last_error: string | null;
    }>(
      `select status::text, attempts, locked_at, locked_by, last_error
         from background_jobs
        where id = $1`,
      [record.id],
    );
    expect(rearmed.rows[0]).toEqual({
      status: "pending",
      attempts: 0,
      locked_at: null,
      locked_by: null,
      last_error: null,
    });
    await database.close();
  });

  it("rearms exhausted tombstone cleanup and deletion jobs from attempt zero", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, sessionId } = await seed(database.client);
    const record = artifact(userId, sessionId);
    await commitArtifact(repositories.artifacts, record);
    await repositories.artifacts.beginDelete(record.id, userId);

    const stagingCleanupJobId = id();
    const stagedObjectKey = `${record.tosObjectKey}/tombstone-race`;
    await repositories.artifacts.stageCleanup({
      id: stagingCleanupJobId,
      ownerUserId: userId,
      objectKey: stagedObjectKey,
      runAfter: new Date("2040-09-06T00:00:00.000Z"),
    });
    await database.client.query(
      `update background_jobs
          set status = 'failed',
              attempts = max_attempts,
              locked_at = '2030-09-06T00:00:00.000Z',
              locked_by = 'terminal-worker',
              last_error = 'terminal failure'
        where id in ($1, $2)`,
      [record.id, stagingCleanupJobId],
    );

    await expect(
      repositories.artifacts.commitCandidate({
        record: {
          ...record,
          id: id(),
          tosObjectKey: stagedObjectKey,
        },
        stagingCleanupJobId,
        replacementCleanupJobId: id(),
      }),
    ).resolves.toMatchObject({ activated: false });

    const rearmed = await database.client.query<{
      id: string;
      status: string;
      attempts: number;
      locked_at: Date | null;
      locked_by: string | null;
      last_error: string | null;
    }>(
      `select id, status::text, attempts, locked_at, locked_by, last_error
         from background_jobs
        where id in ($1, $2)
        order by id`,
      [record.id, stagingCleanupJobId],
    );
    expect(rearmed.rows).toEqual(
      [record.id, stagingCleanupJobId].sort().map((jobId) => ({
        id: jobId,
        status: "pending",
        attempts: 0,
        locked_at: null,
        locked_by: null,
        last_error: null,
      })),
    );

    const claimed = await repositories.jobs.claim({
      workerId: "rearmed-worker",
      limit: 2,
      now: new Date("2035-09-06T00:00:00.000Z"),
      types: ["delete_artifact", "cleanup_artifact_object"],
    });
    expect(claimed).toEqual([
      expect.objectContaining({ id: stagingCleanupJobId, attempts: 1 }),
      expect.objectContaining({ id: record.id, attempts: 1 }),
    ]);
    await database.close();
  });

  it("does not alter pending cleanup or actively leased deletion jobs", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, sessionId } = await seed(database.client);
    const record = artifact(userId, sessionId);
    await commitArtifact(repositories.artifacts, record);
    await repositories.artifacts.beginDelete(record.id, userId);
    await repositories.jobs.claim({
      workerId: "active-deletion-worker",
      limit: 1,
      now: new Date("2030-09-06T00:00:00.000Z"),
      types: ["delete_artifact"],
    });

    const stagingCleanupJobId = id();
    const stagedObjectKey = `${record.tosObjectKey}/pending-cleanup`;
    await repositories.artifacts.stageCleanup({
      id: stagingCleanupJobId,
      ownerUserId: userId,
      objectKey: stagedObjectKey,
      runAfter: new Date("2040-09-06T00:00:00.000Z"),
    });
    const before = await database.client.query<{
      id: string;
      status: string;
      attempts: number;
      run_after: Date;
      locked_at: Date | null;
      locked_by: string | null;
      last_error: string | null;
    }>(
      `select id, status::text, attempts, run_after, locked_at, locked_by,
              last_error
         from background_jobs
        where id in ($1, $2)
        order by id`,
      [record.id, stagingCleanupJobId],
    );

    await repositories.artifacts.commitCandidate({
      record: {
        ...record,
        id: id(),
        tosObjectKey: stagedObjectKey,
      },
      stagingCleanupJobId,
      replacementCleanupJobId: id(),
    });

    const after = await database.client.query<{
      id: string;
      status: string;
      attempts: number;
      run_after: Date;
      locked_at: Date | null;
      locked_by: string | null;
      last_error: string | null;
    }>(
      `select id, status::text, attempts, run_after, locked_at, locked_by,
              last_error
         from background_jobs
        where id in ($1, $2)
        order by id`,
      [record.id, stagingCleanupJobId],
    );
    expect(after.rows).toEqual(before.rows);
    await database.close();
  });

  it("converges when tombstone rearm races a deletion claim", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, sessionId } = await seed(database.client);
    const record = artifact(userId, sessionId);
    await commitArtifact(repositories.artifacts, record);
    await repositories.artifacts.beginDelete(record.id, userId);

    const stagingCleanupJobId = id();
    const stagedObjectKey = `${record.tosObjectKey}/concurrent-rearm`;
    await repositories.artifacts.stageCleanup({
      id: stagingCleanupJobId,
      ownerUserId: userId,
      objectKey: stagedObjectKey,
      runAfter: new Date("2040-09-06T00:00:00.000Z"),
    });
    await database.client.query(
      `update background_jobs
          set status = 'failed',
              attempts = max_attempts,
              last_error = 'terminal failure'
        where id in ($1, $2)`,
      [record.id, stagingCleanupJobId],
    );
    const candidate = {
      record: {
        ...record,
        id: id(),
        tosObjectKey: stagedObjectKey,
      },
      stagingCleanupJobId,
      replacementCleanupJobId: id(),
    };
    const claimAt = new Date("2035-09-06T00:00:00.000Z");

    const [, racedClaims] = await Promise.all([
      repositories.artifacts.commitCandidate(candidate),
      repositories.jobs.claim({
        workerId: "claim-worker",
        limit: 1,
        now: claimAt,
        types: ["delete_artifact"],
      }),
    ]);
    const claims =
      racedClaims.length > 0
        ? racedClaims
        : await repositories.jobs.claim({
            workerId: "claim-worker",
            limit: 1,
            now: claimAt,
            types: ["delete_artifact"],
          });
    expect(claims).toEqual([
      expect.objectContaining({
        id: record.id,
        attempts: 1,
        lockedBy: "claim-worker",
      }),
    ]);

    const [, rivalClaims] = await Promise.all([
      repositories.artifacts.commitCandidate(candidate),
      repositories.jobs.claim({
        workerId: "rival-worker",
        limit: 1,
        now: new Date("2035-09-06T00:01:00.000Z"),
        types: ["delete_artifact"],
      }),
    ]);
    expect(rivalClaims).toEqual([]);
    const leased = await database.client.query<{
      status: string;
      attempts: number;
      locked_by: string | null;
    }>(
      `select status::text, attempts, locked_by
         from background_jobs
        where id = $1`,
      [record.id],
    );
    expect(leased.rows[0]).toEqual({
      status: "running",
      attempts: 1,
      locked_by: "claim-worker",
    });
    await database.close();
  });

  it("replaces leaked errors when an artifact deletion lease expires", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, sessionId } = await seed(database.client);
    const record = artifact(userId, sessionId);
    await commitArtifact(repositories.artifacts, record);
    await repositories.artifacts.beginDelete(record.id, userId);
    await repositories.jobs.claim({
      workerId: "crashed-worker",
      limit: 1,
      now: new Date("2030-09-06T00:00:00.000Z"),
      types: ["delete_artifact"],
    });
    await database.client.query(
      `update background_jobs
          set attempts = max_attempts,
              locked_at = $2,
              last_error = 'provider leaked a secret'
        where id = $1`,
      [record.id, new Date("2020-09-06T00:00:00.000Z")],
    );

    await repositories.jobs.claim({
      workerId: "recovery-worker",
      limit: 1,
      now: new Date("2031-09-06T00:00:00.000Z"),
      types: ["delete_artifact"],
    });

    const failed = await database.client.query<{
      last_error: string;
    }>(`select last_error from background_jobs where id = $1`, [record.id]);
    expect(failed.rows[0]?.last_error).toBe("ARTIFACT_DELETE_LEASE_EXPIRED");
    await expect(
      repositories.artifacts.findOwned(userId, record.id),
    ).resolves.toMatchObject({
      deletionState: "deletion_failed",
      lastErrorCode: "ARTIFACT_DELETE_LEASE_EXPIRED",
    });
    await database.close();
  });

  it("leases, retries, and reclaims durable artifact object cleanup", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId } = await seed(database.client);
    const cleanupId = id();
    const firstClaimAt = new Date("2030-09-06T00:00:00.000Z");
    await repositories.artifacts.stageCleanup({
      id: cleanupId,
      ownerUserId: userId,
      objectKey: `tenants/${userId}/sessions/session/artifacts/file/version`,
      runAfter: firstClaimAt,
    });

    await expect(
      repositories.jobs.claim({
        workerId: "cleanup-worker-1",
        limit: 1,
        now: firstClaimAt,
        types: ["cleanup_artifact_object"],
      }),
    ).resolves.toEqual([
      expect.objectContaining({ id: cleanupId, attempts: 1 }),
    ]);
    await expect(
      repositories.jobs.claim({
        workerId: "cleanup-worker-2",
        limit: 1,
        now: new Date("2030-09-06T00:04:59.000Z"),
        types: ["cleanup_artifact_object"],
      }),
    ).resolves.toEqual([]);

    const [reclaimed] = await repositories.jobs.claim({
      workerId: "cleanup-worker-2",
      limit: 1,
      now: new Date("2030-09-06T00:05:01.000Z"),
      types: ["cleanup_artifact_object"],
    });
    expect(reclaimed).toMatchObject({ id: cleanupId, attempts: 2 });
    await repositories.jobs.retry(
      cleanupId,
      "cleanup-worker-2",
      "provider leaked a private object key",
      false,
      new Date("2030-09-06T00:05:01.000Z"),
    );

    const retry = await database.client.query<{
      status: string;
      last_error: string;
    }>(
      `select status::text, last_error
         from background_jobs
        where id = $1`,
      [cleanupId],
    );
    expect(retry.rows[0]).toEqual({
      status: "pending",
      last_error: "ARTIFACT_CLEANUP_FAILED",
    });
    await expect(
      repositories.jobs.claim({
        workerId: "cleanup-worker-3",
        limit: 1,
        now: new Date("2030-09-06T00:06:02.000Z"),
        types: ["cleanup_artifact_object"],
      }),
    ).resolves.toEqual([
      expect.objectContaining({ id: cleanupId, attempts: 3 }),
    ]);
    await database.close();
  });

  it("does not mutate another tenant's artifact", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, otherUserId, sessionId } = await seed(database.client);
    const record = artifact(userId, sessionId);
    await commitArtifact(repositories.artifacts, record);

    await expect(
      repositories.artifacts.beginDelete(record.id, otherUserId),
    ).resolves.toBeUndefined();
    await expect(
      repositories.artifacts.findOwned(userId, record.id),
    ).resolves.toMatchObject({ deletionState: "none" });
    await database.close();
  });
});

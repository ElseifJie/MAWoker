import { describe, expect, it } from "vitest";
import { createRepositories } from "../packages/db/src/index.js";
import type { ArtifactRecord } from "../packages/domain/src/index.js";
import { createTestDatabase, id } from "./support/test-database.js";

const now = new Date("2026-09-06T00:00:00.000Z");
const later = new Date("2030-09-06T00:00:00.000Z");

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

function driveFile(
  ownerUserId: string,
  overrides: Record<string, unknown> = {},
) {
  const driveFileId = id();
  return {
    id: driveFileId,
    ownerUserId,
    origin: "artifact" as const,
    objectKey: `tenants/${ownerUserId}/drive/artifact/${driveFileId}/report.txt`,
    name: "report.txt",
    mimeType: "text/plain",
    sizeBytes: 5,
    runAfter: later,
    writeLeaseUntil: later,
    ...overrides,
  };
}

function artifact(
  ownerUserId: string,
  sessionId: string,
  driveFileId: string,
  overrides: Partial<ArtifactRecord> = {},
): ArtifactRecord {
  return {
    id: id(),
    ownerUserId,
    sessionId,
    arkFileId: `ark-output-${id()}`,
    driveFileId,
    tosObjectKey: `tenants/${ownerUserId}/drive/artifact/${driveFileId}/report.txt`,
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

/** Stages and commits a drive object, returning the committed association. */
async function commit(
  repositories: ReturnType<typeof createRepositories>,
  userId: string,
  sessionId: string,
) {
  const staged = driveFile(userId);
  await repositories.driveFiles.stage({
    id: staged.id,
    ownerUserId: staged.ownerUserId,
    origin: staged.origin,
    objectKey: staged.objectKey,
    name: staged.name,
    mimeType: staged.mimeType,
    sizeBytes: staged.sizeBytes,
    sourceSessionId: sessionId,
    runAfter: staged.runAfter,
    writeLeaseUntil: staged.writeLeaseUntil,
  });
  await repositories.driveFiles.commit({
    id: staged.id,
    ownerUserId: staged.ownerUserId,
  });
  const association = artifact(userId, sessionId, staged.id, {
    tosObjectKey: staged.objectKey,
  });
  await repositories.artifacts.upsertAssociation(association);
  return association;
}

describe("Drive and artifact database integration", () => {
  it("commits a staged drive object and retires its cleanup intent", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, sessionId } = await seed(database.client);

    const association = await commit(repositories, userId, sessionId);
    await expect(
      repositories.driveFiles.findOwned(userId, association.driveFileId),
    ).resolves.toMatchObject({ deletionState: "none", writeLeaseUntil: null });
    await expect(
      repositories.artifacts.listOwned(userId),
    ).resolves.toHaveLength(1);
    await expect(
      repositories.artifacts.listOwned(userId, sessionId),
    ).resolves.toHaveLength(1);
    await expect(
      repositories.artifacts.listOwned(userId, id()),
    ).resolves.toEqual([]);

    const jobs = await database.client.query<{ status: string }>(
      `select status::text from background_jobs
        where id = $1 and type = 'cleanup_drive_object'`,
      [association.driveFileId],
    );
    expect(jobs.rows).toEqual([{ status: "succeeded" }]);
    await database.close();
  });

  it("keeps a staged row and its cleanup intent when the write never commits", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, sessionId } = await seed(database.client);
    const staged = driveFile(userId);

    await repositories.driveFiles.stage({
      id: staged.id,
      ownerUserId: userId,
      origin: "artifact",
      objectKey: staged.objectKey,
      name: staged.name,
      mimeType: staged.mimeType,
      sizeBytes: staged.sizeBytes,
      sourceSessionId: sessionId,
      runAfter: later,
      writeLeaseUntil: later,
    });
    // A crash here leaves the row pending, never visible as a live object.
    await expect(repositories.artifacts.listOwned(userId)).resolves.toEqual([]);
    const rows = await database.client.query<{ deletion_state: string }>(
      `select deletion_state::text from drive_files where id = $1`,
      [staged.id],
    );
    expect(rows.rows).toEqual([{ deletion_state: "pending" }]);
    await database.close();
  });

  it("clears the write lease when a failed write releases its claim", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, sessionId } = await seed(database.client);
    const staged = driveFile(userId);
    await repositories.driveFiles.stage({
      id: staged.id,
      ownerUserId: userId,
      origin: "artifact",
      objectKey: staged.objectKey,
      name: staged.name,
      mimeType: staged.mimeType,
      sizeBytes: staged.sizeBytes,
      sourceSessionId: sessionId,
      runAfter: later,
      writeLeaseUntil: later,
    });
    await repositories.driveFiles.release(staged.id, userId);

    const job = await database.client.query<{
      generation: number;
      lease: string | null;
      status: string;
    }>(
      `select (payload ->> 'cleanupGeneration')::integer as generation,
              payload ->> 'uploadInProgressUntil' as lease,
              status::text as status
         from background_jobs where id = $1`,
      [staged.id],
    );
    expect(job.rows[0]).toEqual({
      generation: 1,
      lease: null,
      status: "pending",
    });
    await database.close();
  });

  it("tombstones an artifact and refuses to resurrect it while hidden", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, sessionId } = await seed(database.client);
    const association = await commit(repositories, userId, sessionId);

    await repositories.artifacts.requestDelete(association.id, userId, now);
    await expect(
      repositories.artifacts.markDeleted(association.id, userId),
    ).resolves.toBe(true);
    await expect(
      repositories.artifacts.findDeleting(userId, association.id),
    ).resolves.toMatchObject({ deletionState: "deleted" });
    await expect(repositories.artifacts.listOwned(userId)).resolves.toEqual([]);

    // Re-syncing the same Ark file must not bring the tombstone back to life.
    await repositories.artifacts.upsertAssociation({
      ...association,
      deletionState: "deleted",
      name: "",
    });
    const retained = await database.client.query<{ deletion_state: string }>(
      `select deletion_state::text from artifacts where id = $1`,
      [association.id],
    );
    expect(retained.rows[0]!.deletion_state).toBe("none");
    await database.close();
  });

  it("orphans a drive object on requestDelete and leaves its bytes addressable", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, sessionId } = await seed(database.client);
    const association = await commit(repositories, userId, sessionId);

    await repositories.artifacts.requestDelete(association.id, userId, now);
    const drive = await repositories.driveFiles.findOwned(
      userId,
      association.driveFileId,
    );
    expect(drive).toMatchObject({ deletionState: "none" });
    expect(drive!.orphanedAt).not.toBeNull();
    await database.close();
  });

  it("reaps an explicitly deleted artifact and tombstones both rows", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, sessionId } = await seed(database.client);
    const association = await commit(repositories, userId, sessionId);
    await repositories.artifacts.requestDelete(association.id, userId, now);

    // The GC enqueues the cleanup, which deletes the bytes and tombstones the
    // drive row plus every association that pointed at it.
    await repositories.driveFiles.claimOrphans({
      limit: 10,
      retentionMs: 0,
      now,
    });
    const [claimed] = await repositories.jobs.claim({
      workerId: "drive-worker",
      limit: 1,
      now,
      types: ["cleanup_drive_object"],
    });
    expect(claimed).toBeDefined();
    await expect(
      repositories.driveFiles.markDeleted(association.driveFileId, userId),
    ).resolves.toBe(true);

    await expect(
      repositories.driveFiles.findOwned(userId, association.driveFileId),
    ).resolves.toMatchObject({ deletionState: "deleted" });
    const associations = await database.client.query<{
      deletion_state: string;
    }>(`select deletion_state::text from artifacts where id = $1`, [
      association.id,
    ]);
    expect(associations.rows[0]!.deletion_state).toBe("deleted");
    await expect(repositories.artifacts.listOwned(userId)).resolves.toEqual([]);
    await database.close();
  });

  it("enqueues each orphan exactly once and skips a live cleanup job", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, sessionId } = await seed(database.client);
    const association = await commit(repositories, userId, sessionId);
    await repositories.artifacts.requestDelete(association.id, userId, now);

    await expect(
      repositories.driveFiles.claimOrphans({
        limit: 10,
        retentionMs: 60_000,
        now,
      }),
    ).resolves.toBe(0);
    await expect(
      repositories.driveFiles.claimOrphans({ limit: 10, retentionMs: 0, now }),
    ).resolves.toBe(1);
    // The re-armed job now counts as live, so a second scan is a no-op.
    await expect(
      repositories.driveFiles.claimOrphans({ limit: 10, retentionMs: 0, now }),
    ).resolves.toBe(0);

    const jobs = await database.client.query<{
      count: number;
      status: string;
    }>(
      `select count(*)::integer as count, min(status::text) as status
         from background_jobs where id = $1`,
      [association.driveFileId],
    );
    expect(jobs.rows[0]).toEqual({ count: 1, status: "pending" });
    await database.close();
  });

  it("does not reap an object that is still referenced by another Session", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, sessionId } = await seed(database.client);
    const secondSessionId = id();
    const agentId = id();
    await database.client.query(
      `insert into personal_agents
        (id, owner_user_id, ark_agent_id, name, model_id, system_prompt,
         ark_version, status)
       values ($1, $2, 'ark-agent-2', 'Agent 2', 'model-a', 'Prompt', '1',
               'active')`,
      [agentId, userId],
    );
    await database.client.query(
      `insert into sessions
        (id, owner_user_id, ark_session_id, agent_kind, personal_agent_id,
         ark_agent_id, agent_name, agent_version, environment_id)
       values ($1, $2, 'ark-session-2', 'personal', $3, 'ark-agent-2',
               'Agent 2', '1', 'environment-1')`,
      [secondSessionId, userId, agentId],
    );
    const association = await commit(repositories, userId, sessionId);
    // A second Session associates with the same drive object.
    await repositories.artifacts.upsertAssociation({
      ...association,
      id: id(),
      sessionId: secondSessionId,
      arkFileId: "ark-output-second",
    });

    await repositories.sessionDeletion.orphanDriveFiles(userId, sessionId, now);
    const drive = await repositories.driveFiles.findOwned(
      userId,
      association.driveFileId,
    );
    // Another Session still references it, so it must not be orphaned.
    expect(drive!.orphanedAt).toBeNull();
    await database.close();
  });

  it("orphans every drive object once its only Session is removed", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, sessionId } = await seed(database.client);
    const association = await commit(repositories, userId, sessionId);

    const orphaned = await repositories.sessionDeletion.orphanDriveFiles(
      userId,
      sessionId,
      now,
    );
    expect(orphaned).toBe(1);
    // The saga only marks local removal once the Session is mid-deletion.
    await database.client.query(
      `update sessions set deletion_state = 'pending' where id = $1`,
      [sessionId],
    );
    await expect(
      repositories.sessionDeletion.removeLocal(userId, sessionId),
    ).resolves.toBe("removed");

    // The association cascaded away but the drive row survives for the GC.
    await expect(
      repositories.driveFiles.findOwned(userId, association.driveFileId),
    ).resolves.toMatchObject({ deletionState: "none" });
    const drive = await repositories.driveFiles.findOwned(
      userId,
      association.driveFileId,
    );
    expect(drive!.orphanedAt).not.toBeNull();
    await expect(
      repositories.driveFiles.claimOrphans({ limit: 10, retentionMs: 0, now }),
    ).resolves.toBe(1);
    await database.close();
  });

  it("fails a drive cleanup after its lease expires on the final attempt", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, sessionId } = await seed(database.client);
    const association = await commit(repositories, userId, sessionId);
    await repositories.artifacts.requestDelete(association.id, userId, now);
    await repositories.driveFiles.claimOrphans({
      limit: 10,
      retentionMs: 0,
      now,
    });

    const [claimed] = await repositories.jobs.claim({
      workerId: "drive-worker",
      limit: 1,
      now,
      types: ["cleanup_drive_object"],
    });
    expect(claimed).toBeDefined();
    await repositories.jobs.retry(
      claimed!.id,
      "drive-worker",
      "provider leaked a secret",
      true,
      now,
    );
    const drive = await repositories.driveFiles.findOwned(
      userId,
      association.driveFileId,
    );
    expect(drive).toMatchObject({
      deletionState: "deletion_failed",
      lastErrorCode: "DRIVE_CLEANUP_FAILED",
    });
    await database.close();
  });

  it("does not mutate another tenant's drive file", async () => {
    const database = await createTestDatabase();
    const repositories = createRepositories(database.db);
    const { userId, otherUserId, sessionId } = await seed(database.client);
    const association = await commit(repositories, userId, sessionId);

    await expect(
      repositories.driveFiles.findOwned(otherUserId, association.driveFileId),
    ).resolves.toBeUndefined();
    await expect(
      repositories.driveFiles.orphan(association.driveFileId, otherUserId, now),
    ).resolves.toBe(false);
    await expect(
      repositories.driveFiles.markDeleted(association.driveFileId, otherUserId),
    ).resolves.toBe(false);
    await expect(
      repositories.artifacts.findOwned(otherUserId, association.id),
    ).resolves.toBeUndefined();
    await database.close();
  });
});

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createRepositories } from "../packages/db/src/index.js";
import {
  ArtifactService,
  DriveFileService,
  ResourceNotFoundError,
} from "../packages/domain/src/index.js";
import { InMemoryArtifactStorage } from "../packages/storage/src/index.js";
import { createTestDatabase } from "./support/test-database.js";

const exportBucket = "ark-exports";
const arkSessionId = "ark-session-1";
const now = new Date("2026-09-06T00:00:00.000Z");

async function collect(stream: NodeJS.ReadableStream): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return new Uint8Array(Buffer.concat(chunks));
}

function exportLocation(arkFileId: string): {
  bucket: string;
  objectKey: string;
} {
  return { bucket: exportBucket, objectKey: `ark/outputs/env-1/${arkFileId}` };
}

function exportEntry(
  arkFileId: string,
  name: string,
  size: number,
  overrides: { sessionId?: string; contentType?: string } = {},
) {
  return {
    id: arkFileId,
    sessionId: overrides.sessionId ?? arkSessionId,
    name,
    contentType: overrides.contentType ?? "text/plain",
    size,
    createdAt: now.toISOString(),
    tos: exportLocation(arkFileId),
  };
}

/**
 * Seeds one tenant (user + personal agent + Session) so ArtifactService can run
 * against the real repositories. Only the columns the flows actually touch are
 * populated; everything else takes its default.
 */
async function seedTenant(
  database: Awaited<ReturnType<typeof createTestDatabase>>,
  index: string,
) {
  const userId = randomUUID();
  const personalAgentId = randomUUID();
  const sessionId = randomUUID();
  await database.client.query(
    `insert into users (id, auth_subject, email) values ($1, $2, $3)`,
    [userId, `managed:${userId}`, `${index}@example.com`],
  );
  await database.client.query(
    `insert into personal_agents
       (id, owner_user_id, ark_agent_id, name, description, model_id,
        system_prompt, ark_version, status)
     values ($1, $2, $3, $4, '', 'model-a', 'Prompt', '1', 'active')`,
    [personalAgentId, userId, `ark-agent-${index}`, `${index} Agent`],
  );
  await database.client.query(
    `insert into sessions
       (id, owner_user_id, ark_session_id, agent_kind, personal_agent_id,
        ark_agent_id, agent_name, agent_version, environment_id, title, status)
     values ($1, $2, $3, 'personal', $4, $5, $6, '1', 'environment-1',
             $7, 'idle')`,
    [
      sessionId,
      userId,
      `${arkSessionId}-${index}`,
      personalAgentId,
      `ark-agent-${index}`,
      `${index} Agent`,
      `${index} Session`,
    ],
  );
  return { userId, sessionId, arkSessionId: `${arkSessionId}-${index}` };
}

async function setup() {
  const database = await createTestDatabase();
  const repositories = createRepositories(database.db);
  const storage = new InMemoryArtifactStorage();
  let nextId = 0;
  const createId = () => {
    nextId += 1;
    return `00000000-0000-4000-8000-${String(nextId).padStart(12, "0")}`;
  };
  const drive = new DriveFileService({
    repository: repositories.driveFiles,
    storage,
    createId,
    now: () => now,
  });
  let artifacts: ReturnType<typeof exportEntry>[] = [];
  const artifactService = new ArtifactService({
    repository: repositories.artifacts,
    drive,
    ark: {
      async listArtifacts(session) {
        // Ark scopes exports to the Session, so the reported sessionId is the
        // Ark session id the service asked about.
        return artifacts.map((entry) => ({ ...entry, sessionId: session }));
      },
    },
    storage,
    createId,
    now: () => now,
  });
  return {
    database,
    repositories,
    storage,
    drive,
    artifacts: artifactService,
    setArtifacts(entries: ReturnType<typeof exportEntry>[]) {
      artifacts = entries;
    },
    close: () => database.close(),
  };
}

describe("ArtifactService", () => {
  it("syncs Session outputs into a drive-sized object and refreshes idempotently", async () => {
    const state = await setup();
    const tenant = await seedTenant(state.database, "a");
    const bytes = new TextEncoder().encode("report body");
    state.setArtifacts([exportEntry("ark-file-1", "report.txt", bytes.length)]);
    state.storage.putExternal(
      exportLocation("ark-file-1"),
      bytes,
      "text/plain",
    );

    const first = await state.artifacts.syncSession(tenant.sessionId, {
      userId: tenant.userId,
      requestId: "req-1",
    });
    expect(first).toHaveLength(1);
    expect(first[0]!.name).toBe("report.txt");
    expect(first[0]!.tosObjectKey).toContain(
      `tenants/${tenant.userId}/drive/artifact/`,
    );
    // The key must not leak the Session: bytes have to outlive it.
    expect(first[0]!.tosObjectKey).not.toContain(tenant.sessionId);
    expect(
      await collect(await state.storage.openRead(first[0]!.tosObjectKey)),
    ).toEqual(bytes);

    const second = await state.artifacts.syncSession(tenant.sessionId, {
      userId: tenant.userId,
      requestId: "req-2",
    });
    expect(second).toHaveLength(1);
    expect(second[0]!.id).toBe(first[0]!.id);
    expect(second[0]!.driveFileId).toBe(first[0]!.driveFileId);

    const driveRows = await state.database.client.query<{ count: string }>(
      `select count(*)::text as count from drive_files`,
    );
    expect(driveRows.rows[0]!.count).toBe("1");
    await state.close();
  });

  it("rejects a cross-tenant Session sync before touching Ark or storage", async () => {
    const state = await setup();
    const tenant = await seedTenant(state.database, "a");
    const other = await seedTenant(state.database, "b");
    state.setArtifacts([exportEntry("ark-file-1", "report.txt", 3)]);
    state.storage.putExternal(
      exportLocation("ark-file-1"),
      new Uint8Array([1, 2, 3]),
      "text/plain",
    );

    await expect(
      state.artifacts.syncSession(tenant.sessionId, {
        userId: other.userId,
        requestId: "req-1",
      }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
    expect(state.storage.keys()).toEqual([]);
    await state.close();
  });

  it("ignores exports with no reachable TOS location", async () => {
    const state = await setup();
    const tenant = await seedTenant(state.database, "a");
    state.setArtifacts([
      { ...exportEntry("ark-file-1", "unreachable.txt", 3), tos: null },
    ]);
    const synced = await state.artifacts.syncSession(tenant.sessionId, {
      userId: tenant.userId,
      requestId: "req-1",
    });
    expect(synced).toEqual([]);
    await state.close();
  });

  it("lists owned artifacts by Session and downloads their private bytes", async () => {
    const state = await setup();
    const tenant = await seedTenant(state.database, "a");
    const other = await seedTenant(state.database, "b");
    const bytes = new TextEncoder().encode("private body");
    state.setArtifacts([exportEntry("ark-file-1", "secret.txt", bytes.length)]);
    state.storage.putExternal(
      exportLocation("ark-file-1"),
      bytes,
      "text/plain",
    );
    const [artifact] = await state.artifacts.syncSession(tenant.sessionId, {
      userId: tenant.userId,
      requestId: "req-1",
    });

    expect(
      await state.artifacts.list(tenant.userId, tenant.sessionId),
    ).toHaveLength(1);
    expect(await state.artifacts.list(other.userId)).toEqual([]);

    const download = await state.artifacts.download(
      artifact!.id,
      tenant.userId,
    );
    expect(await collect(download.stream)).toEqual(bytes);
    await expect(
      state.artifacts.download(artifact!.id, other.userId),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
    await state.close();
  });

  it("orphans the drive object on requestDelete instead of deleting bytes", async () => {
    const state = await setup();
    const tenant = await seedTenant(state.database, "a");
    const bytes = new TextEncoder().encode("keep me");
    state.setArtifacts([exportEntry("ark-file-1", "keep.txt", bytes.length)]);
    state.storage.putExternal(
      exportLocation("ark-file-1"),
      bytes,
      "text/plain",
    );
    const [artifact] = await state.artifacts.syncSession(tenant.sessionId, {
      userId: tenant.userId,
      requestId: "req-1",
    });

    const deleting = await state.artifacts.requestDelete(
      artifact!.id,
      tenant.userId,
    );
    expect(deleting.deletionState).toBe("pending");

    // Bytes survive the association delete: a drive mode must be able to keep
    // Agent output after the user removes it from a Session's list.
    expect(state.storage.keys()).toHaveLength(1);
    const driveRow = await state.database.client.query<{
      orphaned_at: string | null;
      deletion_state: string;
    }>(`select orphaned_at, deletion_state from drive_files where id = $1`, [
      artifact!.driveFileId,
    ]);
    expect(driveRow.rows[0]!.orphaned_at).not.toBeNull();
    expect(driveRow.rows[0]!.deletion_state).toBe("none");
    await state.close();
  });

  it("enqueues GC immediately at zero retention and defers it above zero", async () => {
    const state = await setup();
    const tenant = await seedTenant(state.database, "a");
    const bytes = new TextEncoder().encode("gc me");
    state.setArtifacts([exportEntry("ark-file-1", "gc.txt", bytes.length)]);
    state.storage.putExternal(
      exportLocation("ark-file-1"),
      bytes,
      "text/plain",
    );
    const [artifact] = await state.artifacts.syncSession(tenant.sessionId, {
      userId: tenant.userId,
      requestId: "req-1",
    });
    await state.artifacts.requestDelete(artifact!.id, tenant.userId);

    expect(
      await state.drive.reapOrphans({ limit: 10, retentionMs: 60_000 }),
    ).toBe(0);

    expect(await state.drive.reapOrphans({ limit: 10, retentionMs: 0 })).toBe(
      1,
    );
    // A second scan must not double-enqueue the same object.
    expect(await state.drive.reapOrphans({ limit: 10, retentionMs: 0 })).toBe(
      0,
    );

    await state.drive.deleteStored(artifact!.driveFileId, tenant.userId);
    expect(state.storage.keys()).toEqual([]);
    await state.close();
  });

  it("reclaims a half-written object when the transfer fails mid-flight", async () => {
    const state = await setup();
    const tenant = await seedTenant(state.database, "a");
    const bytes = new TextEncoder().encode("broken");
    state.setArtifacts([exportEntry("ark-file-1", "broken.txt", bytes.length)]);
    state.storage.putExternal(
      exportLocation("ark-file-1"),
      bytes,
      "text/plain",
    );
    const failing = new (class extends InMemoryArtifactStorage {
      override async write(): Promise<void> {
        throw new Error("provider failed mid-write");
      }
    })();
    failing.putExternal(exportLocation("ark-file-1"), bytes, "text/plain");
    const drive = new DriveFileService({
      repository: state.repositories.driveFiles,
      storage: failing,
      createId: () => "00000000-0000-4000-8000-999999999999",
      now: () => now,
    });
    const service = new ArtifactService({
      repository: state.repositories.artifacts,
      drive,
      ark: {
        async listArtifacts(session) {
          return [
            {
              ...exportEntry("ark-file-1", "broken.txt", bytes.length),
              sessionId: session,
            },
          ];
        },
      },
      storage: failing,
      createId: () => "00000000-0000-4000-8000-888888888888",
      now: () => now,
    });

    await expect(
      service.syncSession(tenant.sessionId, {
        userId: tenant.userId,
        requestId: "req-1",
      }),
    ).rejects.toThrow("provider failed mid-write");

    // The staging row and its cleanup intent survive the crash, so a later
    // cleanup pass can reclaim the partial object.
    const rows = await state.database.client.query<{
      deletion_state: string;
      count: string;
    }>(
      `select deletion_state, count(*)::text as count from drive_files
        group by deletion_state`,
    );
    expect(rows.rows).toEqual([{ deletion_state: "pending", count: "1" }]);
    const jobs = await state.database.client.query<{ count: string }>(
      `select count(*)::text as count from background_jobs
        where type = 'cleanup_drive_object'`,
    );
    expect(jobs.rows[0]!.count).toBe("1");
    await state.close();
  });

  it("orphans a Session's drive files on deletion without removing bytes", async () => {
    const state = await setup();
    const tenant = await seedTenant(state.database, "a");
    const bytes = new TextEncoder().encode("survives session");
    state.setArtifacts([exportEntry("ark-file-1", "kept.txt", bytes.length)]);
    state.storage.putExternal(
      exportLocation("ark-file-1"),
      bytes,
      "text/plain",
    );
    const [artifact] = await state.artifacts.syncSession(tenant.sessionId, {
      userId: tenant.userId,
      requestId: "req-1",
    });

    const orphaned = await state.repositories.sessionDeletion.orphanDriveFiles(
      tenant.userId,
      tenant.sessionId,
      now,
    );
    expect(orphaned).toBe(1);
    // Deleting the Session row cascades the association, but the bytes remain
    // until the drive GC reaps them under the configured retention.
    await state.repositories.sessionDeletion.removeLocal(
      tenant.userId,
      tenant.sessionId,
    );
    expect(state.storage.keys()).toHaveLength(1);
    const driveRow = await state.database.client.query<{ id: string }>(
      `select id from drive_files where id = $1`,
      [artifact!.driveFileId],
    );
    expect(driveRow.rows).toHaveLength(1);
    await state.close();
  });

  it("refuses to clean up an object key outside the caller's tenant prefix", async () => {
    const state = await setup();
    const tenant = await seedTenant(state.database, "a");
    await expect(
      state.artifacts.cleanupStoredObject(
        "tenants/00000000-0000-4000-8000-0000000000ff/secret",
        tenant.userId,
      ),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(
      state.artifacts.cleanupStoredObject(
        `tenants/${tenant.userId}/../escape`,
        tenant.userId,
      ),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
    await state.close();
  });
});

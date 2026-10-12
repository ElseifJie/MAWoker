import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRepositories } from "../packages/db/src/index.js";

const databaseUrl = process.env.TEST_POSTGRES_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("artifact tombstone contention in real PostgreSQL", () => {
  const schemaName = `task01_artifact_${randomUUID().replaceAll("-", "")}`;
  let administrationPool: Pool;
  let workerPool: Pool;

  beforeAll(async () => {
    administrationPool = new Pool({ connectionString: databaseUrl });
    await administrationPool.query(`create schema "${schemaName}"`);

    workerPool = new Pool({
      connectionString: databaseUrl,
      max: 6,
      options: `-c search_path=${schemaName}`,
    });
    await workerPool.query(`
      create table drive_files (
        id uuid primary key,
        owner_user_id uuid not null,
        origin text not null,
        tos_object_key text not null,
        name text not null,
        mime_type text not null,
        size_bytes bigint not null,
        content_hash text,
        source_session_id uuid,
        folder_id uuid,
        deletion_state text not null default 'none',
        write_lease_until timestamptz,
        orphaned_at timestamptz,
        last_error_code text,
        created_at timestamptz not null,
        updated_at timestamptz not null
      );
      create table artifacts (
        id uuid primary key,
        owner_user_id uuid not null,
        session_id uuid not null,
        ark_file_id text not null,
        drive_file_id uuid not null references drive_files(id),
        name text not null,
        mime_type text not null,
        size_bytes bigint not null,
        generated_at timestamptz not null,
        deletion_state text not null default 'none',
        last_error_code text,
        created_at timestamptz not null,
        updated_at timestamptz not null
      );
    `);
  });

  afterAll(async () => {
    await workerPool?.end();
    if (administrationPool) {
      await administrationPool.query(
        `drop schema if exists "${schemaName}" cascade`,
      );
      await administrationPool.end();
    }
  });

  it("serializes final shared-reference tombstones on the Drive row", async () => {
    const ownerUserId = randomUUID();
    const sessionId = randomUUID();
    const driveFileId = randomUUID();
    const artifactIds = [randomUUID(), randomUUID()].sort();
    const tombstonedAt = new Date("2026-10-12T00:00:00.000Z");
    await workerPool.query(
      `insert into drive_files
        (id, owner_user_id, origin, tos_object_key, name, mime_type,
         size_bytes, created_at, updated_at)
       values ($1, $2, 'artifact', $3, 'report.txt', 'text/plain', 5, now(), now())`,
      [
        driveFileId,
        ownerUserId,
        `tenants/${ownerUserId}/drive/artifact/${driveFileId}/report.txt`,
      ],
    );
    await workerPool.query(
      `insert into artifacts
        (id, owner_user_id, session_id, ark_file_id, drive_file_id, name,
         mime_type, size_bytes, generated_at, created_at, updated_at)
       values ($1, $3, $4, 'ark-output-1', $5, 'report.txt', 'text/plain', 5,
               now(), now(), now()),
              ($2, $3, $4, 'ark-output-2', $5, 'report.txt', 'text/plain', 5,
               now(), now(), now())`,
      [artifactIds[0], artifactIds[1], ownerUserId, sessionId, driveFileId],
    );

    const blocker = await workerPool.connect();
    const observer = await workerPool.connect();
    const repositories = createRepositories(drizzle(workerPool));
    let deletions: Promise<unknown>[] = [];
    try {
      await blocker.query("begin");
      await blocker.query(
        `select id from drive_files where id = $1 for update`,
        [driveFileId],
      );

      deletions = artifactIds.map((artifactId) =>
        Promise.resolve(
          repositories.artifacts.requestDelete(
            artifactId,
            ownerUserId,
            tombstonedAt,
          ),
        ),
      );
      await delay(100);

      await observer.query("begin");
      const unlocked = await observer.query<{
        id: string;
        deletion_state: string;
      }>(
        `select id, deletion_state
           from artifacts
          where drive_file_id = $1
          order by id
          for update skip locked`,
        [driveFileId],
      );
      await observer.query("rollback");
      expect(unlocked.rows).toEqual(
        artifactIds.map((id) => ({ id, deletion_state: "none" })),
      );

      await blocker.query("commit");
      await Promise.all(deletions);

      const drive = await workerPool.query<{ orphaned_at: Date | null }>(
        `select orphaned_at from drive_files where id = $1`,
        [driveFileId],
      );
      expect(drive.rows[0]!.orphaned_at).toEqual(tombstonedAt);
    } finally {
      await observer.query("rollback");
      await blocker.query("rollback");
      await Promise.allSettled(deletions);
      observer.release();
      blocker.release();
    }
  });
});

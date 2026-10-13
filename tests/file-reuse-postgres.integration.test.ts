import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRepositories } from "../packages/db/src/index.js";
import { DriveFileService } from "../packages/domain/src/drive-files.js";
import { DriveObjectCleanupProcessor } from "../apps/worker/src/drive-object-cleanup.js";
import { ArtifactObjectCleanupProcessor } from "../apps/worker/src/artifact-object-cleanup.js";
const url = process.env.TEST_POSTGRES_URL;
(url ? describe : describe.skip)("file reuse PostgreSQL protection", () => {
  const schema = `b2_reuse_${randomUUID().replaceAll("-", "")}`;
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({
      connectionString: url,
      max: 4,
      options: `-c search_path=${schema} -c statement_timeout=15000`,
    });
    await pool.query(`create schema "${schema}"`);
    const client = await pool.connect();
    try {
      const directory = resolve(
        import.meta.dirname,
        "../packages/db/migrations",
      );
      for (const file of (await readdir(directory))
        .filter((file) => /^\d{4}.*\.sql$/.test(file))
        .sort()) {
        await client.query("begin");
        for (const statement of (
          await readFile(resolve(directory, file), "utf8")
        )
          .replaceAll('"public".', `"${schema}".`)
          .split("--> statement-breakpoint"))
          if (statement.trim()) await client.query(statement);
        await client.query("commit");
      }
    } finally {
      client.release();
    }
  });
  afterAll(async () => {
    if (pool) {
      await pool.query(`drop schema "${schema}" cascade`);
      await pool.end();
    }
  });
  it("keeps another task's committed artifact live across deletion and stale cleanup", async () => {
    const uid = randomUUID(),
      aid = randomUUID(),
      sidA = randomUUID(),
      sidB = randomUUID(),
      did = randomUUID();
    await pool.query(
      "insert into users(id,auth_subject,email) values($1,$2,$3)",
      [uid, uid, `${uid}@example.com`],
    );
    await pool.query(
      "insert into personal_agents(id,owner_user_id,ark_agent_id,name,model_id,system_prompt,ark_version,status) values($1,$2,$3,'A','m','s','1','active')",
      [aid, uid, aid],
    );
    for (const sid of [sidA, sidB])
      await pool.query(
        "insert into sessions(id,owner_user_id,personal_agent_id,ark_session_id,agent_kind,ark_agent_id,agent_version,environment_id,title) values($1,$2,$3,$4,'personal',$5,'1','e','Task')",
        [sid, uid, aid, sid, aid],
      );
    const repo = createRepositories(drizzle(pool));
    const key = `tenants/${uid}/drive/artifact/${did}/report.txt`;
    await repo.driveFiles.stage({
      id: did,
      ownerUserId: uid,
      origin: "artifact",
      objectKey: key,
      name: "report.txt",
      mimeType: "text/plain",
      sizeBytes: 6,
      sourceSessionId: sidB,
      runAfter: new Date(Date.now() + 60_000),
      writeLeaseUntil: new Date(Date.now() + 60_000),
    });
    // Commit B's bytes, then hold its association outside the transaction while A is removed.
    await repo.driveFiles.commit({ id: did, ownerUserId: uid });
    await pool.query(
      "update sessions set deletion_state='pending' where id=$1",
      [sidA],
    );
    await repo.sessionDeletion.removeLocal(uid, sidA);
    const claimed = await repo.driveFiles.claimOrphans({
      limit: 10,
      retentionMs: 0,
      now: new Date(),
    });
    const timestamp = new Date();
    await repo.artifacts.upsertAssociation({
      id: randomUUID(),
      ownerUserId: uid,
      sessionId: sidB,
      driveFileId: did,
      arkFileId: randomUUID(),
      tosObjectKey: key,
      name: "report.txt",
      mimeType: "text/plain",
      sizeBytes: 6,
      generatedAt: timestamp,
      deletionState: "none",
      lastErrorCode: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const deletion = vi.fn(async () => {});
    const processor = new DriveObjectCleanupProcessor({
      jobs: repo.jobs,
      guards: {
        findDriveCleanupGuard: repo.driveFiles.findCleanupGuard,
        findCleanupJobClaim: repo.driveFiles.findCleanupJobClaim,
      },
      service: new DriveFileService({
        repository: repo.driveFiles,
        storage: { delete: deletion } as never,
        createId: randomUUID,
      }),
      workerId: "b2-delete-review",
    });
    await processor.runOnce();
    expect(deletion).not.toHaveBeenCalled();
    expect(claimed).toBe(0);
    expect((await repo.driveFiles.findOwned(uid, did))?.orphanedAt).toBeNull();
    expect(
      await repo.driveFiles.switchObjectKey(did, uid, {
        objectKey: `${key}.next`,
        mimeType: "text/plain",
        sizeBytes: 7,
      }),
    ).toBeDefined();
    // A stale cleanup intent must protect a live association even if the flag is corrupt.
    await pool.query("update drive_files set orphaned_at=now() where id=$1", [
      did,
    ]);
    await pool.query(
      "update background_jobs set status='pending',run_after=now()-interval '1 second' where id=$1",
      [did],
    );
    await processor.runOnce();
    expect(deletion).not.toHaveBeenCalled();
    expect(
      (await repo.driveFiles.findCleanupGuard(did))?.orphanedAt,
    ).toBeNull();
    await pool.query("update drive_files set orphaned_at=null where id=$1", [
      did,
    ]);
    // Pin the current version, retire it, then reclaim only after the reference ends.
    const artifactId = (await repo.artifacts.listOwned(uid))[0]!.id;
    const inputId = randomUUID();
    await repo.fileReuse.reserve({
      id: inputId,
      userId: uid,
      artifactId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await repo.driveFiles.switchObjectKey(did, uid, {
      objectKey: `${key}.latest`,
      mimeType: "text/plain",
      sizeBytes: 8,
    });
    await repo.driveFiles.enqueueRetiredKeyCleanup(`${key}.next`, uid);
    const retiredDeletion = vi.fn(async () => {});
    const retired = new ArtifactObjectCleanupProcessor({
      jobs: repo.jobs,
      guards: {
        findObjectCleanupGuard: repo.driveFiles.findObjectCleanupGuard,
        findCleanupJobClaim: repo.driveFiles.findCleanupJobClaim,
      },
      service: { cleanupStoredObject: retiredDeletion },
      workerId: "b2-retired-review",
    });
    await pool.query(
      "update background_jobs set run_after=now()-interval '1 second' where type='cleanup_artifact_object' and payload->>'objectKey'=$1",
      [`${key}.next`],
    );
    await retired.runOnce();
    expect(retiredDeletion).not.toHaveBeenCalled();
    expect(
      (
        await pool.query(
          "select status from background_jobs where type='cleanup_artifact_object' and payload->>'objectKey'=$1",
          [`${key}.next`],
        )
      ).rows[0].status,
    ).toBe("pending");
    await repo.fileReuse.release(inputId, uid);
    await repo.sessionInputs.removeUnbound(inputId, uid);
    await pool.query(
      "update background_jobs set run_after=now()-interval '1 second' where type='cleanup_artifact_object' and payload->>'objectKey'=$1",
      [`${key}.next`],
    );
    await retired.runOnce();
    expect(retiredDeletion).toHaveBeenCalledWith(`${key}.next`, uid);
  });

  it("does not activate an association while its drive cleanup is running", async () => {
    const uid = randomUUID(),
      aid = randomUUID(),
      sid = randomUUID(),
      did = randomUUID();
    await pool.query(
      "insert into users(id,auth_subject,email) values($1,$2,$3)",
      [uid, uid, `${uid}@example.com`],
    );
    await pool.query(
      "insert into personal_agents(id,owner_user_id,ark_agent_id,name,model_id,system_prompt,ark_version,status) values($1,$2,$3,'A','m','s','1','active')",
      [aid, uid, aid],
    );
    await pool.query(
      "insert into sessions(id,owner_user_id,personal_agent_id,ark_session_id,agent_kind,ark_agent_id,agent_version,environment_id) values($1,$2,$3,$4,'personal',$5,'1','e')",
      [sid, uid, aid, sid, aid],
    );
    const repo = createRepositories(drizzle(pool));
    await repo.driveFiles.stage({
      id: did,
      ownerUserId: uid,
      origin: "artifact",
      objectKey: `tenants/${uid}/${did}`,
      name: "report.txt",
      mimeType: "text/plain",
      sizeBytes: 6,
      sourceSessionId: sid,
      runAfter: new Date(Date.now() + 60_000),
      writeLeaseUntil: new Date(Date.now() + 60_000),
    });
    await repo.driveFiles.commit({ id: did, ownerUserId: uid });
    await pool.query(
      "update background_jobs set status='running' where id=$1",
      [did],
    );
    const timestamp = new Date();
    await expect(
      repo.artifacts.upsertAssociation({
        id: randomUUID(),
        ownerUserId: uid,
        sessionId: sid,
        driveFileId: did,
        arkFileId: randomUUID(),
        tosObjectKey: `tenants/${uid}/${did}`,
        name: "report.txt",
        mimeType: "text/plain",
        sizeBytes: 6,
        generatedAt: timestamp,
        deletionState: "none",
        lastErrorCode: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    ).rejects.toThrow();
    expect(await repo.artifacts.listOwned(uid)).toEqual([]);
  });

  it("serializes source deletion behind a pinned input reservation", async () => {
    const uid = randomUUID(),
      sid = randomUUID(),
      aid = randomUUID(),
      did = randomUUID(),
      fid = randomUUID(),
      inputId = randomUUID();
    await pool.query(
      "insert into users(id,auth_subject,email) values($1,$2,$3)",
      [uid, uid, `${uid}@example.com`],
    );
    await pool.query(
      "insert into personal_agents(id,owner_user_id,ark_agent_id,name,model_id,system_prompt,ark_version,status) values($1,$2,'a','A','m','s','1','active')",
      [aid, uid],
    );
    await pool.query(
      "insert into sessions(id,owner_user_id,personal_agent_id,ark_session_id,agent_kind,ark_agent_id,agent_version,environment_id,title) values($1,$2,$3,'s','personal','a','1','e','Task')",
      [sid, uid, aid],
    );
    await pool.query(
      "insert into drive_files(id,owner_user_id,origin,tos_object_key,name,mime_type,size_bytes,deletion_state) values($1,$2,'artifact','key','报告.txt','text/plain',6,'none')",
      [did, uid],
    );
    await pool.query(
      "insert into artifacts(id,owner_user_id,session_id,drive_file_id,ark_file_id,name,mime_type,size_bytes,generated_at) values($1,$2,$3,$4,'f','报告.txt','text/plain',6,now())",
      [fid, uid, sid, did],
    );
    const deleting = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await drizzle(pool).transaction(async (tx) => {
        await createRepositories(tx).fileReuse.reserve({
          id: inputId,
          userId: uid,
          artifactId: fid,
          expiresAt: new Date(Date.now() + 60_000),
        });
        const pid = (await deleting.query("select pg_backend_pid() pid"))
          .rows[0].pid;
        pending = createRepositories(drizzle(deleting)).artifacts.requestDelete(
          fid,
          uid,
          new Date(),
        );
        void pending.catch(() => {});
        await expect
          .poll(
            async () =>
              (
                await tx.execute<{ blocked: boolean }>(
                  sql`select cardinality(pg_blocking_pids(${pid}))>0 blocked`,
                )
              ).rows[0]!.blocked,
          )
          .toBe(true);
      });
      await pending;
      const repo = createRepositories(drizzle(pool));
      expect(
        await repo.driveFiles.claimOrphans({
          limit: 5,
          retentionMs: 0,
          now: new Date(Date.now() + 1000),
        }),
      ).toBe(0);
      await pool.query("delete from sessions where id=$1", [sid]);
      expect(await repo.artifacts.hasInputReferences(uid, did, "key")).toBe(
        true,
      );
    } finally {
      await pending?.catch(() => {});
      deleting.release();
    }
  });
});

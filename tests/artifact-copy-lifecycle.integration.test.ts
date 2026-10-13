import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { describe, it, expect, vi } from "vitest";
import { createRepositories } from "../packages/db/src/index.js";
import { ArtifactService } from "../packages/domain/src/artifacts.js";
import { DriveFileService } from "../packages/domain/src/drive-files.js";
import { DriveObjectCleanupProcessor } from "../apps/worker/src/drive-object-cleanup.js";
import { createTestDatabase } from "./support/test-database.js";

async function postgresFixture() {
  const schema = `ab_copy_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({
    connectionString: process.env.TEST_POSTGRES_URL,
    max: 4,
    options: `-c search_path=${schema} -c statement_timeout=15000`,
  });
  try {
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
    return {
      client: pool,
      db: drizzle(pool),
      close: async () => {
        await pool.query(`drop schema "${schema}" cascade`);
        await pool.end();
      },
    };
  } catch (error) {
    await pool
      .query(`drop schema if exists "${schema}" cascade`)
      .catch(() => {});
    await pool.end();
    throw error;
  }
}

for (const backend of ["pglite", "postgres"] as const) {
  (backend === "postgres" && !process.env.TEST_POSTGRES_URL
    ? describe.skip
    : describe)(`artifact copy lifecycle ${backend}`, () => {
    it("recovers an aged pre-fix leaked copy while preserving references, leases, other origins and retention", async () => {
      const f =
        backend === "postgres"
          ? await postgresFixture()
          : await createTestDatabase();
      try {
        const uid = randomUUID(),
          aid = randomUUID(),
          sid = randomUUID();
        await f.client.query(
          "insert into users(id,auth_subject,email) values($1,$2,$3)",
          [uid, uid, `${uid}@example.com`],
        );
        await f.client.query(
          "insert into personal_agents(id,owner_user_id,ark_agent_id,name,model_id,system_prompt,ark_version,status) values($1,$2,$3,'A','m','s','1','active')",
          [aid, uid, aid],
        );
        await f.client.query(
          "insert into sessions(id,owner_user_id,personal_agent_id,ark_session_id,agent_kind,ark_agent_id,agent_version,environment_id) values($1,$2,$3,$4,'personal',$5,'1','e')",
          [sid, uid, aid, sid, aid],
        );
        const repo = createRepositories(f.db),
          ids = new Map<string, string>();
        for (const mode of [
          "leaked",
          "associated",
          "reused",
          "leased",
          "recent",
          "upload",
          "import",
          "live-job",
        ]) {
          const did = randomUUID();
          ids.set(mode, did);
          const origin =
            mode === "upload" || mode === "import" ? mode : "artifact";
          const key = `tenants/${uid}/drive/${origin}/${did}/report.txt`;
          await repo.driveFiles.stage({
            id: did,
            ownerUserId: uid,
            origin,
            objectKey: key,
            name: "report.txt",
            mimeType: "text/plain",
            sizeBytes: 3,
            sourceSessionId: sid,
            runAfter: new Date(Date.now() + 60_000),
            writeLeaseUntil: new Date(Date.now() + 60_000),
          });
          await repo.driveFiles.commit({ id: did, ownerUserId: uid });
          if (mode === "associated" || mode === "reused") {
            const fid = randomUUID(),
              timestamp = new Date();
            await repo.artifacts.upsertAssociation({
              id: fid,
              ownerUserId: uid,
              sessionId: sid,
              arkFileId: fid,
              driveFileId: did,
              tosObjectKey: key,
              name: "report.txt",
              mimeType: "text/plain",
              sizeBytes: 3,
              generatedAt: timestamp,
              deletionState: "none",
              lastErrorCode: null,
              createdAt: timestamp,
              updatedAt: timestamp,
            });
            if (mode === "reused") {
              await repo.fileReuse.reserve({
                id: randomUUID(),
                userId: uid,
                artifactId: fid,
                expiresAt: new Date(Date.now() + 60_000),
              });
              await repo.artifacts.requestDelete(fid, uid, new Date());
            }
          }
          // Reproduce the previous implementation's fully committed but untracked row.
          await f.client.query(
            "update drive_files set orphaned_at=null,created_at=now()-interval '2 days' where id=$1",
            [did],
          );
          await f.client.query(
            "update background_jobs set status='succeeded' where id=$1",
            [did],
          );
          if (mode === "leased")
            await f.client.query(
              "update drive_files set write_lease_until=now()+interval '1 hour' where id=$1",
              [did],
            );
          if (mode === "recent")
            await f.client.query(
              "update drive_files set created_at=now() where id=$1",
              [did],
            );
          if (mode === "live-job")
            await f.client.query(
              "update background_jobs set status='pending' where id=$1",
              [did],
            );
        }
        const now = new Date();
        expect(
          await repo.driveFiles.claimOrphans({
            limit: 20,
            retentionMs: 24 * 60 * 60_000,
            now,
          }),
        ).toBe(1);
        expect(
          (await repo.driveFiles.findOwned(uid, ids.get("leaked")!))
            ?.orphanedAt,
        ).not.toBeNull();
        await f.client.query(
          "update background_jobs set run_after=now()-interval '1 second' where id=$1",
          [ids.get("leaked")!],
        );
        const deletion = vi.fn(async () => {});
        const drive = new DriveFileService({
          repository: repo.driveFiles,
          storage: { delete: deletion } as never,
          createId: randomUUID,
        });
        await new DriveObjectCleanupProcessor({
          jobs: repo.jobs,
          guards: {
            findDriveCleanupGuard: repo.driveFiles.findCleanupGuard,
            findCleanupJobClaim: repo.driveFiles.findCleanupJobClaim,
          },
          service: drive,
          workerId: "historical-recovery",
        }).runOnce();
        expect(deletion).toHaveBeenCalledTimes(1);
        expect(deletion).toHaveBeenCalledWith(
          `tenants/${uid}/drive/artifact/${ids.get("leaked")!}/report.txt`,
        );
        for (const [mode, did] of ids)
          expect(
            (await repo.driveFiles.findOwned(uid, did))?.deletionState,
          ).toBe(mode === "leaked" ? "deleted" : "none");
      } finally {
        await f.close();
      }
    });

    it.each(["cancelled", "crashed", "associated"] as const)(
      "reclaims only an unassociated %s copy through the durable cleanup job",
      async (mode) => {
        const f =
          backend === "postgres"
            ? await postgresFixture()
            : await createTestDatabase();
        try {
          const uid = randomUUID(),
            aid = randomUUID(),
            sid = randomUUID();
          await f.client.query(
            "insert into users(id,auth_subject,email) values($1,$2,$3)",
            [uid, uid, `${uid}@example.com`],
          );
          await f.client.query(
            "insert into personal_agents(id,owner_user_id,ark_agent_id,name,model_id,system_prompt,ark_version,status) values($1,$2,$3,'A','m','s','1','active')",
            [aid, uid, aid],
          );
          await f.client.query(
            "insert into sessions(id,owner_user_id,personal_agent_id,ark_session_id,agent_kind,ark_agent_id,agent_version,environment_id) values($1,$2,$3,$4,'personal',$5,'1','e')",
            [sid, uid, aid, sid, aid],
          );
          const repo = createRepositories(f.db);
          const deletion = vi.fn(async () => {});
          const drive = new DriveFileService({
            repository: repo.driveFiles,
            storage: {
              readExternal: async () => Readable.from(["abc"]),
              write: async () => {},
              delete: deletion,
            },
            createId: randomUUID,
          });
          const input = {
            ownerUserId: uid,
            origin: "artifact" as const,
            name: "report.txt",
            mimeType: "text/plain",
            sizeBytes: 3,
            source: { bucket: "test", objectKey: "source" },
            sourceSessionId: sid,
          };
          if (mode === "crashed") {
            // A stopped process performs no catch/finally or association call.
            await drive.createFromSource(input, {
              userId: uid,
              requestId: "crash",
            });
          } else {
            const controller = new AbortController();
            const service = new ArtifactService({
              repository: repo.artifacts,
              drive: {
                findOwned: drive.findOwned.bind(drive),
                refreshFromSource: drive.refreshFromSource.bind(drive),
                createFromSource: async (...args) => {
                  const result = await drive.createFromSource(...args);
                  if (mode === "cancelled") controller.abort();
                  return result;
                },
              },
              ark: {
                listArtifacts: async () => [
                  {
                    id: "output",
                    sessionId: sid,
                    name: "report.txt",
                    contentType: "text/plain",
                    size: 3,
                    createdAt: new Date().toISOString(),
                    tos: { bucket: "test", objectKey: "source" },
                  },
                ],
              } as never,
              storage: {} as never,
              createId: randomUUID,
            });
            const operation = service.syncSession(sid, {
              userId: uid,
              requestId: mode,
              signal: controller.signal,
            });
            if (mode === "cancelled")
              await expect(operation).rejects.toMatchObject({
                name: "AbortError",
              });
            else await operation;
          }
          const [row] = (
            await f.client.query(
              "select id,tos_object_key,orphaned_at from drive_files",
            )
          ).rows;
          const [job] = (
            await f.client.query(
              "select status from background_jobs where id=$1",
              [row!.id],
            )
          ).rows;
          expect(job!.status).toBe(
            mode === "associated" ? "succeeded" : "pending",
          );
          expect(Boolean(row!.orphaned_at)).toBe(mode !== "associated");
          await f.client.query(
            "update background_jobs set run_after=now()-interval '1 second' where id=$1",
            [row!.id],
          );
          const processor = new DriveObjectCleanupProcessor({
            jobs: repo.jobs,
            guards: {
              findDriveCleanupGuard: repo.driveFiles.findCleanupGuard,
              findCleanupJobClaim: repo.driveFiles.findCleanupJobClaim,
            },
            service: drive,
            workerId: "copy-recovery",
          });
          await processor.runOnce();
          if (mode === "associated") {
            expect(deletion).not.toHaveBeenCalled();
            expect(
              (await repo.driveFiles.findOwned(uid, row!.id))?.deletionState,
            ).toBe("none");
          } else {
            expect(deletion).toHaveBeenCalledWith(row!.tos_object_key);
            expect(
              (await repo.driveFiles.findOwned(uid, row!.id))?.deletionState,
            ).toBe("deleted");
          }
        } finally {
          await f.close();
        }
      },
    );
  });
}

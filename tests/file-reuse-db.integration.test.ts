import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createRepositories } from "../packages/db/src/index.js";
import { createTestDatabase } from "./support/test-database.js";

describe("owned file reuse", () => {
  it("keeps a durable input reference through source deletion and orphan GC", async () => {
    const f = await createTestDatabase();
    try {
      const uid = randomUUID(),
        sid = randomUUID(),
        aid = randomUUID(),
        did = randomUUID(),
        fid = randomUUID(),
        inputId = randomUUID();
      await f.client.query(
        "insert into users(id,auth_subject,email) values($1,$2,$3)",
        [uid, uid, `${uid}@example.com`],
      );
      await f.client.query(
        "insert into personal_agents(id,owner_user_id,ark_agent_id,name,model_id,system_prompt,ark_version,status) values($1,$2,'a','A','m','s','1','active')",
        [aid, uid],
      );
      await f.client.query(
        "insert into sessions(id,owner_user_id,personal_agent_id,ark_session_id,agent_kind,ark_agent_id,agent_version,environment_id,title) values($1,$2,$3,'s','personal','a','1','e','Task')",
        [sid, uid, aid],
      );
      await f.client.query(
        "insert into drive_files(id,owner_user_id,origin,tos_object_key,name,mime_type,size_bytes,deletion_state) values($1,$2,'artifact','key','报告.txt','text/plain',6,'none')",
        [did, uid],
      );
      await f.client.query(
        "insert into artifacts(id,owner_user_id,session_id,drive_file_id,ark_file_id,name,mime_type,size_bytes,generated_at) values($1,$2,$3,$4,'f','报告.txt','text/plain',6,now())",
        [fid, uid, sid, did],
      );
      const repos = createRepositories(f.db);
      expect(repos.fileReuse).toBeDefined();
      expect(
        await repos.fileReuse.reserve({
          id: randomUUID(),
          userId: randomUUID(),
          artifactId: fid,
          expiresAt: new Date(Date.now() + 60_000),
        }),
      ).toBeUndefined();
      expect(
        await repos.fileReuse.reserve({
          id: inputId,
          userId: uid,
          artifactId: fid,
          expiresAt: new Date(Date.now() + 60_000),
        }),
      ).toMatchObject({ driveId: did, name: "报告.txt" });
      await repos.driveFiles.switchObjectKey(did, uid, {
        objectKey: "new-key",
        mimeType: "text/plain",
        sizeBytes: 6,
      });
      expect(
        await repos.driveFiles.findObjectCleanupGuard("key"),
      ).toMatchObject({ deletionState: "none" });
      await repos.artifacts.requestDelete(fid, uid, new Date());
      expect(
        await repos.driveFiles.claimOrphans({
          limit: 10,
          retentionMs: 0,
          now: new Date(Date.now() + 1000),
        }),
      ).toBe(0);
      await repos.fileReuse.release(inputId, uid);
      await repos.sessionInputs.removeUnbound(inputId, uid);
      expect(
        await repos.driveFiles.claimOrphans({
          limit: 10,
          retentionMs: 0,
          now: new Date(Date.now() + 1000),
        }),
      ).toBe(1);
      await f.client.query(
        "update artifacts set deletion_state='none' where id=$1",
        [fid],
      );
      await f.client.query(
        "update drive_files set orphaned_at=null where id=$1",
        [did],
      );
      const cancelled = randomUUID();
      await repos.fileReuse.reserve({
        id: cancelled,
        userId: uid,
        artifactId: fid,
        expiresAt: new Date(Date.now() + 1000),
      });
      await repos.fileReuse.release(cancelled, uid);
      await repos.sessionInputs.removeUnbound(cancelled, uid);
      expect(
        (await repos.driveFiles.findOwned(uid, did))?.orphanedAt,
      ).toBeNull();
      expect(
        await repos.driveFiles.switchObjectKey(did, uid, {
          objectKey: "latest",
          mimeType: "text/plain",
          sizeBytes: 6,
        }),
      ).toBeDefined();
    } finally {
      await f.close();
    }
  });
});

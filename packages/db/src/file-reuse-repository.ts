import { sql, type SQL } from "drizzle-orm";
type Row = Record<string, unknown>;
interface Database {
  execute<T extends Row = Row>(query: SQL): PromiseLike<{ rows: T[] }>;
  transaction<T>(callback: (transaction: Database) => Promise<T>): Promise<T>;
}
export function createFileReuseRepository(db: Database) {
  return {
    async reserve(input: {
      id: string;
      userId: string;
      artifactId: string;
      expiresAt: Date;
    }) {
      return db.transaction(async (tx) => {
        const source = await tx.execute<{
          driveId: string;
          name: string;
          mimeType: string;
          sizeBytes: number;
          objectKey: string;
        }>(
          sql`select d.id as "driveId",a.name,a.mime_type as "mimeType",a.size_bytes as "sizeBytes",d.tos_object_key as "objectKey"
            from artifacts a join drive_files d on d.id=a.drive_file_id and d.owner_user_id=a.owner_user_id
            where a.id=${input.artifactId} and a.owner_user_id=${input.userId}
            and a.deletion_state='none' and d.deletion_state='none' for update of d`,
        );
        const file = source.rows[0];
        if (!file) return;
        const valid =
          await tx.execute(sql`select id from artifacts where id=${input.artifactId}
          and owner_user_id=${input.userId} and drive_file_id=${file.driveId} and deletion_state='none' for update`);
        if (!valid.rows.length) return;
        await tx.execute(sql`select id from background_jobs where
          (id=${file.driveId} and type='cleanup_drive_object' or
            type='cleanup_artifact_object' and payload->>'objectKey'=${file.objectKey})
          for update`);
        const running =
          await tx.execute(sql`select id from background_jobs where
          (id=${file.driveId} and type='cleanup_drive_object' or
            type='cleanup_artifact_object' and payload->>'objectKey'=${file.objectKey})
          and status='running'`);
        if (running.rows.length) return;
        await tx.execute(sql`insert into session_inputs
          (id,owner_user_id,original_name,mime_type,size_bytes,drive_file_id,reused_object_key,mount_path,status,expires_at)
          values(${input.id},${input.userId},${file.name},${file.mimeType},${file.sizeBytes},${file.driveId},${file.objectKey},'', 'uploading',${input.expiresAt})`);
        await tx.execute(sql`insert into background_jobs(id,owner_user_id,type,status,priority,payload,run_after)
          values(${input.id},${input.userId},'cleanup_upload','pending',200,${JSON.stringify({ uploadId: input.id })}::jsonb,${input.expiresAt})`);
        return { ...file, sizeBytes: Number(file.sizeBytes) };
      });
    },
    async setMount(id: string, userId: string, mountPath: string) {
      await db.execute(
        sql`update session_inputs set mount_path=${mountPath} where id=${id} and owner_user_id=${userId} and status='uploading'`,
      );
    },
    async release(id: string, userId: string) {
      await db.transaction(async (tx) => {
        const result = await tx.execute<{
          driveId: string;
        }>(sql`select drive_file_id as "driveId" from session_inputs
          where id=${id} and owner_user_id=${userId} and session_id is null`);
        if (result.rows[0])
          await tx.execute(sql`update drive_files set orphaned_at=coalesce(orphaned_at,now())
          where id=${result.rows[0].driveId} and owner_user_id=${userId}
          and not exists(select 1 from artifacts a where a.drive_file_id=drive_files.id and a.deletion_state='none')
          and not exists(select 1 from session_inputs other where other.drive_file_id=drive_files.id and other.id<>${id})`);
        await tx.execute(sql`update session_inputs set expires_at=now(),status='failed',updated_at=now()
          where id=${id} and owner_user_id=${userId} and session_id is null`);
        await tx.execute(
          sql`update background_jobs set run_after=now() where id=${id} and owner_user_id=${userId} and type='cleanup_upload'`,
        );
      });
    },
  };
}

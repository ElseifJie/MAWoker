CREATE TYPE "public"."file_origin" AS ENUM('upload', 'artifact', 'import');--> statement-breakpoint
ALTER TYPE "public"."background_job_type" ADD VALUE 'cleanup_drive_object' BEFORE 'cleanup_upload';--> statement-breakpoint
CREATE TABLE "drive_files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"origin" "file_origin" NOT NULL,
	"tos_object_key" text NOT NULL,
	"name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"content_hash" text,
	"source_session_id" uuid,
	"folder_id" uuid,
	"deletion_state" "deletion_state" DEFAULT 'pending' NOT NULL,
	"write_lease_until" timestamp with time zone,
	"orphaned_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drive_files_tos_object_key_unique" UNIQUE("tos_object_key"),
	CONSTRAINT "drive_files_size_check" CHECK ("drive_files"."size_bytes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "drive_files" ADD CONSTRAINT "drive_files_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_files" ADD CONSTRAINT "drive_files_source_session_id_sessions_id_fk" FOREIGN KEY ("source_session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "drive_files_owner_state_idx" ON "drive_files" USING btree ("owner_user_id","deletion_state");--> statement-breakpoint
CREATE INDEX "drive_files_owner_orphaned_idx" ON "drive_files" USING btree ("owner_user_id","orphaned_at");--> statement-breakpoint
CREATE INDEX "drive_files_source_session_idx" ON "drive_files" USING btree ("source_session_id");--> statement-breakpoint
ALTER TABLE "artifacts" DROP CONSTRAINT "artifacts_tos_object_key_unique";--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "drive_file_id" uuid;--> statement-breakpoint
ALTER TABLE "session_inputs" ADD COLUMN "drive_file_id" uuid;--> statement-breakpoint
-- Backfill: every existing artifact becomes the sole owner of its object. The
-- object key is carried over unchanged; a later rekey job may relocate it to
-- the drive layout without changing this row's identity.
INSERT INTO "drive_files"
  ("id", "owner_user_id", "origin", "tos_object_key", "name", "mime_type",
   "size_bytes", "source_session_id", "deletion_state", "last_error_code",
   "created_at", "updated_at")
SELECT
  gen_random_uuid(), artifact."owner_user_id", 'artifact',
  artifact."tos_object_key", artifact."name", artifact."mime_type",
  artifact."size_bytes", artifact."session_id",
  CASE
    WHEN artifact."deletion_state" = 'deleted' THEN 'deleted'::"deletion_state"
    ELSE 'none'::"deletion_state"
  END,
  artifact."last_error_code", artifact."created_at", artifact."updated_at"
FROM "artifacts" artifact
WHERE artifact."tos_object_key" IS NOT NULL
ON CONFLICT ("tos_object_key") DO NOTHING;--> statement-breakpoint
UPDATE "artifacts" artifact
   SET "drive_file_id" = drive."id"
  FROM "drive_files" drive
 WHERE drive."tos_object_key" = artifact."tos_object_key"
   AND artifact."drive_file_id" IS NULL;--> statement-breakpoint
-- Artifacts whose bytes were already gone (deleted state with no object) have
-- nothing to own; give them a tombstoned drive row so the NOT NULL holds.
INSERT INTO "drive_files"
  ("id", "owner_user_id", "origin", "tos_object_key", "name", "mime_type",
   "size_bytes", "deletion_state", "created_at", "updated_at")
SELECT
  gen_random_uuid(), artifact."owner_user_id", 'artifact',
  'tenants/' || artifact."owner_user_id" || '/sessions/' || artifact."session_id"
    || '/artifacts/gc/' || artifact."id",
  '', 'application/octet-stream', 0, 'deleted'::"deletion_state",
  artifact."created_at", artifact."updated_at"
FROM "artifacts" artifact
WHERE artifact."drive_file_id" IS NULL;--> statement-breakpoint
UPDATE "artifacts" artifact
   SET "drive_file_id" = drive."id"
  FROM "drive_files" drive
 WHERE artifact."drive_file_id" IS NULL
   AND drive."tos_object_key" =
       'tenants/' || artifact."owner_user_id" || '/sessions/' || artifact."session_id"
       || '/artifacts/gc/' || artifact."id";--> statement-breakpoint
ALTER TABLE "artifacts" ALTER COLUMN "drive_file_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_drive_file_id_drive_files_id_fk" FOREIGN KEY ("drive_file_id") REFERENCES "public"."drive_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_inputs" ADD CONSTRAINT "session_inputs_drive_file_id_drive_files_id_fk" FOREIGN KEY ("drive_file_id") REFERENCES "public"."drive_files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifacts_drive_file_idx" ON "artifacts" USING btree ("drive_file_id");--> statement-breakpoint
ALTER TABLE "artifacts" DROP COLUMN "tos_object_key";

CREATE TYPE "public"."config_snapshot_state" AS ENUM('unverified', 'verified', 'incomplete', 'mismatch');--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "create_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "model_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "config_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "config_snapshot_state" "config_snapshot_state" DEFAULT 'unverified' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "config_snapshot_error_code" text;--> statement-breakpoint
UPDATE "sessions"
SET "create_attempted_at" = "created_at"
WHERE "ark_session_id" LIKE 'pending:%';

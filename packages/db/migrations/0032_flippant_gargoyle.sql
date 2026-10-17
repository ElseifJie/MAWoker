CREATE TYPE "public"."run_status" AS ENUM('queued', 'starting', 'running', 'waiting_user', 'waiting_device', 'completed', 'failed', 'canceled', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."run_trigger_kind" AS ENUM('manual', 'automation');--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"trigger_kind" "run_trigger_kind" DEFAULT 'manual' NOT NULL,
	"submission_id" uuid NOT NULL,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"ark_session_id" text,
	"turn_id" uuid,
	"automation_id" uuid,
	"error_code" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runs_owner_submission_key" UNIQUE("owner_user_id","submission_id"),
	CONSTRAINT "runs_version_positive_check" CHECK ("runs"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_owner_conversation_fk" FOREIGN KEY ("owner_user_id","conversation_id") REFERENCES "public"."sessions"("owner_user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_owner_submission_fk" FOREIGN KEY ("owner_user_id","submission_id") REFERENCES "public"."message_submissions"("owner_user_id","submission_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runs_owner_status_idx" ON "runs" USING btree ("owner_user_id","status");--> statement-breakpoint
CREATE INDEX "runs_owner_conversation_created_idx" ON "runs" USING btree ("owner_user_id","conversation_id","created_at");
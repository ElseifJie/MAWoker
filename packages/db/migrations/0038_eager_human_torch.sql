CREATE TYPE "public"."automation_kind" AS ENUM('reminder');--> statement-breakpoint
CREATE TYPE "public"."automation_occurrence_status" AS ENUM('pending', 'claimed', 'completed', 'failed', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."automation_status" AS ENUM('active', 'paused', 'deleted');--> statement-breakpoint
CREATE TABLE "automation_occurrences" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"automation_id" uuid NOT NULL,
	"schedule_version" integer NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"status" "automation_occurrence_status" DEFAULT 'pending' NOT NULL,
	"lease_until" timestamp with time zone,
	"lease_generation" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_occurrences_round_key" UNIQUE("automation_id","schedule_version","scheduled_at")
);
--> statement-breakpoint
CREATE TABLE "automations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"kind" "automation_kind" DEFAULT 'reminder' NOT NULL,
	"schedule" jsonb NOT NULL,
	"timezone" text NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"schedule_version" integer DEFAULT 1 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automations_revision_positive_check" CHECK ("automations"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "user_notifications" DROP CONSTRAINT "user_notifications_kind_check";--> statement-breakpoint
ALTER TABLE "user_notifications" ALTER COLUMN "session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "user_notifications" ALTER COLUMN "turn_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "user_notifications" ADD COLUMN "source_type" text DEFAULT 'turn' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_notifications" ADD COLUMN "source_id" text;--> statement-breakpoint
ALTER TABLE "user_notifications" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "user_notifications" ADD COLUMN "payload" jsonb;--> statement-breakpoint
ALTER TABLE "automation_occurrences" ADD CONSTRAINT "automation_occurrences_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_occurrences" ADD CONSTRAINT "automation_occurrences_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_occurrences_due_idx" ON "automation_occurrences" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE INDEX "automation_occurrences_owner_idx" ON "automation_occurrences" USING btree ("owner_user_id","scheduled_at");--> statement-breakpoint
CREATE INDEX "automations_owner_next_idx" ON "automations" USING btree ("owner_user_id","enabled","next_run_at");--> statement-breakpoint
ALTER TABLE "user_notifications" ADD CONSTRAINT "user_notifications_dedupe_key" UNIQUE("owner_user_id","dedupe_key");--> statement-breakpoint
ALTER TABLE "user_notifications" ADD CONSTRAINT "user_notifications_kind_check" CHECK ("user_notifications"."kind" in ('completed','failed','needs_action','sync_failed','reminder'));
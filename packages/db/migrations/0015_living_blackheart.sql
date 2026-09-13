CREATE TYPE "public"."skill_status" AS ENUM('provisioning', 'active', 'failed', 'deleting');--> statement-breakpoint
CREATE TABLE "personal_agent_skills" (
	"agent_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"ark_skill_id" text NOT NULL,
	"ark_version" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_agent_skills_agent_id_skill_id_pk" PRIMARY KEY("agent_id","skill_id")
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid,
	"ark_skill_id" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"display_title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"latest_version" text DEFAULT '1' NOT NULL,
	"source" text DEFAULT 'custom' NOT NULL,
	"file_name" text DEFAULT '' NOT NULL,
	"file_size" bigint DEFAULT 0 NOT NULL,
	"status" "skill_status" DEFAULT 'provisioning' NOT NULL,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skills_ark_skill_id_unique" UNIQUE("ark_skill_id"),
	CONSTRAINT "skills_file_size_check" CHECK ("skills"."file_size" >= 0)
);
--> statement-breakpoint
ALTER TABLE "background_jobs" ALTER COLUMN "type" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."background_job_type";--> statement-breakpoint
CREATE TYPE "public"."background_job_type" AS ENUM('delete_session', 'delete_artifact', 'cleanup_artifact_object', 'cleanup_drive_object', 'cleanup_upload', 'reconcile_session', 'reconcile_personal_agent');--> statement-breakpoint
ALTER TABLE "background_jobs" ALTER COLUMN "type" SET DATA TYPE "public"."background_job_type" USING "type"::"public"."background_job_type";--> statement-breakpoint
ALTER TABLE "personal_agents" ADD COLUMN "is_auto_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "personal_agent_skills" ADD CONSTRAINT "personal_agent_skills_agent_id_personal_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."personal_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_agent_skills" ADD CONSTRAINT "personal_agent_skills_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personal_agent_skills_skill_idx" ON "personal_agent_skills" USING btree ("skill_id");--> statement-breakpoint
CREATE INDEX "skills_owner_status_idx" ON "skills" USING btree ("owner_user_id","status");--> statement-breakpoint
CREATE INDEX "skills_owner_created_idx" ON "skills" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "personal_agents_owner_auto_default_unique" ON "personal_agents" USING btree ("owner_user_id") WHERE "personal_agents"."is_auto_default";
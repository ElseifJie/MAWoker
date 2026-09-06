CREATE TYPE "public"."agent_kind" AS ENUM('platform', 'personal');--> statement-breakpoint
CREATE TYPE "public"."agent_status" AS ENUM('provisioning', 'active', 'disabled', 'failed', 'deleting');--> statement-breakpoint
CREATE TYPE "public"."audit_result" AS ENUM('succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."background_job_status" AS ENUM('pending', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."background_job_type" AS ENUM('delete_session', 'delete_artifact', 'cleanup_upload', 'reconcile_session');--> statement-breakpoint
CREATE TYPE "public"."deletion_state" AS ENUM('none', 'pending', 'deletion_failed', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."quota_reservation_status" AS ENUM('active', 'consumed', 'released');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('idle', 'running', 'rescheduled', 'terminated');--> statement-breakpoint
CREATE TYPE "public"."upload_status" AS ENUM('uploading', 'uploaded', 'bound', 'failed', 'deleting');--> statement-breakpoint
CREATE TYPE "public"."usage_metric_type" AS ENUM('input_tokens', 'output_tokens', 'runtime_ms', 'tool_calls');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"ark_file_id" text NOT NULL,
	"tos_object_key" text NOT NULL,
	"name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"deletion_state" "deletion_state" DEFAULT 'none' NOT NULL,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifacts_tos_object_key_unique" UNIQUE("tos_object_key"),
	CONSTRAINT "artifacts_size_check" CHECK ("artifacts"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_user_id" uuid,
	"owner_user_id" uuid,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"result" "audit_result" NOT NULL,
	"request_id" text NOT NULL,
	"ark_request_id" text,
	"error_code" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "background_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid,
	"type" "background_job_type" NOT NULL,
	"status" "background_job_status" DEFAULT 'pending' NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 10 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "background_jobs_attempts_check" CHECK ("background_jobs"."attempts" >= 0 and "background_jobs"."max_attempts" > 0)
);
--> statement-breakpoint
CREATE TABLE "personal_agents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"ark_agent_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"model_id" text NOT NULL,
	"system_prompt" text NOT NULL,
	"ark_version" text NOT NULL,
	"status" "agent_status" DEFAULT 'provisioning' NOT NULL,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_agents_owner_id_unique" UNIQUE("owner_user_id","id")
);
--> statement-breakpoint
CREATE TABLE "platform_agents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ark_agent_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"model_id" text NOT NULL,
	"system_prompt" text NOT NULL,
	"ark_version" text NOT NULL,
	"status" "agent_status" DEFAULT 'provisioning' NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_agents_ark_agent_id_unique" UNIQUE("ark_agent_id")
);
--> statement-breakpoint
CREATE TABLE "quota_policies" (
	"key" text PRIMARY KEY NOT NULL,
	"personal_agent_limit" integer NOT NULL,
	"concurrent_session_limit" integer NOT NULL,
	"daily_session_limit" integer NOT NULL,
	"monthly_token_limit" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quota_policies_nonnegative_check" CHECK ("quota_policies"."personal_agent_limit" >= 0
          and "quota_policies"."concurrent_session_limit" >= 0
          and "quota_policies"."daily_session_limit" >= 0
          and "quota_policies"."monthly_token_limit" >= 0)
);
--> statement-breakpoint
CREATE TABLE "quota_reservations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "quota_reservation_status" DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "session_event_cursors" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"last_observed_at" timestamp with time zone,
	"recent_event_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_inputs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"session_id" uuid,
	"ark_file_id" text,
	"original_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"mount_path" text NOT NULL,
	"status" "upload_status" DEFAULT 'uploading' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_inputs_size_check" CHECK ("session_inputs"."size_bytes" >= 0),
	CONSTRAINT "session_inputs_bound_check" CHECK ("session_inputs"."status" <> 'bound' or "session_inputs"."session_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"ark_session_id" text NOT NULL,
	"agent_kind" "agent_kind" NOT NULL,
	"platform_agent_id" uuid,
	"personal_agent_id" uuid,
	"ark_agent_id" text NOT NULL,
	"agent_version" text NOT NULL,
	"environment_id" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"status" "session_status" DEFAULT 'idle' NOT NULL,
	"archived_at" timestamp with time zone,
	"deletion_state" "deletion_state" DEFAULT 'none' NOT NULL,
	"last_event_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_ark_session_id_unique" UNIQUE("ark_session_id"),
	CONSTRAINT "sessions_owner_id_unique" UNIQUE("owner_user_id","id"),
	CONSTRAINT "sessions_exactly_one_agent_check" CHECK ((
        ("sessions"."agent_kind" = 'platform' and "sessions"."platform_agent_id" is not null and "sessions"."personal_agent_id" is null)
        or
        ("sessions"."agent_kind" = 'personal' and "sessions"."personal_agent_id" is not null and "sessions"."platform_agent_id" is null)
      ))
);
--> statement-breakpoint
CREATE TABLE "usage_ledger" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"ark_session_id" text NOT NULL,
	"ark_event_id" text NOT NULL,
	"metric_type" "usage_metric_type" NOT NULL,
	"quantity" bigint NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_ledger_quantity_check" CHECK ("usage_ledger"."quantity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "user_default_agents" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"platform_agent_id" uuid NOT NULL,
	"assigned_by" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_quota_overrides" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"personal_agent_limit" integer,
	"concurrent_session_limit" integer,
	"daily_session_limit" integer,
	"monthly_token_limit" bigint,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_quota_overrides_nonnegative_check" CHECK (coalesce("user_quota_overrides"."personal_agent_limit", 0) >= 0
          and coalesce("user_quota_overrides"."concurrent_session_limit", 0) >= 0
          and coalesce("user_quota_overrides"."daily_session_limit", 0) >= 0
          and coalesce("user_quota_overrides"."monthly_token_limit", 0) >= 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"auth_subject" text NOT NULL,
	"email" text NOT NULL,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_auth_subject_unique" UNIQUE("auth_subject")
);
--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_session_owner_fk" FOREIGN KEY ("owner_user_id","session_id") REFERENCES "public"."sessions"("owner_user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "background_jobs" ADD CONSTRAINT "background_jobs_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_agents" ADD CONSTRAINT "personal_agents_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_agents" ADD CONSTRAINT "platform_agents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_agents" ADD CONSTRAINT "platform_agents_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_reservations" ADD CONSTRAINT "quota_reservations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_event_cursors" ADD CONSTRAINT "session_event_cursors_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_inputs" ADD CONSTRAINT "session_inputs_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_inputs" ADD CONSTRAINT "session_inputs_session_owner_fk" FOREIGN KEY ("owner_user_id","session_id") REFERENCES "public"."sessions"("owner_user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_platform_agent_id_platform_agents_id_fk" FOREIGN KEY ("platform_agent_id") REFERENCES "public"."platform_agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_personal_agent_owner_fk" FOREIGN KEY ("owner_user_id","personal_agent_id") REFERENCES "public"."personal_agents"("owner_user_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_default_agents" ADD CONSTRAINT "user_default_agents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_default_agents" ADD CONSTRAINT "user_default_agents_platform_agent_id_platform_agents_id_fk" FOREIGN KEY ("platform_agent_id") REFERENCES "public"."platform_agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_default_agents" ADD CONSTRAINT "user_default_agents_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_quota_overrides" ADD CONSTRAINT "user_quota_overrides_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_quota_overrides" ADD CONSTRAINT "user_quota_overrides_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_session_ark_file_id_unique" ON "artifacts" USING btree ("session_id","ark_file_id");--> statement-breakpoint
CREATE INDEX "artifacts_owner_session_idx" ON "artifacts" USING btree ("owner_user_id","session_id");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_created_idx" ON "audit_logs" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_request_id_idx" ON "audit_logs" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_user_id_idx" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_expires_at_idx" ON "auth_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "background_jobs_claim_idx" ON "background_jobs" USING btree ("status","run_after","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "personal_agents_owner_ark_agent_id_unique" ON "personal_agents" USING btree ("owner_user_id","ark_agent_id");--> statement-breakpoint
CREATE INDEX "personal_agents_owner_status_idx" ON "personal_agents" USING btree ("owner_user_id","status");--> statement-breakpoint
CREATE INDEX "platform_agents_status_idx" ON "platform_agents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "quota_reservations_active_idx" ON "quota_reservations" USING btree ("user_id","status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "session_inputs_owner_ark_file_id_unique" ON "session_inputs" USING btree ("owner_user_id","ark_file_id");--> statement-breakpoint
CREATE INDEX "session_inputs_owner_session_idx" ON "session_inputs" USING btree ("owner_user_id","session_id");--> statement-breakpoint
CREATE INDEX "session_inputs_cleanup_idx" ON "session_inputs" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "sessions_owner_archived_idx" ON "sessions" USING btree ("owner_user_id","archived_at");--> statement-breakpoint
CREATE INDEX "sessions_owner_status_idx" ON "sessions" USING btree ("owner_user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_ledger_event_metric_unique" ON "usage_ledger" USING btree ("user_id","ark_session_id","ark_event_id","metric_type");--> statement-breakpoint
CREATE INDEX "usage_ledger_user_recorded_idx" ON "usage_ledger" USING btree ("user_id","recorded_at");--> statement-breakpoint
CREATE INDEX "users_email_idx" ON "users" USING btree ("email");
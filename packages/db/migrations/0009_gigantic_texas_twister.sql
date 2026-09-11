CREATE TABLE "quota_interrupt_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"month_start" timestamp with time zone NOT NULL,
	"status" "background_job_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 10 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quota_interrupt_jobs_attempts_check" CHECK ("quota_interrupt_jobs"."attempts" >= 0 and "quota_interrupt_jobs"."max_attempts" > 0)
);
--> statement-breakpoint
ALTER TABLE "quota_interrupt_jobs" ADD CONSTRAINT "quota_interrupt_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_interrupt_jobs" ADD CONSTRAINT "quota_interrupt_jobs_session_owner_fk" FOREIGN KEY ("user_id","session_id") REFERENCES "public"."sessions"("owner_user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "quota_interrupt_jobs_user_session_month_unique" ON "quota_interrupt_jobs" USING btree ("user_id","session_id","month_start");--> statement-breakpoint
CREATE INDEX "quota_interrupt_jobs_claim_idx" ON "quota_interrupt_jobs" USING btree ("status","run_after");
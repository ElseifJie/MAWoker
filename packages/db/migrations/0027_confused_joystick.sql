CREATE TABLE "message_submissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"content" text,
	"temporary" boolean DEFAULT false NOT NULL,
	"sequence" bigserial NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"upstream_event_id" text,
	"last_error_code" text,
	"lease_generation" integer DEFAULT 0 NOT NULL,
	"retain_until" timestamp with time zone DEFAULT now() + interval '7 days' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_submissions_owner_submission_key" UNIQUE("owner_user_id","submission_id"),
	CONSTRAINT "message_submissions_status_check" CHECK ("message_submissions"."status" in ('queued','sending','accepted','failed','unknown'))
);
--> statement-breakpoint
ALTER TABLE "message_submissions" ADD CONSTRAINT "message_submissions_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_submissions" ADD CONSTRAINT "message_submissions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_submissions_session_sequence_idx" ON "message_submissions" USING btree ("session_id","sequence");
CREATE TABLE "session_turns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"boundary_event_id" text NOT NULL,
	"input_event_id" text NOT NULL,
	"outcome" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"expected_names" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"artifact_state" text DEFAULT 'pending' NOT NULL,
	"artifact_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"usage_state" text DEFAULT 'pending' NOT NULL,
	"error_code" text,
	"retry_until" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_turns_boundary_key" UNIQUE("owner_user_id","session_id","boundary_event_id"),
	CONSTRAINT "session_turns_owner_id_key" UNIQUE("owner_user_id","session_id","id"),
	CONSTRAINT "session_turns_outcome_check" CHECK ("session_turns"."outcome" in ('completed','waiting','failed','confirming')),
	CONSTRAINT "session_turns_artifact_state_check" CHECK ("session_turns"."artifact_state" in ('none','pending','syncing','synced','failed')),
	CONSTRAINT "session_turns_usage_state_check" CHECK ("session_turns"."usage_state" in ('pending','complete'))
);
--> statement-breakpoint
CREATE TABLE "user_notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"turn_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_notifications_round_kind_key" UNIQUE("owner_user_id","session_id","turn_id","kind"),
	CONSTRAINT "user_notifications_kind_check" CHECK ("user_notifications"."kind" in ('completed','failed','needs_action','sync_failed'))
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "delivery_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session_turns" ADD CONSTRAINT "session_turns_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_turns" ADD CONSTRAINT "session_turns_owner_session_fk" FOREIGN KEY ("owner_user_id","session_id") REFERENCES "public"."sessions"("owner_user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_notifications" ADD CONSTRAINT "user_notifications_owned_turn_fk" FOREIGN KEY ("owner_user_id","session_id","turn_id") REFERENCES "public"."session_turns"("owner_user_id","session_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_turns_owner_session_ended_idx" ON "session_turns" USING btree ("owner_user_id","session_id","ended_at");--> statement-breakpoint
CREATE INDEX "user_notifications_owner_created_idx" ON "user_notifications" USING btree ("owner_user_id","created_at");
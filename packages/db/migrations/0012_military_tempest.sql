CREATE TABLE "session_events" (
	"session_id" uuid NOT NULL,
	"event_id" text NOT NULL,
	"source_type" text NOT NULL,
	"type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "session_events_session_id_event_id_pk" PRIMARY KEY("session_id","event_id")
);
--> statement-breakpoint
ALTER TABLE "session_event_cursors" ADD COLUMN "history_backfilled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "pinned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_events_session_occurred_idx" ON "session_events" USING btree ("session_id","occurred_at","event_id");
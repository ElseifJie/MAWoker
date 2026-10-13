ALTER TABLE "session_event_cursors" ADD COLUMN "history_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session_event_cursors" ADD COLUMN "history_next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session_event_cursors" ADD COLUMN "history_failure_count" integer DEFAULT 0 NOT NULL;
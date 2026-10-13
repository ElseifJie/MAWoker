ALTER TABLE "session_event_cursors" ADD COLUMN "history_scan_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "session_event_cursors" ADD COLUMN "history_repair_required" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "session_event_cursors" ADD COLUMN "history_scanned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session_event_cursors" ADD COLUMN "persisted_sequence" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "session_events" ADD COLUMN "local_sequence" bigserial NOT NULL;--> statement-breakpoint
ALTER TABLE "session_events" ADD COLUMN "history_position" bigint;--> statement-breakpoint
CREATE UNIQUE INDEX "session_events_session_sequence_idx" ON "session_events" USING btree ("session_id","local_sequence");
--> statement-breakpoint
INSERT INTO "session_event_cursors" ("session_id", "persisted_sequence")
SELECT "session_id", max("local_sequence") FROM "session_events" GROUP BY "session_id"
ON CONFLICT ("session_id") DO UPDATE SET "persisted_sequence" = excluded."persisted_sequence";

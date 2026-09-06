ALTER TABLE "sessions" ADD COLUMN "message_in_flight_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "message_start_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_message_in_flight_nonnegative_check" CHECK ("sessions"."message_in_flight_count" >= 0);
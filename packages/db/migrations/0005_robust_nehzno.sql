ALTER TABLE "sessions" ADD COLUMN "last_error_code" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "error_recoverable" boolean;
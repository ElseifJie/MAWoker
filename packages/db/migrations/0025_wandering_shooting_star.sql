ALTER TABLE "auth_sessions" ADD COLUMN "issued_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "auth_epoch" integer DEFAULT 0 NOT NULL;
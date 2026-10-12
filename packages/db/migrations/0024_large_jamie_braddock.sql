CREATE TYPE "public"."settlement_state" AS ENUM('pending', 'confirmed', 'unknown');--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "settlement_state" "settlement_state" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "settlement_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "settlement_evidence" jsonb;
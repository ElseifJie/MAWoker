ALTER TYPE "public"."automation_kind" ADD VALUE 'execute';--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "prompt" text;
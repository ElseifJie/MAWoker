CREATE TYPE "public"."quota_mode" AS ENUM('enforced', 'unlimited');--> statement-breakpoint
ALTER TABLE "quota_policies" ADD COLUMN "mode" "quota_mode" DEFAULT 'enforced' NOT NULL;--> statement-breakpoint
ALTER TABLE "quota_policies" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
UPDATE "quota_policies" SET "mode" = 'unlimited' WHERE "key" = 'default';
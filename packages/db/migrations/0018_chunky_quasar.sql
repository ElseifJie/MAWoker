ALTER TYPE "public"."session_status" ADD VALUE 'initializing';--> statement-breakpoint
ALTER TYPE "public"."session_status" ADD VALUE 'upgrading';--> statement-breakpoint
ALTER TYPE "public"."session_status" ADD VALUE 'failed';
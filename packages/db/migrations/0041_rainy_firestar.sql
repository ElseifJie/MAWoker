CREATE TYPE "public"."notification_channel_type" AS ENUM('webhook');--> statement-breakpoint
CREATE TABLE "notification_channels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" "notification_channel_type" DEFAULT 'webhook' NOT NULL,
	"url" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_channels_owner_name_unique" UNIQUE("owner_user_id","name")
);
--> statement-breakpoint
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_channels_owner_enabled_idx" ON "notification_channels" USING btree ("owner_user_id","enabled");
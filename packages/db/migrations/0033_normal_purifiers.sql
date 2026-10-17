CREATE TABLE "account_changes" (
	"owner_user_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"revision" integer,
	"deleted" boolean DEFAULT false NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_changes_owner_user_id_seq_pk" PRIMARY KEY("owner_user_id","seq")
);
--> statement-breakpoint
CREATE TABLE "sync_counters" (
	"owner_user_id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_changes" ADD CONSTRAINT "account_changes_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_counters" ADD CONSTRAINT "sync_counters_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_changes_owner_changed_idx" ON "account_changes" USING btree ("owner_user_id","changed_at");--> statement-breakpoint
CREATE INDEX "account_changes_owner_resource_idx" ON "account_changes" USING btree ("owner_user_id","resource_type","resource_id");
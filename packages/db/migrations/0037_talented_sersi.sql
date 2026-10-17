CREATE TABLE "invite_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"email" text NOT NULL,
	"created_by" uuid NOT NULL,
	"used_by_user_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invite_codes_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_used_by_user_id_users_id_fk" FOREIGN KEY ("used_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invite_codes_email_idx" ON "invite_codes" USING btree ("email");--> statement-breakpoint
CREATE INDEX "invite_codes_expires_idx" ON "invite_codes" USING btree ("expires_at");
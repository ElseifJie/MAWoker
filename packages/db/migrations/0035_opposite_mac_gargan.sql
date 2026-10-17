CREATE TABLE "session_event_consumers" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"consumer_id" text NOT NULL,
	"lease_until" timestamp with time zone NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"last_event_id" text,
	"last_consumed_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_event_consumers" ADD CONSTRAINT "session_event_consumers_owner_session_fk" FOREIGN KEY ("owner_user_id","session_id") REFERENCES "public"."sessions"("owner_user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_event_consumers_lease_idx" ON "session_event_consumers" USING btree ("lease_until");
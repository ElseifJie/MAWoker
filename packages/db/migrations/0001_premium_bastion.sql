ALTER TABLE "sessions" ADD CONSTRAINT "sessions_owner_ark_session_id_unique" UNIQUE("owner_user_id","ark_session_id");--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_session_owner_fk" FOREIGN KEY ("user_id","ark_session_id") REFERENCES "public"."sessions"("owner_user_id","ark_session_id") ON DELETE cascade ON UPDATE no action;

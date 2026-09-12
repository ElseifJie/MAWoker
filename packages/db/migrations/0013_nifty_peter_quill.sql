ALTER TABLE "quota_policies" ADD COLUMN "updated_by" uuid;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD COLUMN "agent_kind" "agent_kind";--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD COLUMN "platform_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD COLUMN "personal_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD COLUMN "model_id" text;--> statement-breakpoint
ALTER TABLE "quota_policies" ADD CONSTRAINT "quota_policies_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_owner_created_idx" ON "audit_logs" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_resource_created_idx" ON "audit_logs" USING btree ("resource_type","resource_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_action_created_idx" ON "audit_logs" USING btree ("action","created_at");--> statement-breakpoint
CREATE INDEX "usage_ledger_recorded_idx" ON "usage_ledger" USING btree ("recorded_at");--> statement-breakpoint
CREATE INDEX "usage_ledger_platform_agent_recorded_idx" ON "usage_ledger" USING btree ("platform_agent_id","recorded_at");--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_agent_attribution_check" CHECK ((
        "usage_ledger"."agent_kind" is null
        or ("usage_ledger"."agent_kind" = 'platform' and "usage_ledger"."platform_agent_id" is not null and "usage_ledger"."personal_agent_id" is null)
        or ("usage_ledger"."agent_kind" = 'personal' and "usage_ledger"."personal_agent_id" is not null and "usage_ledger"."platform_agent_id" is null)
      ));--> statement-breakpoint
-- Backfill attribution for ledger rows recorded before the columns existed.
-- Agent references are exact via the session join; model attribution uses the
-- Agent's current configuration and is therefore approximate for history.
UPDATE "usage_ledger" ul
   SET "agent_kind" = s.agent_kind,
       "platform_agent_id" = s.platform_agent_id,
       "personal_agent_id" = s.personal_agent_id,
       "model_id" = coalesce(pa.model_id, pr.model_id)
  FROM "sessions" s
  LEFT JOIN "platform_agents" pa ON pa.id = s.platform_agent_id
  LEFT JOIN "personal_agents" pr ON pr.id = s.personal_agent_id
 WHERE ul."ark_session_id" = s."ark_session_id"
   AND ul."user_id" = s."owner_user_id"
   AND ul."agent_kind" IS NULL;

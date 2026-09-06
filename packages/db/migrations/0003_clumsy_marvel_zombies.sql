ALTER TABLE "sessions" ADD COLUMN "agent_name" text;--> statement-breakpoint
UPDATE "sessions" AS "session"
SET "agent_name" = CASE
	WHEN "session"."agent_kind" = 'platform' THEN (
		SELECT "agent"."name"
		FROM "platform_agents" AS "agent"
		WHERE "agent"."id" = "session"."platform_agent_id"
	)
	ELSE (
		SELECT "agent"."name"
		FROM "personal_agents" AS "agent"
		WHERE "agent"."id" = "session"."personal_agent_id"
		  AND "agent"."owner_user_id" = "session"."owner_user_id"
	)
END;--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "agent_name" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "agent_name" SET NOT NULL;

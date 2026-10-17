CREATE TABLE "assistant_profiles" (
	"owner_user_id" uuid PRIMARY KEY NOT NULL,
	"default_agent_id" uuid,
	"display_name" text DEFAULT '' NOT NULL,
	"persona" text DEFAULT '' NOT NULL,
	"preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assistant_profiles" ADD CONSTRAINT "assistant_profiles_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_profiles" ADD CONSTRAINT "assistant_profiles_default_agent_id_personal_agents_id_fk" FOREIGN KEY ("default_agent_id") REFERENCES "public"."personal_agents"("id") ON DELETE set null ON UPDATE no action;
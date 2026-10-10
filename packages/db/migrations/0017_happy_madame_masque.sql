CREATE TABLE "user_memory_stores" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"fixed_store_id" text,
	"state" jsonb NOT NULL,
	"revision" integer NOT NULL,
	CONSTRAINT "user_memory_stores_fixed_store_id_unique" UNIQUE("fixed_store_id")
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "memory_store_id" text;--> statement-breakpoint
ALTER TABLE "user_memory_stores" ADD CONSTRAINT "user_memory_stores_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
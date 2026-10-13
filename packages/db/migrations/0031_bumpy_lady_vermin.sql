ALTER TABLE "session_inputs" ADD COLUMN "reused_object_key" text;--> statement-breakpoint
CREATE INDEX "session_inputs_drive_reference_idx" ON "session_inputs" USING btree ("drive_file_id");--> statement-breakpoint
CREATE INDEX "session_inputs_reused_object_idx" ON "session_inputs" USING btree ("reused_object_key");
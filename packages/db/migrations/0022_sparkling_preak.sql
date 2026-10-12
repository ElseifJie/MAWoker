CREATE TEMPORARY TABLE "t03a_usage_ledger_invariant" ON COMMIT DROP AS
SELECT count(*)::bigint AS "row_count",
       coalesce(sum("quantity") FILTER (WHERE "metric_type" = 'input_tokens'), 0)::bigint AS "input_tokens",
       coalesce(sum("quantity") FILTER (WHERE "metric_type" = 'output_tokens'), 0)::bigint AS "output_tokens",
       coalesce(sum("quantity") FILTER (WHERE "metric_type" = 'runtime_ms'), 0)::bigint AS "runtime_ms",
       coalesce(sum("quantity") FILTER (WHERE "metric_type" = 'tool_calls'), 0)::bigint AS "tool_calls"
FROM "usage_ledger";--> statement-breakpoint
ALTER TABLE "quota_reservations" ADD COLUMN "ark_session_id" text;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "quota_reservations" reservation
    JOIN "sessions" session ON session."id" = reservation."id"
    WHERE session."owner_user_id" <> reservation."user_id"
  ) THEN
    RAISE EXCEPTION 'T03-A migration: reservation/session owner mismatch';
  END IF;
END
$$;--> statement-breakpoint
UPDATE "quota_reservations" reservation
SET "ark_session_id" = coalesce(
  session."ark_session_id",
  'pending:' || reservation."id"::text
)
FROM (
  SELECT reservation_id."id", session_row."ark_session_id"
  FROM "quota_reservations" reservation_id
  LEFT JOIN "sessions" session_row
    ON session_row."id" = reservation_id."id"
   AND session_row."owner_user_id" = reservation_id."user_id"
) session
WHERE session."id" = reservation."id";--> statement-breakpoint
CREATE TYPE "public"."quota_reservation_status_v2" AS ENUM(
  'active',
  'unknown_outcome',
  'consumed',
  'released'
);--> statement-breakpoint
ALTER TABLE "quota_reservations"
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE "public"."quota_reservation_status_v2"
    USING "status"::text::"public"."quota_reservation_status_v2";--> statement-breakpoint
DROP TYPE "public"."quota_reservation_status";--> statement-breakpoint
ALTER TYPE "public"."quota_reservation_status_v2"
  RENAME TO "quota_reservation_status";--> statement-breakpoint
ALTER TABLE "quota_reservations"
  ALTER COLUMN "status" SET DEFAULT 'active';--> statement-breakpoint
INSERT INTO "quota_reservations"
  ("id", "user_id", "ark_session_id", "status", "expires_at", "created_at", "resolved_at")
SELECT session."id",
       session."owner_user_id",
       session."ark_session_id",
       CASE
         WHEN session."ark_session_id" LIKE 'pending:%'
           THEN 'unknown_outcome'::"quota_reservation_status"
         ELSE 'consumed'::"quota_reservation_status"
       END,
       session."created_at" + interval '5 minutes',
       session."created_at",
       CASE
         WHEN session."ark_session_id" LIKE 'pending:%' THEN NULL
         ELSE session."created_at"
       END
FROM "sessions" session
WHERE NOT EXISTS (
  SELECT 1
  FROM "quota_reservations" reservation
  WHERE reservation."id" = session."id"
);--> statement-breakpoint
UPDATE "quota_reservations"
SET "status" = 'unknown_outcome',
    "resolved_at" = NULL
WHERE "ark_session_id" LIKE 'pending:%'
  AND "status" IN ('active', 'consumed');--> statement-breakpoint
UPDATE "quota_reservations"
SET "status" = 'unknown_outcome',
    "resolved_at" = NULL
WHERE "status" = 'active'
  AND "expires_at" <= now();--> statement-breakpoint
UPDATE "quota_reservations" reservation
SET "status" = 'consumed',
    "resolved_at" = coalesce(reservation."resolved_at", session."created_at")
FROM "sessions" session
WHERE session."id" = reservation."id"
  AND session."owner_user_id" = reservation."user_id"
  AND session."ark_session_id" = reservation."ark_session_id"
  AND session."ark_session_id" NOT LIKE 'pending:%'
  AND reservation."status" IN ('active', 'unknown_outcome');--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "quota_reservations"
    GROUP BY "user_id", "ark_session_id"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'T03-A migration: duplicate reservation owner/Ark identity';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "usage_ledger" ledger
    LEFT JOIN "quota_reservations" reservation
      ON reservation."user_id" = ledger."user_id"
     AND reservation."ark_session_id" = ledger."ark_session_id"
    WHERE reservation."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'T03-A migration: ledger row has no reservation owner anchor';
  END IF;
END
$$;--> statement-breakpoint
ALTER TABLE "quota_reservations"
  ALTER COLUMN "ark_session_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "quota_reservations"
  ADD CONSTRAINT "quota_reservations_consumed_ark_identity_check"
  CHECK (
    "status" <> 'consumed'
    OR (
      length("ark_session_id") > 0
      AND "ark_session_id" = btrim(
        "ark_session_id",
        concat(
          chr(9), chr(10), chr(11), chr(12), chr(13), chr(32),
          chr(160), chr(5760),
          chr(8192), chr(8193), chr(8194), chr(8195), chr(8196),
          chr(8197), chr(8198), chr(8199), chr(8200), chr(8201),
          chr(8202), chr(8232), chr(8233), chr(8239), chr(8287),
          chr(12288), chr(65279)
        )
      )
      AND "ark_session_id" NOT LIKE 'pending:%'
    )
  );--> statement-breakpoint
ALTER TABLE "quota_reservations"
  ADD CONSTRAINT "quota_reservations_user_ark_session_unique"
  UNIQUE("user_id", "ark_session_id");--> statement-breakpoint
ALTER TABLE "usage_ledger"
  DROP CONSTRAINT "usage_ledger_session_owner_fk";--> statement-breakpoint
ALTER TABLE "usage_ledger"
  ADD CONSTRAINT "usage_ledger_reservation_owner_fk"
  FOREIGN KEY ("user_id", "ark_session_id")
  REFERENCES "public"."quota_reservations"("user_id", "ark_session_id")
  ON DELETE NO ACTION
  ON UPDATE CASCADE;--> statement-breakpoint
CREATE INDEX "quota_reservations_user_created_counted_idx"
  ON "quota_reservations" USING btree ("user_id", "created_at")
  WHERE "status" IN ('active', 'unknown_outcome', 'consumed');--> statement-breakpoint
DO $$
DECLARE
  before_row "t03a_usage_ledger_invariant"%ROWTYPE;
  after_row "t03a_usage_ledger_invariant"%ROWTYPE;
BEGIN
  SELECT * INTO before_row FROM "t03a_usage_ledger_invariant";
  SELECT count(*)::bigint,
         coalesce(sum("quantity") FILTER (WHERE "metric_type" = 'input_tokens'), 0)::bigint,
         coalesce(sum("quantity") FILTER (WHERE "metric_type" = 'output_tokens'), 0)::bigint,
         coalesce(sum("quantity") FILTER (WHERE "metric_type" = 'runtime_ms'), 0)::bigint,
         coalesce(sum("quantity") FILTER (WHERE "metric_type" = 'tool_calls'), 0)::bigint
  INTO after_row
  FROM "usage_ledger";

  IF before_row IS DISTINCT FROM after_row THEN
    RAISE EXCEPTION 'T03-A migration: usage ledger invariant changed';
  END IF;
END
$$;

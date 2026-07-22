-- Complete the breaking run-role rename before new runtime code reads history.
UPDATE "runs" SET "role" = 'steer' WHERE "role" = 'edit';--> statement-breakpoint
UPDATE "run_leases" SET "role" = 'steer' WHERE "role" = 'edit';--> statement-breakpoint
UPDATE "loops"
SET "pause_cause" = jsonb_set("pause_cause", '{role}', '"steer"'::jsonb)
WHERE "pause_cause"->>'role' = 'edit';--> statement-breakpoint
ALTER TABLE "loops" ADD COLUMN "last_run_index" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "run_index" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "reasoning_effort" text;--> statement-breakpoint
-- Terminal rows are durable history. Number them by terminal timestamp + id;
-- an in-flight row follows all terminal evidence so it keeps the next number.
WITH ranked AS (
  SELECT "id", row_number() OVER (
    PARTITION BY "loop_id"
    ORDER BY CASE WHEN "phase" IN ('done', 'error', 'canceled') THEN 0 ELSE 1 END,
             "ts", "id"
  )::integer AS "run_index"
  FROM "runs"
  WHERE "phase" IN ('done', 'error', 'canceled', 'running')
)
UPDATE "runs" AS r
SET "run_index" = ranked."run_index"
FROM ranked
WHERE r."id" = ranked."id";--> statement-breakpoint
-- A currently running row was claimed before these snapshot columns existed.
-- Its loop settings are the closest durable execution profile; completed legacy
-- rows stay unknown rather than pretending today's config was historical config.
UPDATE "runs" AS r
SET "model" = l."model", "reasoning_effort" = l."reasoning_effort"
FROM "loops" AS l
WHERE r."loop_id" = l."id" AND r."phase" = 'running';--> statement-breakpoint
UPDATE "loops" AS l
SET "last_run_index" = history."last_run_index"
FROM (
  SELECT "loop_id", max("run_index")::integer AS "last_run_index"
  FROM "runs"
  WHERE "run_index" IS NOT NULL
  GROUP BY "loop_id"
) AS history
WHERE l."id" = history."loop_id";--> statement-breakpoint
CREATE UNIQUE INDEX "runs_loop_run_index_idx" ON "runs" USING btree ("loop_id","run_index") WHERE "run_index" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "runs_loop_terminal_history_idx" ON "runs" USING btree ("loop_id","run_index") WHERE "run_index" IS NOT NULL AND "phase" IN ('done', 'error', 'canceled');

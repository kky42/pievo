ALTER TABLE "loops" ADD COLUMN "schedule_mode" text DEFAULT 'cron' NOT NULL;--> statement-breakpoint
ALTER TABLE "loops" ADD COLUMN "continuous_delay_minutes" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "loops" ADD COLUMN "next_cadence_at" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "requested_by" text DEFAULT 'system' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "request_text" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "created_at" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "updated_at" text;--> statement-breakpoint
-- Runs previously had one mutable timestamp. Preserve it as the immutable age
-- anchor and mutation stamp so existing history remains ordered and pending-row
-- retention never depends on a coalescing refresh.
UPDATE "runs" SET "created_at" = "ts", "updated_at" = "ts";--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "created_at" SET DEFAULT CURRENT_TIMESTAMP::text;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "updated_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP::text;--> statement-breakpoint
-- Convert the two legacy loop markers exactly once. An already-open role owns the
-- marker conservatively; otherwise persist one queue row before clearing the
-- marker. Every legacy edit is owner authority.
UPDATE "runs" SET "requested_by" = 'owner' WHERE "role" = 'edit';--> statement-breakpoint
UPDATE "runs" AS r
SET "requested_by" = 'owner', "request_text" = l."edit_request", "updated_at" = l."updated_at"
FROM "loops" AS l
WHERE r."loop_id" = l."id" AND r."role" = 'edit' AND r."phase" = 'pending'
  AND l."edit_request" IS NOT NULL;--> statement-breakpoint
INSERT INTO "runs" (
  "id", "loop_id", "user_id", "machine_id", "phase", "role", "requested_by",
  "request_text", "ts", "created_at", "updated_at"
)
SELECT
  'legacy-edit-' || l."id", l."id", l."user_id", l."machine_id", 'pending', 'edit',
  'owner', l."edit_request", l."updated_at", l."updated_at", l."updated_at"
FROM "loops" AS l
WHERE l."edit_request" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "runs" AS r
    WHERE r."loop_id" = l."id" AND r."role" = 'edit' AND r."phase" IN ('pending', 'running')
  );--> statement-breakpoint
INSERT INTO "runs" (
  "id", "loop_id", "user_id", "machine_id", "phase", "role", "requested_by",
  "ts", "created_at", "updated_at"
)
SELECT
  'legacy-evolve-' || l."id", l."id", l."user_id", l."machine_id", 'pending', 'evolve',
  'system', l."updated_at", l."updated_at", l."updated_at"
FROM "loops" AS l
WHERE l."evolve_due" = true
  AND NOT EXISTS (
    SELECT 1 FROM "runs" AS r
    WHERE r."loop_id" = l."id" AND r."role" = 'evolve' AND r."phase" IN ('pending', 'running')
  );--> statement-breakpoint
-- Legacy edit/evolve markers sometimes borrowed next_run_at as their wake-up.
-- Clear only a due/past pin at migration time. Every future pin is preserved:
-- losing a genuine self-reschedule is worse than retaining an ambiguous old wake.
UPDATE "loops" AS l
SET "next_run_at" = NULL
WHERE (l."edit_request" IS NOT NULL OR l."evolve_due" = true)
  AND l."next_run_at" IS NOT NULL
  AND l."next_run_at"::timestamptz <= CURRENT_TIMESTAMP;--> statement-breakpoint
-- Retain deprecated columns/defaults to reduce old-image SELECT/INSERT breakage,
-- then clear converted values. This is not a rollback protocol: an old image that
-- writes markers after this forward-only migration is unsupported and they will
-- not be drained by the new runtime.
UPDATE "loops" SET "edit_request" = NULL, "evolve_due" = false
WHERE "edit_request" IS NOT NULL OR "evolve_due" = true;--> statement-breakpoint
-- Normalize lifecycle state before installing the queue uniqueness invariant.
UPDATE "runs" AS r
SET "phase" = 'canceled', "outcome" = 'skipped',
    "message" = 'canceled - loop completed before this queued run was claimed',
    "updated_at" = l."updated_at", "ts" = l."updated_at"
FROM "loops" AS l
WHERE r."loop_id" = l."id" AND r."phase" = 'pending'
  AND l."completed_at" IS NOT NULL
  AND (r."role" IN ('exec', 'evolve') OR (r."role" = 'edit' AND r."requested_by" = 'system'));--> statement-breakpoint
UPDATE "runs" AS r
SET "phase" = 'canceled', "outcome" = 'skipped',
    "message" = 'canceled - loop paused before this system run was claimed',
    "updated_at" = l."updated_at", "ts" = l."updated_at"
FROM "loops" AS l
WHERE r."loop_id" = l."id" AND r."phase" = 'pending'
  AND l."enabled" = false AND r."requested_by" = 'system';--> statement-breakpoint
WITH ranked AS (
  SELECT "id", row_number() OVER (
    PARTITION BY "loop_id", "role"
    ORDER BY CASE "requested_by" WHEN 'owner' THEN 0 ELSE 1 END, "updated_at" DESC, "id" DESC
  ) AS n
  FROM "runs"
  WHERE "phase" = 'pending'
)
UPDATE "runs" AS r
SET "phase" = 'canceled', "outcome" = 'skipped',
    "message" = 'canceled - coalesced during durable queue migration'
FROM ranked
WHERE r."id" = ranked."id" AND ranked.n > 1;--> statement-breakpoint
-- Auto-evolve now counts terminal exec evidence only.
UPDATE "loops" AS l
SET "evolved_run_count" = (
  SELECT count(*)::integer FROM "runs" AS r
  WHERE r."loop_id" = l."id" AND r."role" = 'exec' AND r."phase" IN ('done', 'error')
)
WHERE l."evolved_run_count" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "runs_machine_phase_ready_idx" ON "runs" USING btree ("machine_id","phase");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_loop_role_pending_idx" ON "runs" USING btree ("loop_id","role") WHERE "runs"."phase" = 'pending';

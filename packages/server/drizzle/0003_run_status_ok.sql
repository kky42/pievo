-- Run status collapses to ok|block; per-loop status definitions are dropped.
-- DATA LOSS (intentional): every loop's keep/no-change/block definition text is
-- removed, and keep/no-change history becomes ok. Legacy done runs without a
-- status become errors so that done always means a reported status.
ALTER TABLE "runs" DROP CONSTRAINT "runs_status_check";--> statement-breakpoint
UPDATE "runs" SET "status" = 'ok' WHERE "status" IN ('keep', 'no-change');--> statement-breakpoint
UPDATE "runs" SET "phase" = 'error', "error" = coalesce("error", 'run protocol incomplete: the final response has no STATUS line') WHERE "phase" = 'done' AND "status" IS NULL;--> statement-breakpoint
UPDATE "runs" SET "status" = NULL WHERE "phase" <> 'done' AND "status" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_status_check" CHECK ("runs"."status" IS NULL OR "runs"."status" IN ('ok', 'block'));--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_done_status_check" CHECK (("runs"."phase" = 'done') = ("runs"."status" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "loops" DROP COLUMN "status_keep";--> statement-breakpoint
ALTER TABLE "loops" DROP COLUMN "status_no_change";--> statement-breakpoint
ALTER TABLE "loops" DROP COLUMN "status_block";

-- Loop files replace workdir-relative artifact sync (protocol v5).
-- DATA LOSS (intentional): previously synced workdir artifacts, their per-run
-- snapshots, and every loop's configured artifact paths are dropped. Old paths
-- are not valid loop file names; orphaned blob bytes are reclaimed by the next
-- storage-maintenance pass. Run history and loop configuration are otherwise kept.
DELETE FROM "artifact_files";--> statement-breakpoint
DELETE FROM "run_snapshots";--> statement-breakpoint
UPDATE "loops" SET "artifacts" = '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "file_notices" jsonb;

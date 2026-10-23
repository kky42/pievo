-- Loops keep no artifacts: memory moves into loops.memory and run history is the
-- only result record. `carryLegacyMemory` (db/index.ts) copied each loop's
-- MEMORY.md bytes into loops.memory before this migration ran.
-- DATA LOSS (intentional): every artifact file, run snapshot, and blob row is
-- dropped; the server deletes the `blobs/` byte directory after migrating. Old
-- loop-file notices are cleared because the next prompt would echo artifact names.
ALTER TABLE "loops" ADD COLUMN IF NOT EXISTS "memory" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "loops" DROP COLUMN "artifacts";--> statement-breakpoint
ALTER TABLE "runs" RENAME COLUMN "file_notices" TO "notices";--> statement-breakpoint
UPDATE "runs" SET "notices" = NULL;--> statement-breakpoint
ALTER TABLE "run_leases" ADD COLUMN "context_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "run_leases_context_idx" ON "run_leases" USING btree ("context_hash");--> statement-breakpoint
DROP TABLE "artifact_files";--> statement-breakpoint
DROP TABLE "run_snapshots";--> statement-breakpoint
DROP TABLE "blobs";

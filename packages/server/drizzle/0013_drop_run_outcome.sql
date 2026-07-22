-- Breaking change: run display/result is derived from role + phase + status.
ALTER TABLE "runs" DROP COLUMN IF EXISTS "outcome";

-- A terminal run can never retain active machine authority. Give any legacy or
-- crash-window row the same short enrichment window as a freshly-finished run.
UPDATE "run_leases"
SET "state" = 'terminal-grace',
    "expires_at" = to_char((CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + interval '10 minutes', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
WHERE "state" = 'active'
  AND EXISTS (
    SELECT 1 FROM "runs"
    WHERE "runs"."id" = "run_leases"."run_id"
      AND "runs"."phase" IN ('done', 'error', 'canceled')
  );
--> statement-breakpoint
-- Retired rows are durable non-authorizing tombstones. Their only deletion path
-- is the transaction that commits a matching 410 report receipt.
UPDATE "run_leases" SET "expires_at" = NULL WHERE "state" = 'retired';

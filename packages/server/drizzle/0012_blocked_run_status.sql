-- Redesign run status as the agent's business result across exec/edit/evolve.
-- The column is plain text (Drizzle enum is TS-only), so this is a data migration
-- for existing history rather than a DDL constraint change.
UPDATE "runs"
SET "status" = CASE "status"
  WHEN 'new' THEN 'kept'
  WHEN 'resolved' THEN 'kept'
  WHEN 'nothing-new' THEN 'no-change'
  ELSE NULL
END
WHERE "status" IS NOT NULL
  AND "status" NOT IN ('kept', 'no-change', 'blocked');

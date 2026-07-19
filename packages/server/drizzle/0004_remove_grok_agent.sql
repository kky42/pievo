-- Grok CLI execution support was removed. Existing loops must remain runnable,
-- so move the retired agent value to the default supported executor.
UPDATE "loops"
SET "agent" = 'claude-code', "model" = NULL
WHERE "agent" = 'grok';

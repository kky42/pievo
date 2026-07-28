ALTER TABLE "loops" DROP CONSTRAINT "loops_agent_check";
--> statement-breakpoint
ALTER TABLE "loops" ADD CONSTRAINT "loops_agent_check"
  CHECK ("agent" IN ('claude-code', 'codex', 'pi'));
--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "runs_agent_check";
--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_agent_check"
  CHECK ("agent" IS NULL OR "agent" IN ('claude-code', 'codex', 'pi'));

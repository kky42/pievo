-- Execution serialization belongs to a loop, not to its machine. Existing data
-- satisfies the new invariant because the old machine-wide index was stronger.
DROP INDEX "one_running_run_per_machine";--> statement-breakpoint
CREATE UNIQUE INDEX "one_running_run_per_loop" ON "runs" USING btree ("loop_id") WHERE "runs"."phase" = 'running';

ALTER TABLE "loops" RENAME COLUMN "state_schema" TO "metric_schema";--> statement-breakpoint
ALTER TABLE "runs" RENAME COLUMN "state" TO "metrics";--> statement-breakpoint
ALTER TABLE "loops" DROP COLUMN "completed_at";--> statement-breakpoint
ALTER TABLE "loops" DROP COLUMN "completion_reason";--> statement-breakpoint
ALTER TABLE "run_leases" DROP COLUMN "can_finish";

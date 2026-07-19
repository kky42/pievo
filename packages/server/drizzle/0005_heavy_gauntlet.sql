ALTER TABLE "runs" ADD COLUMN "exit_code" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "final_text" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "heartbeat_at" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "deferred_at" text;--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "cost_usd";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "artifacts";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "transcript";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "progress";
CREATE TABLE "terminal_report_incidents" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"report_id" text NOT NULL,
	"payload_digest" text NOT NULL,
	"disposition" text NOT NULL,
	"ack_body" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "loops" ADD COLUMN "pause_cause" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "report_incident" jsonb;--> statement-breakpoint
CREATE INDEX "terminal_report_incidents_report_id" ON "terminal_report_incidents" USING btree ("report_id");--> statement-breakpoint
CREATE INDEX "terminal_report_incidents_created" ON "terminal_report_incidents" USING btree ("created_at");
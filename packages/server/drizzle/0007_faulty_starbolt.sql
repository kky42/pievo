CREATE TABLE "run_report_receipts" (
	"report_id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"payload_digest" text NOT NULL,
	"ack_status" integer NOT NULL,
	"ack_body" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "loops" ADD COLUMN "delete_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "daemon_protocol" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "cancel_requested_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "report_receipts_created" ON "run_report_receipts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "delete_requested_loops" ON "loops" USING btree ("delete_requested_at") WHERE "loops"."delete_requested_at" IS NOT NULL;--> statement-breakpoint
-- Pre-v2 servers could run one row per loop on the same machine. Conservatively
-- terminalize every extra row before installing the machine-wide invariant; its
-- lease remains in grace, so a late real report can still reconcile it and the
-- machine stays blocked rather than multiplying uncertain execution.
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY machine_id ORDER BY ts, id) AS n
  FROM runs WHERE phase = 'running'
), extras AS (
  UPDATE runs SET phase = 'error', outcome = 'error', error = 'protocol v2 migration: overlapping machine run', updated_at = CURRENT_TIMESTAMP::text
  WHERE id IN (SELECT id FROM ranked WHERE n > 1)
  RETURNING id
)
UPDATE run_leases SET state = 'terminal-grace', expires_at = to_char(CURRENT_TIMESTAMP + interval '24 hours', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
WHERE run_id IN (SELECT id FROM extras) AND state = 'active';
--> statement-breakpoint
CREATE UNIQUE INDEX "one_running_run_per_machine" ON "runs" USING btree ("machine_id") WHERE "runs"."phase" = 'running';
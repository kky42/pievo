CREATE TABLE "artifact_files" (
	"id" text PRIMARY KEY NOT NULL,
	"loop_id" text NOT NULL,
	"path" text NOT NULL,
	"hash" text,
	"size" integer,
	"binary" boolean DEFAULT false NOT NULL,
	"oversize" boolean DEFAULT false NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blobs" (
	"hash" text PRIMARY KEY NOT NULL,
	"size" integer NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connect_keys" (
	"machine_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"team_id" text NOT NULL,
	"minted_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loops" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"team_id" text NOT NULL,
	"machine_id" text NOT NULL,
	"name" text NOT NULL,
	"prompt" text NOT NULL,
	"status_keep" text NOT NULL,
	"status_no_change" text NOT NULL,
	"status_block" text NOT NULL,
	"artifacts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cron" text NOT NULL,
	"schedule_mode" text NOT NULL,
	"cron_overlap" text NOT NULL,
	"continuous_delay_minutes" integer NOT NULL,
	"timezone" text,
	"workdir" text NOT NULL,
	"delete_requested_at" timestamp with time zone,
	"pause_cause" jsonb,
	"model" text,
	"reasoning_effort" text,
	"agent" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" text,
	"next_cadence_at" text,
	"last_run_index" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "loops_agent_check" CHECK ("loops"."agent" IN ('claude-code', 'codex')),
	CONSTRAINT "loops_schedule_mode_check" CHECK ("loops"."schedule_mode" IN ('cron', 'continuous')),
	CONSTRAINT "loops_cron_overlap_check" CHECK ("loops"."cron_overlap" IN ('skip', 'queue-one'))
);
--> statement-breakpoint
CREATE TABLE "machines" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"team_id" text NOT NULL,
	"name" text NOT NULL,
	"hostname" text,
	"platform" text,
	"arch" text,
	"daemon_version" text,
	"daemon_protocol" integer,
	"token_hash" text NOT NULL,
	"token" text,
	"roots" jsonb,
	"last_seen" text,
	"online" boolean DEFAULT false NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_leases" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"loop_id" text NOT NULL,
	"machine_id" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"expires_at" text,
	"created_at" text NOT NULL,
	CONSTRAINT "run_leases_state_check" CHECK ("run_leases"."state" IN ('active', 'terminal-grace', 'reconciliation-only', 'retired'))
);
--> statement-breakpoint
CREATE TABLE "run_report_receipts" (
	"report_id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"payload_digest" text NOT NULL,
	"ack_status" integer NOT NULL,
	"ack_body" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_snapshots" (
	"run_id" text PRIMARY KEY NOT NULL,
	"loop_id" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"loop_id" text NOT NULL,
	"machine_id" text NOT NULL,
	"agent" text,
	"model" text,
	"reasoning_effort" text,
	"run_index" integer,
	"phase" text NOT NULL,
	"requested_by" text DEFAULT 'system' NOT NULL,
	"ts" text NOT NULL,
	"created_at" text DEFAULT CURRENT_TIMESTAMP::text NOT NULL,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP::text NOT NULL,
	"status" text,
	"message" text,
	"duration_ms" integer,
	"exit_code" integer,
	"final_text" text,
	"error" text,
	"session_id" text,
	"usage" jsonb,
	"cancel_requested_at" timestamp with time zone,
	"heartbeat_at" text,
	"report_incident" jsonb,
	CONSTRAINT "runs_agent_check" CHECK ("runs"."agent" IS NULL OR "runs"."agent" IN ('claude-code', 'codex')),
	CONSTRAINT "runs_phase_check" CHECK ("runs"."phase" IN ('pending', 'running', 'done', 'error', 'canceled')),
	CONSTRAINT "runs_requested_by_check" CHECK ("runs"."requested_by" IN ('owner', 'system')),
	CONSTRAINT "runs_status_check" CHECK ("runs"."status" IS NULL OR "runs"."status" IN ('keep', 'no-change', 'block'))
);
--> statement-breakpoint
CREATE TABLE "team_invites" (
	"token" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"invited_by_user_id" text NOT NULL,
	"expires_at" text NOT NULL,
	"redeemed_at" text,
	"redeemed_by_user_id" text,
	"created_at" text NOT NULL,
	CONSTRAINT "team_invites_role_check" CHECK ("team_invites"."role" IN ('owner', 'member'))
);
--> statement-breakpoint
CREATE TABLE "team_members" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "team_members_role_check" CHECK ("team_members"."role" IN ('owner', 'member'))
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"owner_user_id" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "terminal_report_incidents" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"report_id" text NOT NULL,
	"payload_digest" text NOT NULL,
	"disposition" text NOT NULL,
	"ack_body" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "terminal_report_incidents_disposition_check" CHECK ("terminal_report_incidents"."disposition" IN ('run-error', 'telemetry-rejected'))
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifact_files_loop_idx" ON "artifact_files" USING btree ("loop_id");--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_files_loop_path_idx" ON "artifact_files" USING btree ("loop_id","path");--> statement-breakpoint
CREATE INDEX "artifact_files_hash_idx" ON "artifact_files" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "loops_user_idx" ON "loops" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "loops_team_idx" ON "loops" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "loops_machine_idx" ON "loops" USING btree ("machine_id");--> statement-breakpoint
CREATE INDEX "delete_requested_loops" ON "loops" USING btree ("delete_requested_at") WHERE "loops"."delete_requested_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "machines_user_idx" ON "machines" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "machines_team_idx" ON "machines" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "run_leases_run_idx" ON "run_leases" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "run_leases_loop_idx" ON "run_leases" USING btree ("loop_id");--> statement-breakpoint
CREATE INDEX "report_receipts_created" ON "run_report_receipts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "run_snapshots_loop_idx" ON "run_snapshots" USING btree ("loop_id");--> statement-breakpoint
CREATE INDEX "runs_loop_idx" ON "runs" USING btree ("loop_id");--> statement-breakpoint
CREATE INDEX "runs_phase_idx" ON "runs" USING btree ("phase");--> statement-breakpoint
CREATE INDEX "runs_machine_phase_ready_idx" ON "runs" USING btree ("machine_id","phase");--> statement-breakpoint
CREATE INDEX "runs_loop_ts_idx" ON "runs" USING btree ("loop_id","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_loop_run_index_idx" ON "runs" USING btree ("loop_id","run_index") WHERE "runs"."run_index" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "runs_loop_terminal_history_idx" ON "runs" USING btree ("loop_id","run_index") WHERE "runs"."run_index" IS NOT NULL AND "runs"."phase" IN ('done', 'error', 'canceled');--> statement-breakpoint
CREATE UNIQUE INDEX "runs_loop_pending_idx" ON "runs" USING btree ("loop_id") WHERE "runs"."phase" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "one_running_run_per_loop" ON "runs" USING btree ("loop_id") WHERE "runs"."phase" = 'running';--> statement-breakpoint
CREATE INDEX "team_invites_team_idx" ON "team_invites" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "team_members_team_idx" ON "team_members" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "team_members_user_idx" ON "team_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "terminal_report_incidents_report_id" ON "terminal_report_incidents" USING btree ("report_id");--> statement-breakpoint
CREATE INDEX "terminal_report_incidents_created" ON "terminal_report_incidents" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");
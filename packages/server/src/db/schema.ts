/**
 * Pievo schema (Drizzle, Postgres `pg-core` dialect, served by embedded PGlite).
 * Pievo is single-user: no row carries an owner. Timestamp values are ISO
 * strings; JSON columns use `jsonb().$type<>()`.
 */
import { sql } from "drizzle-orm";
import { pgTable, text, integer, boolean, jsonb, index, uniqueIndex, timestamp, check } from "drizzle-orm/pg-core";

// The coding-agent enum and client-safe wire types live in `../types`; this
// schema only supplies the database tables and re-exports those types for
// existing server-side imports.
import { CODING_AGENTS } from "../types.js";
import type {
  PauseCause,
  ReportIncident,
  ReportIncidentDisposition,
} from "../types.js";
export type { CodingAgent, CronOverlap, LoopSchedule, RunPhase, RunStatus } from "../types.js";

export interface RunUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

/** Queue authority, not scheduling provenance. Owner intent may promote a
 * system row, and no later system event may downgrade it. */
export type RunRequester = "owner" | "system";
export const machines = pgTable(
  "machines",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    hostname: text("hostname"),
    platform: text("platform"),
    arch: text("arch"),
    daemonVersion: text("daemon_version"),
    /** Breaking machine protocol last observed on poll. */
    daemonProtocol: integer("daemon_protocol"),
    tokenHash: text("token_hash").notNull(),
    /**
     * Plaintext device token. Stored so the UI can re-show the connect command
     * anytime (MVP convenience — deviates from "store only the hash"; acceptable
     * for a self-hosted control plane where the DB is already the trust root).
     */
    token: text("token"),
    roots: jsonb("roots").$type<string[]>(),
    lastSeen: text("last_seen"),
    online: boolean("online").notNull().default(false),
    createdAt: text("created_at").notNull(),
  },
);

export const loops = pgTable(
  "loops",
  {
    id: text("id").primaryKey(),
    /** Execution machine (set at creation; no cross-machine fallback). */
    machineId: text("machine_id").notNull(),
    name: text("name").notNull(),
    tags: text("tags").array().notNull().default(sql`ARRAY[]::text[]`),
    prompt: text("prompt").notNull(),
    /** The loop's MEMORY.md: lessons runs learned the hard way. Bounded by
     *  `gateway/memory.ts`; every run reads it and may replace it. A run's
     *  replacement applies only if the memory hash it started from is current. */
    memory: text("memory").notNull().default(""),
    cron: text("cron").notNull(),
    scheduleMode: text("schedule_mode", { enum: ["cron", "continuous"] }).notNull(),
    /** Cron-only overlap behavior. Continuous runs never overlap. */
    cronOverlap: text("cron_overlap", { enum: ["skip", "queue-one"] }).notNull(),
    continuousDelayMinutes: integer("continuous_delay_minutes").notNull(),
    timezone: text("timezone"),
    workdir: text("workdir").notNull(),
    /** Durable Stop-before-delete marker. A deleting loop is never claimable. */
    deleteRequestedAt: timestamp("delete_requested_at", { withTimezone: true, mode: "string" }),
    pauseCause: jsonb("pause_cause").$type<PauseCause>(),
    model: text("model"),
    reasoningEffort: text("reasoning_effort"),
    /** The daemon launches this agent for every run (`buildAgentSpawn`). Enforced by
     *  both the TypeScript enum and a database CHECK constraint. */
    agent: text("agent", { enum: CODING_AGENTS }).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    nextRunAt: text("next_run_at"),
    /** The next recurring cadence occurrence not yet materialized as a run. Cron
     * advances this fact after each due occurrence; continuous clears it on due
     * and restores it from a successful/error terminal. */
    nextCadenceAt: text("next_cadence_at"),
    lastRunIndex: integer("last_run_index").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("loops_machine_idx").on(t.machineId),
    index("delete_requested_loops").on(t.deleteRequestedAt).where(sql`${t.deleteRequestedAt} IS NOT NULL`),
    check("loops_agent_check", sql`${t.agent} IN ('claude-code', 'codex', 'pi')`),
    check("loops_tags_count_check", sql`cardinality(${t.tags}) <= 4`),
    check("loops_tags_reserved_check", sql`NOT (${t.tags} && ARRAY['all loops', 'active', 'paused', 'blocked']::text[])`),
    check("loops_schedule_mode_check", sql`${t.scheduleMode} IN ('cron', 'continuous')`),
    check("loops_cron_overlap_check", sql`${t.cronOverlap} IN ('skip', 'queue-one')`),
  ],
);

export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    loopId: text("loop_id").notNull(),
    machineId: text("machine_id").notNull(),
    agent: text("agent", { enum: CODING_AGENTS }),
    model: text("model"),
    reasoningEffort: text("reasoning_effort"),
    runIndex: integer("run_index"),
    /** A pending run retired without executing (pause, retention cleanup, queue
     *  coalescing, or an elapsed offline catch-up window) is `canceled`, not `error`,
     *  so it never counts toward the failure streak. */
    phase: text("phase", { enum: ["pending", "running", "done", "error", "canceled"] }).notNull(),
    /** Durable queue authority. It only promotes system→owner; diagnostic trigger
     * reasons, if added later, must never drive lifecycle state. */
    requestedBy: text("requested_by", { enum: ["owner", "system"] }).notNull().default("system"),
    ts: text("ts").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP::text`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP::text`),
    status: text("status", { enum: ["ok", "block"] }),
    message: text("message"),
    /** Owner-facing reason from the final response's ATTENTION line. Independent
     *  of status: it never pauses the loop. */
    attention: text("attention"),
    durationMs: integer("duration_ms"),
    exitCode: integer("exit_code"),
    finalText: text("final_text"),
    error: text("error"),
    sessionId: text("session_id"),
    usage: jsonb("usage").$type<RunUsage>(),
    /** Monotonic cancellation intent. Running becomes canceled only on daemon report. */
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true, mode: "string" }),
    heartbeatAt: text("heartbeat_at"),
    reportIncident: jsonb("report_incident").$type<ReportIncident>(),
    /** Why this run's memory was not kept (over limit, owner edited during the
     *  run). Shown on the run and repeated in the next run's prompt. */
    notices: jsonb("notices").$type<string[]>(),
  },
  (t) => [
    index("runs_loop_idx").on(t.loopId),
    index("runs_phase_idx").on(t.phase),
    index("runs_machine_phase_ready_idx").on(t.machineId, t.phase),
    index("runs_loop_ts_idx").on(t.loopId, t.ts),
    uniqueIndex("runs_loop_run_index_idx").on(t.loopId, t.runIndex).where(sql`${t.runIndex} IS NOT NULL`),
    index("runs_loop_terminal_history_idx").on(t.loopId, t.runIndex).where(sql`${t.runIndex} IS NOT NULL AND ${t.phase} IN ('done', 'error', 'canceled')`),
    // Current scheduling has one pending queue slot per loop.
    uniqueIndex("runs_loop_pending_idx").on(t.loopId).where(sql`${t.phase} = 'pending'`),
    uniqueIndex("one_running_run_per_loop").on(t.loopId).where(sql`${t.phase} = 'running'`),
    check("runs_agent_check", sql`${t.agent} IS NULL OR ${t.agent} IN ('claude-code', 'codex', 'pi')`),
    check("runs_phase_check", sql`${t.phase} IN ('pending', 'running', 'done', 'error', 'canceled')`),
    check("runs_requested_by_check", sql`${t.requestedBy} IN ('owner', 'system')`),
    check("runs_status_check", sql`${t.status} IS NULL OR ${t.status} IN ('ok', 'block')`),
    // Only a run that completed the final-line contract has a status.
    check("runs_done_status_check", sql`(${t.phase} = 'done') = (${t.status} IS NOT NULL)`),
  ],
);

// A RUN LEASE is minted per delivery and authorizes the report callback.
// Only the SHA-256 digest of the wire token is stored; plaintext is never needed
// again. Lifecycle: `active` (expiresAt null = no expiry; the inactivity sweep
// is the vanished-machine guard) → `terminal-grace` (bounded final-report window
// for wake reconciliation) → deleted on report, or `retired`
// on expiry. Retired is non-authorizing durable 410 evidence until that report.

export const runLeases = pgTable(
  "run_leases",
  {
    tokenHash: text("token_hash").primaryKey(),
    runId: text("run_id").notNull(),
    loopId: text("loop_id").notNull(),
    machineId: text("machine_id").notNull(),
    state: text("state", { enum: ["active", "terminal-grace", "reconciliation-only", "retired"] }).notNull().default("active"),
    /** sha256 of the run's read-only context token (`rc_…`), which lets the
     *  in-run `pievo` read this loop's history while the lease is active. It is
     *  separate from the report token so an agent cannot forge its own result. */
    contextHash: text("context_hash"),
    /** Null while active/retired; ISO only during terminal-grace. */
    expiresAt: text("expires_at"),
    createdAt: text("created_at").notNull(),
  },
  // terminalizeLease targets by runId; loop deletion preserves retired rows.
  (t) => [
    index("run_leases_run_idx").on(t.runId),
    index("run_leases_loop_idx").on(t.loopId),
    uniqueIndex("run_leases_context_idx").on(t.contextHash),
    check("run_leases_state_check", sql`${t.state} IN ('active', 'terminal-grace', 'reconciliation-only', 'retired')`),
  ],
);

export const runReportReceipts = pgTable(
  "run_report_receipts",
  {
    reportId: text("report_id").primaryKey(),
    runId: text("run_id").notNull(),
    payloadDigest: text("payload_digest").notNull(),
    ackStatus: integer("ack_status").notNull(),
    ackBody: jsonb("ack_body").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (t) => [index("report_receipts_created").on(t.createdAt)],
);

/** Durable evidence for a rejected terminal attempt. It is keyed by
 * sha256(reportId + canonical-payload-digest), is never loop-owned, and therefore
 * survives loop deletion just like normal report receipts. */
export const terminalReportIncidents = pgTable(
  "terminal_report_incidents",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    reportId: text("report_id").notNull(),
    payloadDigest: text("payload_digest").notNull(),
    disposition: text("disposition", { enum: ["run-error", "telemetry-rejected"] }).$type<ReportIncidentDisposition>().notNull(),
    ackBody: jsonb("ack_body").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (t) => [
    index("terminal_report_incidents_report_id").on(t.reportId),
    index("terminal_report_incidents_created").on(t.createdAt),
    check("terminal_report_incidents_disposition_check", sql`${t.disposition} IN ('run-error', 'telemetry-rejected')`),
  ],
);

// One row per minted connect key, keyed by the machine id derived from it
// (`m-sha256(token)[:16]`) so first-poll enrollment can be authorized without
// storing the key itself. Machine deletion removes the row, so a still-running
// daemon cannot re-register a deleted machine. Rows expire after
// CONNECT_KEY_TTL_MS (lazy on read + pruned on write).
export const connectKeys = pgTable("connect_keys", {
  machineId: text("machine_id").primaryKey(),
  /** Mint time (ISO) — drives the TTL. */
  mintedAt: text("minted_at").notNull(),
});

export type Machine = typeof machines.$inferSelect;
export type NewMachine = typeof machines.$inferInsert;
export type Loop = typeof loops.$inferSelect;
export type NewLoop = typeof loops.$inferInsert;
export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;

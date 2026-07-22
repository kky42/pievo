/**
 * Pievo business schema (Drizzle, Postgres `pg-core` dialect).
 *
 * Three tables — machines / loops / runs — keyed off the Better Auth `user`
 * table (added in the auth step; `userId` here is the owning user's id). We use
 * Drizzle (not raw SQL) so the store is single-sourced across the driver tiers
 * (postgres-js on Supabase; embedded pglite for local/self-host + tests) — the
 * query-builder API is identical, only `db/index.ts` branches the driver.
 *
 * Timestamps are ISO strings (`text`) for portability + to match the carried-over
 * c0 types (no db-side defaults). JSON columns use `jsonb().$type<>()` for typed
 * (de)serialization. Booleans use native `boolean()`.
 */
import { sql } from "drizzle-orm";
import { pgTable, text, integer, boolean, jsonb, index, uniqueIndex, timestamp } from "drizzle-orm/pg-core";

import type { ArtifactMeta } from "../server/frontmatter.js";
// The coding-agent enum's SINGLE SOURCE lives in `../types` (client-safe, no db
// deps); this schema DERIVES both the `CodingAgent` type and the `loops.agent`
// column enum from it, so widening the set is a one-line edit
// to `CODING_AGENTS` with no change here. `../types` imports nothing at runtime, so
// this introduces no import cycle.
import { CODING_AGENTS } from "../types.js";
import type { PauseCause, ReportIncident, ReportIncidentDisposition } from "../types.js";

export type { ArtifactMeta } from "../server/frontmatter.js";

// ---- shared value shapes (mirror the carried-over scheduler types) ----

/** Declares a loop's per-run numeric observation metrics (chart legend + validation). */
export interface MetricField {
  key: string;
  label?: string;
  unit?: string;
}

/** One exec run's complete metric observation for its declared schema. */
export type RunMetrics = Record<string, number | null>;

/** One control command an exec/evolve run issued via the `pievo` shim (audit). */
export interface ControlAction {
  ts: string;
  command: string;
  args: Record<string, string>;
  result: "ok" | "rejected";
  detail?: string;
}

/** Provider-neutral token usage reported by the daemon. */
export interface RunUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export type NotifyPolicy = "always" | "auto" | "never";
export type ScheduleMode = "cron" | "continuous";
export type RunPhase = "pending" | "running" | "done" | "error" | "canceled";
export type RunRole = "exec" | "evolve" | "steer";
/** Queue authority, not scheduling provenance. Owner intent may promote a
 * system row, and no later system event may downgrade it. */
export type RunRequester = "owner" | "system";
/** `skipped`: a pending run retired without executing (pause/retention cleanup,
 *  legacy coalesce, or the offline catch-up window elapsed).
 *  Neither success nor failure — excluded from the failure streak (it rides
 *  phase `canceled`, and the streak counts only phase `error`). */
export type RunStatus = "kept" | "no-change" | "blocked";

export type ChannelType = "telegram" | "slack" | "feishu";

/** The coding agent a loop is bound to / recorded as its host (see `loops.agent`).
 *  DERIVED from the `CODING_AGENTS` single source so it widens automatically. */
export type CodingAgent = (typeof CODING_AGENTS)[number];

/** A push channel's transport secrets (one shape per type; only the relevant keys set). */
export interface ChannelConfig {
  /** telegram: bot token (`123456:ABC…`) + target chat id (user/group/channel). */
  botToken?: string;
  chatId?: string;
  /** slack: bot token (`xoxb-…`) + target channel (`#name` or id). */
  token?: string;
  channel?: string;
  /** feishu: custom-bot webhook URL + optional signing secret (签名校验). */
  webhookUrl?: string;
  secret?: string;
}

// ---- machines: a teammate's daemon (machine == identity unit) ----

export const machines = pgTable(
  "machines",
  {
    /** m-sha256(deviceToken)[:16] */
    id: text("id").primaryKey(),
    /** Owning user (Better Auth user.id) — creator attribution. */
    userId: text("user_id").notNull(),
    /** Owning team — the scope machines/loops/channels are listed by. Backfilled
     *  from userId for pre-team rows (`team-<userId>`); see migration. */
    teamId: text("team_id"),
    /** Friendly name (set AFTER the daemon connects; empty string = pending/unnamed). */
    name: text("name").notNull(),
    /** Daemon-reported machine identity (captured on first connect). */
    hostname: text("hostname"),
    platform: text("platform"),
    arch: text("arch"),
    /** Daemon package version reported on poll (e.g. "0.8.0"). Null for older
     *  daemons that don't report it (and until the first poll). Drives the web's
     *  "upgrade available" hint against the cached npm latest. */
    daemonVersion: text("daemon_version"),
    /** Breaking machine protocol last observed on poll. */
    daemonProtocol: integer("daemon_protocol"),
    /** Hash of the device token (machine identity derives from the token). */
    tokenHash: text("token_hash").notNull(),
    /**
     * Plaintext device token. Stored so the UI can re-show the connect command
     * anytime (MVP convenience — deviates from "store only the hash"; acceptable
     * for a self-hosted team tool where the DB is already the trust root).
     */
    token: text("token"),
    /** Workdir allowlist the daemon enforces as cwd jail; null/[] = unrestricted. */
    roots: jsonb("roots").$type<string[]>(),
    /** Last WS contact (ISO). */
    lastSeen: text("last_seen"),
    /** Live WS connection state. */
    online: boolean("online").notNull().default(false),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("machines_user_idx").on(t.userId), index("machines_team_idx").on(t.teamId)],
);

// ---- loops: a scheduled behavior bound to one machine ----

export const loops = pgTable(
  "loops",
  {
    id: text("id").primaryKey(),
    /** Owning user (creator attribution). */
    userId: text("user_id").notNull(),
    /** Owning team — the scope loops are listed/authorized by. Backfilled from
     *  userId for pre-team rows (`team-<userId>`); see migration. */
    teamId: text("team_id"),
    /** Push channel this loop notifies through (notification_channels.id). Null ⇒
     *  no external push (dashboard only) regardless of `notify` policy. */
    channelId: text("channel_id"),
    /** Execution machine (set at creation; no cross-machine fallback). */
    machineId: text("machine_id").notNull(),
    name: text("name"),
    cron: text("cron").notNull(),
    /** Cadence is orthogonal to the standing goal. The cron value remains stored while continuous mode ignores it, so
     *  switching back restores the prior cron without reconstructing it. */
    scheduleMode: text("schedule_mode", { enum: ["cron", "continuous"] }).notNull().default("cron"),
    /** Delay used when a done/error terminal restores continuous cadence.
     *  Write surfaces enforce >= 1 minute. */
    continuousDelayMinutes: integer("continuous_delay_minutes").notNull().default(1),
    /** IANA tz the cron is interpreted in (e.g. "Asia/Shanghai"). Null ⇒ server local (UTC in prod). */
    timezone: text("timezone"),
    /** Absolute project dir ON THE MACHINE the agent runs in (cwd). Null ⇒ daemon scratch dir. */
    workdir: text("workdir"),
    /** Path ON THE MACHINE to the loop's authoritative standing-instruction file. */
    taskFile: text("task_file"),
    /** Latest synced snapshot of `taskFile`'s content — the daemon pushes it on
     *  report (capped; tail if huge). Null ⇒ never synced (no run yet / no file). */
    taskFileContent: text("task_file_content"),
    /** When `taskFileContent` was last synced from the machine (ISO). */
    taskFileSyncedAt: text("task_file_synced_at"),
    /** Generative-UI template (authored by evolve; sanitized at render). */
    ui: text("ui"),
    /** Per-run metric schema. */
    metricSchema: jsonb("metric_schema").$type<MetricField[]>(),
    notify: text("notify", { enum: ["always", "auto", "never"] }).notNull().default("auto"),
    /** May a run change its own schedule (reschedule/set-cron)? Default TRUE — a
     *  loop self-adjusts unless the owner PINS the schedule (allowControl=false =
     *  "don't self-adjust"). Run-path self-schedule is floor-guarded (see the
     *  cadence floors in gateway); the owner's edit path is unlimited. */
    allowControl: boolean("allow_control").notNull().default(true),
    /** Optional standing objective. It guides every run but never changes lifecycle;
     * only the owner pauses or deletes a loop. */
    goal: text("goal"),
    /** Durable Stop-before-delete marker. A deleting loop is never claimable. */
    deleteRequestedAt: timestamp("delete_requested_at", { withTimezone: true, mode: "string" }),
    /** Diagnostic annotation for a paused loop. */
    pauseCause: jsonb("pause_cause").$type<PauseCause>(),
    /** Optional provider model id. Null delegates model selection to the coding-agent CLI. */
    model: text("model"),
    /** Optional provider reasoning-effort value. Null delegates to the coding-agent CLI. */
    reasoningEffort: text("reasoning_effort"),
    /** Coding agent this loop is BOUND TO and EXECUTED with: the daemon's
     *  `buildAgentSpawn` branches on this value (`claude-code` → claude,
     *  `codex` → `codex exec`). Measured from the creating CLI's env when
     *  detectable, else the declared/selected value; TS-only enum
     *  (stored as plain text) DERIVED from the `CODING_AGENTS` single source, so
     *  widening the set is a one-line edit there with no migration and no change
     *  here. Existing rows backfill to `claude-code` via default. */
    agent: text("agent", { enum: CODING_AGENTS }).notNull().default("claude-code"),
    enabled: boolean("enabled").notNull().default(true),
    /** One-shot override, independent of the recurring cadence (ISO). */
    nextRunAt: text("next_run_at"),
    /** @deprecated Old-image shape only. Migration 0003 clears it; writes after
     * that forward-only migration are unsupported and new runtime never drains it. */
    evolveDue: boolean("evolve_due"),
    /** @deprecated Old-image shape only. Migration 0003 clears it; writes after
     * that forward-only migration are unsupported and new runtime never drains it. */
    editRequest: text("edit_request"),
    /** The next recurring cadence occurrence not yet materialized as a run. Cron
     * advances this fact after each due occurrence; continuous clears it on due
     * and restores it from a successful/error terminal. */
    nextCadenceAt: text("next_cadence_at"),
    /** Terminal exec count at last evolution (drives the periodic evolve trigger). */
    evolvedRunCount: integer("evolved_run_count"),
    /** Last history number assigned under this loop's row lock. */
    lastRunIndex: integer("last_run_index").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("loops_user_idx").on(t.userId),
    index("loops_team_idx").on(t.teamId),
    index("loops_machine_idx").on(t.machineId),
    index("delete_requested_loops").on(t.deleteRequestedAt).where(sql`${t.deleteRequestedAt} IS NOT NULL`),
  ],
);

// ---- runs: one execution record (own table, not embedded) ----

export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    loopId: text("loop_id").notNull(),
    userId: text("user_id").notNull(),
    machineId: text("machine_id").notNull(),
    /** Execution profile captured atomically at claim. Pending/unclaimed rows are null. */
    agent: text("agent", { enum: CODING_AGENTS }),
    model: text("model"),
    reasoningEffort: text("reasoning_effort"),
    /** 1-based execution/terminal order, assigned at claim or unclaimed terminalization. */
    runIndex: integer("run_index"),
    phase: text("phase", { enum: ["pending", "running", "done", "error", "canceled"] }).notNull(),
    role: text("role", { enum: ["exec", "evolve", "steer"] }).notNull(),
    /** Durable queue authority. It only promotes system→owner; diagnostic trigger
     * reasons, if added later, must never drive lifecycle state. */
    requestedBy: text("requested_by", { enum: ["owner", "system"] }).notNull().default("system"),
    /** Role-specific queued payload. Steer instructions live on the run, never on
     *  the loop, so finishing steer A cannot erase queued steer B. */
    requestText: text("request_text"),
    /** Current phase/event timestamp retained for wire/UI compatibility. */
    ts: text("ts").notNull(),
    /** Immutable queue/history age anchor plus mutation timestamp. Defaults reduce
     * old-image insert breakage; the new runtime always supplies both explicitly. */
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP::text`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP::text`),
    status: text("status", { enum: ["kept", "no-change", "blocked"] }),
    message: text("message"),
    durationMs: integer("duration_ms"),
    exitCode: integer("exit_code"),
    finalText: text("final_text"),
    error: text("error"),
    /** This run's observation snapshot — numeric metrics (chart points) plus scalar
     *  values the generative UI binds via {{latest.*}} (strings ok; chart ignores them). */
    metrics: jsonb("metrics").$type<RunMetrics>(),
    /** Control actions this run issued (audit). */
    control: jsonb("control").$type<ControlAction[]>(),
    /** Provider session id on the machine, retained for owner-side continuation. */
    sessionId: text("session_id"),
    /** Provider-neutral token usage. Dollar cost is deliberately not stored. */
    usage: jsonb("usage").$type<RunUsage>(),
    /** Monotonic cancellation intent. Running becomes canceled only on daemon report. */
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true, mode: "string" }),
    /** Last poll where this machine declared the run active. Timeout authority. */
    heartbeatAt: text("heartbeat_at"),
    /** One-shot marker for the offline deferred notification; separate from heartbeat. */
    deferredAt: text("deferred_at"),
    /** Latest rejected terminal-report diagnosis, if any. */
    reportIncident: jsonb("report_incident").$type<ReportIncident>(),
  },
  (t) => [
    index("runs_loop_idx").on(t.loopId),
    index("runs_phase_idx").on(t.phase),
    index("runs_machine_phase_ready_idx").on(t.machineId, t.phase),
    index("runs_loop_ts_idx").on(t.loopId, t.ts),
    uniqueIndex("runs_loop_run_index_idx").on(t.loopId, t.runIndex).where(sql`${t.runIndex} IS NOT NULL`),
    index("runs_loop_terminal_history_idx").on(t.loopId, t.runIndex).where(sql`${t.runIndex} IS NOT NULL AND ${t.phase} IN ('done', 'error', 'canceled')`),
    // The queue seam coalesces under a loop-row lock; this partial unique index is
    // the final invariant if another process races or a future caller regresses.
    uniqueIndex("runs_loop_role_pending_idx").on(t.loopId, t.role).where(sql`${t.phase} = 'pending'`),
    uniqueIndex("one_running_run_per_machine").on(t.machineId).where(sql`${t.phase} = 'running'`),
  ],
);

// ---- run_leases: the per-run credential (durable across deploys) ----
//
// A RUN LEASE is minted per delivery and authorizes every in-run `pievo` verb
// plus the final `/machine/report`. It was an in-process Map through v1, which
// meant EVERY deploy broke every in-flight run's finalize (the report 401'd and
// the run was falsely failed by the sweep ~20min later) and a long-sleep
// wake-report died the same way. Durable rows make a restart invisible to a
// running run. Only the sha256 of the wire token is stored — a DB leak must not
// hand out live run credentials (unlike `machines.token`, there is no re-show
// need). Lifecycle: `active` (expiresAt null = no expiry; the inactivity sweep
// is the vanished-machine guard) → `terminal-grace` (bounded final-report window
// for wake reconciliation) → deleted on report, or `retired`
// on expiry. Retired is non-authorizing durable 410 evidence until that report.

export const runLeases = pgTable(
  "run_leases",
  {
    /** sha256 hex of the full wire token (`rk_…`, or a pre-Batch-6 bare UUID). */
    tokenHash: text("token_hash").primaryKey(),
    runId: text("run_id").notNull(),
    loopId: text("loop_id").notNull(),
    machineId: text("machine_id").notNull(),
    role: text("role", { enum: ["exec", "evolve", "steer"] }).notNull(),
    allowControl: boolean("allow_control").notNull().default(false),
    canSetUi: boolean("can_set_ui").notNull().default(false),
    canSetSchema: boolean("can_set_schema").notNull().default(false),
    state: text("state", { enum: ["active", "terminal-grace", "retired"] }).notNull().default("active"),
    /** Null while active/retired; ISO only during terminal-grace. */
    expiresAt: text("expires_at"),
    createdAt: text("created_at").notNull(),
  },
  // terminalizeLease targets by runId; loop deletion preserves retired rows.
  (t) => [index("run_leases_run_idx").on(t.runId), index("run_leases_loop_idx").on(t.loopId)],
);

// ---- durable terminal report receipts (survive loop deletion) ----

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
  ],
);

// ---- connect_keys: a minted connect-key's owner + team binding (durable) ----
//
// One row per minted connect-key/claim token, keyed by the machine id DERIVED
// from it (`m-sha256(token)[:16]`) so both consumers resolve without storing the
// key itself: the self-register owner lookup (by machine id) and the createLoop
// team binding (derives the id from the presented claim). Replaces the two
// in-process maps (`deviceOwners` + `claimIntents`) whose loss on deploy made a
// post-restart paste silently mis-file the loop into the machine's home team.
// Rows expire after CONNECT_KEY_TTL_MS (lazy on read + pruned on write).

export const connectKeys = pgTable("connect_keys", {
  /** m-sha256(connectKey)[:16] — the machine id this key self-registers as. */
  machineId: text("machine_id").primaryKey(),
  /** The user who minted the key (the authenticated dashboard session). */
  userId: text("user_id").notNull(),
  /** The validated active team the key was minted under (null: no team bound —
   *  e.g. the pre-created-machine path, where the machine row carries the team). */
  teamId: text("team_id"),
  /** Mint time (ISO) — drives the TTL. */
  mintedAt: text("minted_at").notNull(),
});

// ---- teams: the ownership/scope unit (every user gets a personal team) ----

export const teams = pgTable("teams", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** The user whose personal team this is (null for the open-mode shared team). */
  ownerUserId: text("owner_user_id"),
  createdAt: text("created_at").notNull(),
});

export const teamMembers = pgTable(
  "team_members",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role", { enum: ["owner", "member"] }).notNull().default("member"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("team_members_team_idx").on(t.teamId), index("team_members_user_idx").on(t.userId)],
);

// ---- team_invites: a short-lived, single-use link a signed-in recipient redeems ----
//
// The owner-initiated invite mechanism (design §4, decision 2, "invite-link"): an
// owner mints a token, shares the `/invite/<token>` link over their own channel,
// and a signed-in recipient redeems it into membership. Single-use (`redeemedAt`
// stamps it spent), short TTL (`expiresAt`), and the granted `role` is baked in
// (capped at the inviter's role at mint time). The token is stored plaintext as
// the primary key — same trust model as `machines.token`/`connect_keys` (a
// self-hosted small-team tool whose DB is already the trust root); the link only
// grants membership WITHIN the app and never bypasses the login allowlist
// (decision 3 — the redeemer must already have signed in through the gate).
export const teamInvites = pgTable(
  "team_invites",
  {
    /** The wire token the recipient presents (`/invite/<token>`). */
    token: text("token").primaryKey(),
    teamId: text("team_id").notNull(),
    /** Role granted on redeem (capped at the inviter's role at mint time). */
    role: text("role", { enum: ["owner", "member"] }).notNull().default("member"),
    /** The owner who minted the invite (attribution). */
    invitedByUserId: text("invited_by_user_id").notNull(),
    /** When the invite lapses (ISO). A redeem past this is refused. */
    expiresAt: text("expires_at").notNull(),
    /** Single-use stamp: set on redeem so the same link can't be reused. */
    redeemedAt: text("redeemed_at"),
    /** The user who redeemed it (attribution). */
    redeemedByUserId: text("redeemed_by_user_id"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("team_invites_team_idx").on(t.teamId)],
);

// ---- notification channels: per-team push targets a loop can route to ----

export const notificationChannels = pgTable(
  "notification_channels",
  {
    id: text("id").primaryKey(),
    /** Owning team (channels are listed/selected within a team). */
    teamId: text("team_id").notNull(),
    type: text("type", { enum: ["telegram", "slack", "feishu"] }).notNull(),
    name: text("name").notNull(),
    /** Transport secrets (shape per `type`). Stored as JSON; never sent to the client raw. */
    config: jsonb("config").$type<ChannelConfig>().notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("notification_channels_team_idx").on(t.teamId)],
);

// ---- artifacts: content-addressed live-synced loop files (Phase 1 foundation) ----
//
// The daemon watches each loop's folder and live-syncs changed files. Blob BYTES
// live in the local filesystem or configured object storage, keyed by sha256 —
// NOT in the DB (no `content` column), keeping the business DB lean and preserving
// the server's zero-exec invariant (it only stores/reads bytes, never interprets
// them). These two tables hold only metadata.

/**
 * One content-addressed blob (deduped across every loop/run). The bytes live in
 * the byte store under the hash; this row records that the server has them + their shape.
 */
export const blobs = pgTable("blobs", {
  /** sha256 hex of the bytes (the byte-store key). */
  hash: text("hash").primaryKey(),
  size: integer("size").notNull(),
  /** Heuristic: the bytes contain a NUL (download-only; no inline text render). */
  binary: boolean("binary").notNull().default(false),
  /** Parsed front-matter subset ({type?,title?,date?}) for a non-binary markdown
   *  product, or null (untyped / binary / no usable front matter). Front matter is
   *  a pure function of content, so this is parsed ONCE where the bytes first
   *  arrive (sync inline / putBlob) and reused on every content-addressed dedup
   *  re-reference. Old blobs keep it null — zero migration/backfill. */
  meta: jsonb("meta").$type<ArtifactMeta>(),
  createdAt: text("created_at").notNull(),
});

/**
 * The CURRENT file set of each loop — one row per live (or tombstoned) path,
 * relative to the loop's watch folder. `hash` → `blobs.hash`; null when the file
 * is deleted (tombstone) or oversize (metadata-only, no bytes synced). The
 * unique (loopId, path) index is the upsert key the sync reconciliation drives.
 */
export const artifactFiles = pgTable(
  "artifact_files",
  {
    id: text("id").primaryKey(),
    loopId: text("loop_id").notNull(),
    /** Normalized, loop-folder-relative (never absolute, never escaping the dir). */
    path: text("path").notNull(),
    /** → blobs.hash. Null when deleted or oversize (no bytes stored). */
    hash: text("hash"),
    size: integer("size"),
    /** Bytes contain a NUL (mirrors blobs.binary; set even for oversize files). */
    binary: boolean("binary").notNull().default(false),
    /** File exceeds the per-file byte cap → metadata-only (path + size), no blob. */
    oversize: boolean("oversize").notNull().default(false),
    /** Tombstone: the file vanished from the loop's manifest (kept for future diffs). */
    deleted: boolean("deleted").notNull().default(false),
    updatedAt: text("updated_at").notNull(),
    /** The run in-flight when this change synced (null for idle-time human edits). */
    lastRunId: text("last_run_id"),
  },
  (t) => [
    index("artifact_files_loop_idx").on(t.loopId),
    uniqueIndex("artifact_files_loop_path_idx").on(t.loopId, t.path),
    // The blob GC's per-candidate referenced re-check + the putBlob cap guard both
    // do a point lookup by hash; without this they full-scan artifact_files.
    index("artifact_files_hash_idx").on(t.hash),
  ],
);

/**
 * One file's metadata in a run snapshot (path → this). Richer than a bare
 * path→hash map so the per-run diff can compute a size delta and pick a render
 * mode (text diff vs "binary changed ±KB") without re-reading artifact_files.
 */
export interface SnapshotEntry {
  /** → blobs.hash; null for an oversize (metadata-only) file. */
  hash: string | null;
  size: number | null;
  binary: boolean;
  oversize: boolean;
}

/** A loop's full file set at a run boundary: path → {hash,size,binary,oversize}. */
export type SnapshotManifest = Record<string, SnapshotEntry>;

/**
 * The loop's full artifact manifest captured at each run's finalize — the input
 * to the per-run diff (Phase 3). Written cheaply on report (no diff computed on
 * write); `getRunDiff` lazily diffs run N's snapshot against the prior run's.
 * One row per run (runId PK); runs predating the feature simply have no row
 * (the diff view degrades to its "no recorded changes" copy).
 */
export const runSnapshots = pgTable(
  "run_snapshots",
  {
    runId: text("run_id").primaryKey(),
    loopId: text("loop_id").notNull(),
    manifest: jsonb("manifest").$type<SnapshotManifest>().notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("run_snapshots_loop_idx").on(t.loopId)],
);

export type Machine = typeof machines.$inferSelect;
export type NewMachine = typeof machines.$inferInsert;
export type Loop = typeof loops.$inferSelect;
export type NewLoop = typeof loops.$inferInsert;
export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
export type Team = typeof teams.$inferSelect;
export type NewTeam = typeof teams.$inferInsert;
export type TeamMember = typeof teamMembers.$inferSelect;
export type NewTeamMember = typeof teamMembers.$inferInsert;
export type TeamInvite = typeof teamInvites.$inferSelect;
export type NewTeamInvite = typeof teamInvites.$inferInsert;
export type NotificationChannel = typeof notificationChannels.$inferSelect;
export type NewNotificationChannel = typeof notificationChannels.$inferInsert;
export type Blob = typeof blobs.$inferSelect;
export type NewBlob = typeof blobs.$inferInsert;
export type ArtifactFile = typeof artifactFiles.$inferSelect;
export type NewArtifactFile = typeof artifactFiles.$inferInsert;
export type RunSnapshot = typeof runSnapshots.$inferSelect;
export type NewRunSnapshot = typeof runSnapshots.$inferInsert;
export type RunLeaseRow = typeof runLeases.$inferSelect;
export type ConnectKeyRow = typeof connectKeys.$inferSelect;
export type RunReportReceipt = typeof runReportReceipts.$inferSelect;
export type TerminalReportIncidentReceipt = typeof terminalReportIncidents.$inferSelect;

/** Drizzle table bag (also used by the Better Auth drizzle adapter once auth lands). */
export const businessSchema = { machines, loops, runs, teams, teamMembers, teamInvites, notificationChannels, blobs, artifactFiles, runSnapshots, runLeases, runReportReceipts, terminalReportIncidents, connectKeys };

// Keep a default no-op SQL reference so `sql` import isn't flagged before use.
export const _schemaVersion = sql`1`;

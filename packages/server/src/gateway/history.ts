import { and, asc, desc, eq, gt, gte, inArray, isNotNull, lt, lte, sql } from "drizzle-orm";

import { db } from "../db/index.js";
import { runs, type Loop, type Run, type RunRole, type RunUsage } from "../db/schema.js";
import * as store from "../db/store.js";
import { computeRunDiff } from "../server/runDiff.js";
import { detailBlock, doc, emptyList, helpBlock, listBlock, scalar, truncate } from "./toon.js";
import type { HttpResult } from "./http.js";

export const HISTORY_LIMIT_MAX = 20;
export const HISTORY_MESSAGE_CAP = 500;
export const HISTORY_DETAIL_TEXT_CAP = 32 * 1024;
export const HISTORY_DIFF_TEXT_CAP = 96 * 1024;
export const HISTORY_DIFF_FILES_MAX = 100;
export const HISTORY_DIFF_INPUT_BYTES_MAX = 2 * 1024 * 1024;
/** Aggregate work cap. Summary intentionally fails instead of silently sampling. */
export const HISTORY_SUMMARY_ROWS_MAX = 5_000;
export const HISTORY_METRIC_KEYS_MAX = 100;
export const HISTORY_PROFILE_KEYS_MAX = 50;
export const HISTORY_PROFILE_VALUE_CAP = 256;
export const HISTORY_CONTROL_ACTIONS_MAX = 50;
export const HISTORY_CONTROL_ARGS_CAP = 8 * 1024;
export const HISTORY_JSON_TEXT_CAP = 512 * 1024;

const TERMINAL_PHASES = ["done", "error", "canceled"] as const;
const ROLES = ["exec", "evolve", "steer"] as const;
const STATUSES = ["kept", "no-change", "blocked"] as const;
const LOG_FLAGS = new Set(["_", "loop", "help", "summary", "run", "diff", "after", "through", "since", "until", "role", "status", "phase", "limit", "json"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Flags = Record<string, string | boolean | undefined>;
type HistoryMode = "list" | "summary" | "detail";

interface WindowSpec {
  after?: number;
  through?: number;
  since?: string;
  until?: string;
}

interface HistoryQuery extends WindowSpec {
  mode: HistoryMode;
  json: boolean;
  diff: boolean;
  run?: number | string;
  role?: RunRole;
  status?: "kept" | "no-change" | "blocked";
  phase?: "done" | "error" | "canceled";
  limit: number;
}

type Parsed = { ok: true; value: HistoryQuery } | { ok: false; error: string };

function bool(v: unknown): boolean {
  return v === true || v === "true";
}

function positiveInt(name: string, value: unknown, max?: number): number | undefined | string {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return `--${name} must be a positive integer`;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || (max !== undefined && n > max)) {
    return `--${name} must be between 1 and ${max ?? Number.MAX_SAFE_INTEGER}`;
  }
  return n;
}

/** Exclusive history cursors admit zero so a fresh Cookbook's `#0` means
 * "nothing consolidated yet" without a separate first-run command form. */
function historyCursor(value: unknown): number | undefined | string {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return "--after must be a non-negative integer";
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : "--after must be a non-negative safe integer";
}

function iso(name: string, value: unknown): string | undefined | { error: string } {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) {
    return { error: `--${name} must be an ISO timestamp` };
  }
  return new Date(value).toISOString();
}

/** Parse the complete server-owned history grammar. Both credential paths call
 * this before the same query/render implementation. */
export function parseHistoryFlags(flags: Flags): Parsed {
  const unknown = Object.keys(flags).filter((key) => !LOG_FLAGS.has(key));
  if (unknown.length) return { ok: false, error: `pievo: unknown flag --${unknown[0]} for log` };

  const after = historyCursor(flags.after);
  if (typeof after === "string") return { ok: false, error: after };
  const through = positiveInt("through", flags.through);
  if (typeof through === "string") return { ok: false, error: through };
  const limit = positiveInt("limit", flags.limit, HISTORY_LIMIT_MAX);
  if (typeof limit === "string") return { ok: false, error: limit };
  const since = iso("since", flags.since);
  if (since && typeof since === "object") return { ok: false, error: since.error };
  const until = iso("until", flags.until);
  if (until && typeof until === "object") return { ok: false, error: until.error };
  if ((after !== undefined || through !== undefined) && (since !== undefined || until !== undefined)) {
    return { ok: false, error: "index windows (--after/--through) cannot be mixed with time windows (--since/--until)" };
  }
  if (after !== undefined && through !== undefined && after >= through) {
    return { ok: false, error: "--after must be less than --through" };
  }
  if (since !== undefined && until !== undefined && since > until) {
    return { ok: false, error: "--since must not be after --until" };
  }

  const role = flags.role;
  if (role !== undefined && (typeof role !== "string" || !(ROLES as readonly string[]).includes(role))) {
    return { ok: false, error: "--role must be exec|evolve|steer" };
  }
  const status = flags.status;
  if (status !== undefined && (typeof status !== "string" || !(STATUSES as readonly string[]).includes(status))) {
    return { ok: false, error: "--status must be kept|no-change|blocked" };
  }
  const phase = flags.phase;
  if (phase !== undefined && (typeof phase !== "string" || !(TERMINAL_PHASES as readonly string[]).includes(phase))) {
    return { ok: false, error: "--phase must be done|error|canceled" };
  }

  const summary = bool(flags.summary);
  const runRaw = flags.run;
  if (summary && runRaw !== undefined) return { ok: false, error: "--summary and --run are mutually exclusive" };
  if (bool(flags.diff) && runRaw === undefined) return { ok: false, error: "--diff requires --run" };
  if (summary && (role !== undefined || status !== undefined || phase !== undefined || flags.limit !== undefined)) {
    return { ok: false, error: "--summary accepts windows only, not list filters or --limit" };
  }
  if (runRaw !== undefined && (after !== undefined || through !== undefined || since !== undefined || until !== undefined || role !== undefined || status !== undefined || phase !== undefined || flags.limit !== undefined)) {
    return { ok: false, error: "--run cannot be combined with windows, list filters, or --limit" };
  }

  let run: number | string | undefined;
  if (runRaw !== undefined) {
    if (typeof runRaw !== "string") return { ok: false, error: "--run needs a run index or full UUID" };
    if (/^\d+$/.test(runRaw)) {
      const parsed = positiveInt("run", runRaw);
      if (typeof parsed === "string" || parsed === undefined) return { ok: false, error: typeof parsed === "string" ? parsed : "--run needs a run index" };
      run = parsed;
    } else if (UUID.test(runRaw)) run = runRaw;
    else return { ok: false, error: "--run needs a positive run index or full UUID" };
  }

  return {
    ok: true,
    value: {
      mode: summary ? "summary" : run !== undefined ? "detail" : "list",
      json: bool(flags.json),
      diff: bool(flags.diff),
      ...(run !== undefined ? { run } : {}),
      ...(after !== undefined ? { after } : {}),
      ...(through !== undefined ? { through } : {}),
      ...(since !== undefined ? { since } : {}),
      ...(until !== undefined ? { until } : {}),
      ...(role !== undefined ? { role: role as RunRole } : {}),
      ...(status !== undefined ? { status: status as HistoryQuery["status"] } : {}),
      ...(phase !== undefined ? { phase: phase as HistoryQuery["phase"] } : {}),
      limit: limit ?? 10,
    },
  };
}

function windowConditions(loopId: string, q: WindowSpec) {
  return [
    eq(runs.loopId, loopId),
    isNotNull(runs.runIndex),
    inArray(runs.phase, [...TERMINAL_PHASES]),
    q.after !== undefined ? gt(runs.runIndex, q.after) : undefined,
    q.through !== undefined ? lte(runs.runIndex, q.through) : undefined,
    q.since !== undefined ? gte(runs.ts, q.since) : undefined,
    q.until !== undefined ? lte(runs.ts, q.until) : undefined,
  ];
}

/** Terminal evidence after an indexed open row is observable but not safe to
 * consolidate. This correlated condition keeps cursors before the first gap. */
function beforeLowestIndexedOpen(loopId: string) {
  return lt(runs.runIndex, sql<number>`coalesce((
    select min(open_run.run_index)
    from runs as open_run
    where open_run.loop_id = ${loopId}
      and open_run.run_index is not null
      and open_run.phase in ('pending', 'running')
  ), 2147483648)`);
}

async function selectedThrough(loopId: string, q: WindowSpec): Promise<number | null> {
  const row = (await db.select({ n: sql<number | null>`max(${runs.runIndex})` }).from(runs)
    .where(and(...windowConditions(loopId, q), beforeLowestIndexedOpen(loopId))))[0];
  return row?.n == null ? null : Number(row.n);
}

function resultToken(run: Pick<Run, "phase" | "status">): string {
  if (run.status === "blocked") return `blocked/${run.phase}`;
  if (run.phase === "canceled") return "canceled";
  const base = run.phase === "error" ? "failed" : run.phase === "done" ? "ok" : run.phase;
  return run.status ? `${base}/${run.status}` : `${base}/missing-status`;
}

function compactUsage(usage: RunUsage | null): string | null {
  if (!usage) return null;
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) parts.push(`in=${usage.inputTokens}`);
  if (usage.outputTokens !== undefined) parts.push(`out=${usage.outputTokens}`);
  if (usage.cacheReadTokens !== undefined) parts.push(`cache-read=${usage.cacheReadTokens}`);
  if (usage.cacheCreationTokens !== undefined) parts.push(`cache-write=${usage.cacheCreationTokens}`);
  return parts.length ? parts.join(";") : null;
}

function compactMetrics(metrics: Record<string, unknown> | null): string | null {
  if (!metrics) return null;
  const entries = Object.entries(metrics).sort(([a], [b]) => a.localeCompare(b)).slice(0, HISTORY_METRIC_KEYS_MAX);
  if (!entries.length) return null;
  return truncate(entries.map(([key, value]) => `${key}=${String(value)}`).join(";"), 2_000, "use --run for detail").value;
}

function fmt(iso: string): string {
  return iso.replace("T", " ").replace(".000Z", "Z");
}

function boundedText(value: string | null, cap = HISTORY_DETAIL_TEXT_CAP): { value: string | null; truncated: boolean; totalChars: number } {
  if (value == null) return { value: null, truncated: false, totalChars: 0 };
  return { value: value.slice(0, cap), truncated: value.length > cap, totalChars: value.length };
}

function boundedMetrics(metrics: Record<string, unknown> | null) {
  if (!metrics) return null;
  const keys = Object.keys(metrics).sort();
  const kept = keys.slice(0, HISTORY_METRIC_KEYS_MAX);
  const truncatedValues: string[] = [];
  const values = Object.fromEntries(kept.map((key) => {
    const value = metrics[key];
    if (typeof value === "string" && value.length > 1_000) {
      truncatedValues.push(key);
      return [key, value.slice(0, 1_000)];
    }
    return [key, value];
  }));
  return {
    values,
    truncated: keys.length > kept.length || truncatedValues.length > 0,
    truncatedValues,
    totalKeys: keys.length,
  };
}

function normalizedListRun(run: Run) {
  const message = boundedText(run.message ?? null, HISTORY_MESSAGE_CAP);
  const model = boundedText(run.model ?? null, HISTORY_PROFILE_VALUE_CAP);
  const reasoningEffort = boundedText(run.reasoningEffort ?? null, HISTORY_PROFILE_VALUE_CAP);
  return {
    id: run.id,
    runIndex: run.runIndex!,
    terminalAt: run.ts,
    role: run.role,
    requestedBy: run.requestedBy,
    phase: run.phase,
    status: run.status ?? null,
    result: resultToken(run),
    durationMs: run.durationMs ?? null,
    usage: run.usage ?? null,
    metrics: boundedMetrics(run.metrics ?? null),
    agent: run.agent ?? null,
    model: model.value,
    modelTruncated: model.truncated,
    reasoningEffort: reasoningEffort.value,
    reasoningEffortTruncated: reasoningEffort.truncated,
    sessionId: run.sessionId ?? null,
    message: message.value,
    messageTruncated: message.truncated,
    messageTotalChars: message.totalChars,
  };
}

function jsonText(value: unknown): string | undefined {
  const text = JSON.stringify(value, null, 2);
  return Buffer.byteLength(text, "utf8") <= HISTORY_JSON_TEXT_CAP ? text : undefined;
}

function response(_value: unknown, text: string, channel: Record<string, unknown> = {}): HttpResult {
  const body = { ...channel, text };
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > HISTORY_JSON_TEXT_CAP) {
    return { status: 413, body: { error: `history response exceeds ${HISTORY_JSON_TEXT_CAP} bytes; narrow the window` } };
  }
  return { status: 200, body };
}

async function listHistory(loop: Loop, q: HistoryQuery): Promise<HttpResult> {
  const conditions = [
    ...windowConditions(loop.id, q),
    q.role ? eq(runs.role, q.role) : undefined,
    q.status ? eq(runs.status, q.status) : undefined,
    q.phase ? eq(runs.phase, q.phase) : undefined,
  ];
  const [rows, counted, through] = await Promise.all([
    db.select().from(runs).where(and(...conditions)).orderBy(desc(runs.runIndex)).limit(q.limit),
    db.select({ n: sql<number>`count(*)` }).from(runs).where(and(...conditions)),
    selectedThrough(loop.id, q),
  ]);
  const normalized = rows.map(normalizedListRun);
  const data = { loop: { id: loop.id, name: loop.name ?? loop.id }, through, count: normalized.length, total: Number(counted[0]?.n ?? 0), runs: normalized };
  if (q.json) {
    const text = jsonText(data);
    return text ? response(data, text, { runs: normalized }) : { status: 413, body: { error: "history JSON exceeds the response cap; lower --limit" } };
  }
  const table = rows.length
    ? listBlock("runs", ["index", "terminal", "role", "result", "durationMs", "usage", "metrics", "agent", "session", "message"], rows.map((run) => [
        run.runIndex!, fmt(run.ts), run.role, resultToken(run), run.durationMs ?? null, compactUsage(run.usage ?? null),
        compactMetrics(run.metrics ?? null), run.agent ?? null, run.sessionId ?? null,
        run.message ? truncate(run.message, HISTORY_MESSAGE_CAP, "use --run for detail").value : null,
      ]))
    : emptyList("runs");
  return response(data, doc(
    `loop: ${scalar(loop.name ?? loop.id)} (${loop.id})`,
    `through: ${scalar(through)}`,
    `count: ${rows.length} of ${Number(counted[0]?.n ?? 0)} matching`,
    table,
    helpBlock(["Use `pievo log --summary` for aggregates", "Use `pievo log --run <index>` for one run"]),
  ), { runs: normalized });
}

type SummaryRun = Pick<Run,
  "runIndex" | "ts" | "role" | "phase" | "status" | "durationMs" | "usage" |
  "metrics" | "agent" | "model" | "reasoningEffort"
>;

const SUMMARY_COLUMNS = {
  runIndex: runs.runIndex,
  ts: runs.ts,
  role: runs.role,
  phase: runs.phase,
  status: runs.status,
  durationMs: runs.durationMs,
  usage: runs.usage,
  metrics: runs.metrics,
  agent: runs.agent,
  model: runs.model,
  reasoningEffort: runs.reasoningEffort,
};

type NumberStat = { total: number; average: number; samples: number };
interface UsageStat {
  runSamples: number;
  inputTokens: NumberStat | null;
  outputTokens: NumberStat | null;
  cacheReadTokens: NumberStat | null;
  cacheCreationTokens: NumberStat | null;
}

function numberStat(values: number[]): NumberStat | null {
  if (!values.length) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return { total, average: total / values.length, samples: values.length };
}

const usageKeys: Array<keyof RunUsage> = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"];
function usageStat(rows: SummaryRun[]): UsageStat {
  const withUsage = rows.filter((run) => run.usage && usageKeys.some((key) => run.usage?.[key] !== undefined));
  return Object.assign({ runSamples: withUsage.length }, Object.fromEntries(usageKeys.map((key) => [
    key,
    numberStat(withUsage.flatMap((run) => typeof run.usage?.[key] === "number" ? [run.usage[key]!] : [])),
  ]))) as unknown as UsageStat;
}

function durationStat(rows: SummaryRun[]): NumberStat | null {
  return numberStat(rows.flatMap((run) => typeof run.durationMs === "number" ? [run.durationMs] : []));
}

function countBy<T extends string>(values: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

function boundedCounts(counts: Record<string, number>) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const kept = entries.slice(0, HISTORY_PROFILE_KEYS_MAX);
  return {
    counts: Object.fromEntries(kept),
    other: entries.slice(HISTORY_PROFILE_KEYS_MAX).reduce((sum, [, n]) => sum + n, 0),
    truncated: entries.length > HISTORY_PROFILE_KEYS_MAX,
  };
}

function profileKey(value: string | null): string {
  return (value ?? "default").slice(0, 128);
}

async function summaryHistory(loop: Loop, q: HistoryQuery): Promise<HttpResult> {
  const [selectedCount, openNow] = await Promise.all([
    db.select({ n: sql<number>`count(*)` }).from(runs)
      .where(and(...windowConditions(loop.id, q), beforeLowestIndexedOpen(loop.id))),
    db.select({ n: sql<number>`count(*)` }).from(runs).where(and(eq(runs.loopId, loop.id), inArray(runs.phase, ["pending", "running"]))),
  ]);
  if (Number(selectedCount[0]?.n ?? 0) > HISTORY_SUMMARY_ROWS_MAX) {
    return { status: 413, body: { error: `history summary includes more than ${HISTORY_SUMMARY_ROWS_MAX} runs; narrow it with --after or --since` } };
  }
  // Do not materialize potentially large metrics JSON until the cheap row-count
  // preflight proves the requested aggregate is within its work budget.
  const rows: SummaryRun[] = await db.select(SUMMARY_COLUMNS).from(runs)
    .where(and(...windowConditions(loop.id, q), beforeLowestIndexedOpen(loop.id)))
    .orderBy(asc(runs.runIndex))
    .limit(HISTORY_SUMMARY_ROWS_MAX + 1);
  if (rows.length > HISTORY_SUMMARY_ROWS_MAX) {
    return { status: 413, body: { error: `history summary includes more than ${HISTORY_SUMMARY_ROWS_MAX} runs; narrow it with --after or --since` } };
  }
  const through = rows.at(-1)?.runIndex ?? null;
  const byRole = Object.fromEntries(ROLES.map((role) => [role, rows.filter((run) => run.role === role).length]));
  const phases = Object.fromEntries(TERMINAL_PHASES.map((phase) => [phase, rows.filter((run) => run.phase === phase).length]));
  const reportedStatusByRole = Object.fromEntries(ROLES.map((role) => [role, Object.fromEntries(STATUSES.map((status) => [status, rows.filter((run) => run.role === role && run.status === status).length]))]));
  const latestTerminalIndexByRole = Object.fromEntries(ROLES.map((role) => [role, rows.filter((run) => run.role === role).at(-1)?.runIndex ?? null]));
  let execNoChangeStreak = 0;
  for (const run of rows.slice().reverse()) {
    if (run.role !== "exec") continue;
    if (run.status !== "no-change") break;
    execNoChangeStreak++;
  }

  const metricKeys = [...new Set(rows.flatMap((run) => Object.keys(run.metrics ?? {})))].sort();
  const keptMetricKeys = metricKeys.slice(0, HISTORY_METRIC_KEYS_MAX);
  const metrics = Object.fromEntries(keptMetricKeys.map((key) => {
    const samples = rows.flatMap((run) => {
      const value = run.metrics?.[key];
      return typeof value === "number" && Number.isFinite(value) ? [{ runIndex: run.runIndex!, value }] : [];
    });
    const values = samples.map((sample) => sample.value);
    const total = values.reduce((sum, value) => sum + value, 0);
    return [key, {
      samples: values.length,
      first: samples[0] ?? null,
      latest: samples.at(-1) ?? null,
      min: values.length ? Math.min(...values) : null,
      max: values.length ? Math.max(...values) : null,
      average: values.length ? total / values.length : null,
    }];
  }));

  const executed = rows.filter((run) => run.agent != null);
  const summary = {
    loop: { id: loop.id, name: loop.name ?? loop.id, createdAt: loop.createdAt, goal: loop.goal ?? null },
    window: { after: q.after ?? null, through: q.through ?? null, since: q.since ?? null, until: q.until ?? null },
    through,
    firstTerminal: rows[0] ? { runIndex: rows[0].runIndex!, at: rows[0].ts } : null,
    lastTerminal: rows.at(-1) ? { runIndex: rows.at(-1)!.runIndex!, at: rows.at(-1)!.ts } : null,
    total: rows.length,
    byRole,
    phases,
    reportedStatusByRole,
    openNow: Number(openNow[0]?.n ?? 0),
    execNoChangeStreak,
    duration: {
      overall: durationStat(rows),
      byRole: Object.fromEntries(ROLES.map((role) => [role, durationStat(rows.filter((run) => run.role === role))])),
      execByStatus: Object.fromEntries(["kept", "no-change"].map((status) => [status, durationStat(rows.filter((run) => run.role === "exec" && run.status === status))])),
    },
    usage: {
      overall: usageStat(rows),
      byRole: Object.fromEntries(ROLES.map((role) => [role, usageStat(rows.filter((run) => run.role === role))])),
      execByStatus: Object.fromEntries(["kept", "no-change"].map((status) => [status, usageStat(rows.filter((run) => run.role === "exec" && run.status === status))])),
    },
    metrics: { values: metrics, totalKeys: metricKeys.length, truncated: metricKeys.length > keptMetricKeys.length },
    executionProfiles: {
      samples: executed.length,
      agent: boundedCounts(countBy(executed.map((run) => run.agent!))),
      model: boundedCounts(countBy(executed.map((run) => profileKey(run.model ?? null)))),
      reasoningEffort: boundedCounts(countBy(executed.map((run) => profileKey(run.reasoningEffort ?? null)))),
    },
    latestTerminalIndexByRole,
  };
  const json = jsonText(summary);
  if (!json) return { status: 413, body: { error: "history summary exceeds the response cap; narrow the window" } };
  if (q.json) return response(summary, json, { summary });
  const text = detailBlock("summary", [
    ["loop", `${loop.name ?? loop.id} (${loop.id})`],
    ["createdAt", loop.createdAt], ["goal", loop.goal ?? null], ["through", through],
    ["firstTerminal", summary.firstTerminal ? `${summary.firstTerminal.runIndex}@${summary.firstTerminal.at}` : null],
    ["lastTerminal", summary.lastTerminal ? `${summary.lastTerminal.runIndex}@${summary.lastTerminal.at}` : null],
    ["total", summary.total], ["openNow", summary.openNow], ["execNoChangeStreak", execNoChangeStreak],
    ["byRole", { raw: JSON.stringify(byRole) }], ["phases", { raw: JSON.stringify(phases) }],
    ["reportedStatusByRole", { raw: JSON.stringify(reportedStatusByRole) }],
    ["duration", { raw: JSON.stringify(summary.duration) }], ["usage", { raw: JSON.stringify(summary.usage) }],
    ["metrics", { raw: JSON.stringify(summary.metrics) }], ["executionProfiles", { raw: JSON.stringify(summary.executionProfiles) }],
    ["latestTerminalIndexByRole", { raw: JSON.stringify(latestTerminalIndexByRole) }],
  ]);
  return response(summary, text, { summary });
}

async function boundedDiff(runId: string) {
  const raw = await computeRunDiff(runId, {
    maxFiles: HISTORY_DIFF_FILES_MAX,
    maxInputBytes: HISTORY_DIFF_INPUT_BYTES_MAX,
    maxDiffChars: HISTORY_DIFF_TEXT_CAP,
  });
  if (!raw.hasSnapshot) return { included: true, available: false, reason: "snapshot-unavailable", truncated: false, files: [] };
  return {
    included: true,
    available: true,
    reason: null,
    truncated: raw.truncated ?? false,
    totalFiles: raw.totalFiles ?? raw.files.length,
    truncation: raw.truncation,
    work: raw.work,
    files: raw.files,
  };
}

async function detailHistory(loop: Loop, q: HistoryQuery): Promise<HttpResult> {
  const selector = typeof q.run === "number" ? eq(runs.runIndex, q.run) : eq(runs.id, q.run!);
  const run = (await db.select().from(runs).where(and(eq(runs.loopId, loop.id), selector)).limit(1))[0];
  if (!run) return { status: 404, body: { error: "no such run in this loop" } };
  const snapshot = await store.getRunSnapshot(run.id);
  const requestText = boundedText(run.requestText ?? null);
  const message = boundedText(run.message ?? null);
  const error = boundedText(run.error ?? null);
  const finalText = boundedText(run.finalText ?? null);
  const model = boundedText(run.model ?? null, HISTORY_PROFILE_VALUE_CAP);
  const reasoningEffort = boundedText(run.reasoningEffort ?? null, HISTORY_PROFILE_VALUE_CAP);
  const control = (run.control ?? []).slice(0, HISTORY_CONTROL_ACTIONS_MAX).map((action) => ({
    ...action,
    args: boundedText(JSON.stringify(action.args), HISTORY_CONTROL_ARGS_CAP),
  }));
  const detail = {
    identity: { id: run.id, runIndex: run.runIndex ?? null, loopId: run.loopId, role: run.role, requestedBy: run.requestedBy, requestText: requestText.value },
    timestamps: { createdAt: run.createdAt, updatedAt: run.updatedAt, terminalAt: TERMINAL_PHASES.includes(run.phase as typeof TERMINAL_PHASES[number]) ? run.ts : null, phaseAt: run.ts, heartbeatAt: run.heartbeatAt ?? null, cancelRequestedAt: run.cancelRequestedAt ?? null },
    execution: { agent: run.agent ?? null, model: model.value, reasoningEffort: reasoningEffort.value, sessionId: run.sessionId ?? null, durationMs: run.durationMs ?? null, exitCode: run.exitCode ?? null, usage: run.usage ?? null },
    outcome: { phase: run.phase, status: run.status ?? null, result: resultToken(run), message: message.value, error: error.value, finalText: finalText.value },
    truncation: { requestText, message, error, finalText, model, reasoningEffort },
    metrics: boundedMetrics(run.metrics ?? null),
    control,
    controlTruncated: (run.control?.length ?? 0) > HISTORY_CONTROL_ACTIONS_MAX,
    reportIncident: run.reportIncident ?? null,
    diffAvailable: !!snapshot,
    diff: q.diff ? await boundedDiff(run.id) : { included: false, available: !!snapshot },
  };
  const json = jsonText(detail);
  if (!json) return { status: 413, body: { error: "run detail exceeds the response cap" } };
  if (q.json) return response(detail, json, { run: detail });
  const text = detailBlock("run", [
    ["index", run.runIndex ?? null], ["id", run.id], ["role", run.role], ["requestedBy", run.requestedBy],
    ["phase", run.phase], ["status", run.status ?? null], ["terminalAt", detail.timestamps.terminalAt],
    ["agent", run.agent ?? null], ["model", detail.execution.model], ["reasoningEffort", detail.execution.reasoningEffort],
    ["durationMs", run.durationMs ?? null], ["usage", { raw: JSON.stringify(run.usage ?? null) }],
    ["metrics", { raw: JSON.stringify(detail.metrics) }], ["session", run.sessionId ?? null],
    ["message", detail.outcome.message], ["error", detail.outcome.error], ["finalText", detail.outcome.finalText],
    ["truncation", { raw: JSON.stringify(detail.truncation) }],
    ["control", { raw: JSON.stringify(detail.control) }], ["reportIncident", { raw: JSON.stringify(detail.reportIncident) }],
    ["diffAvailable", detail.diffAvailable], ["diff", { raw: JSON.stringify(detail.diff) }],
  ]);
  return response(detail, text, { run: detail });
}

/** Deep history seam. The caller supplies one already-authorized loop; parsing,
 * window semantics, aggregation, detail/diff caps, and rendering stay local. */
export async function readLoopHistory(loop: Loop, flags: Flags): Promise<HttpResult> {
  const parsed = parseHistoryFlags(flags);
  if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
  switch (parsed.value.mode) {
    case "summary": return summaryHistory(loop, parsed.value);
    case "detail": return detailHistory(loop, parsed.value);
    case "list": return listHistory(loop, parsed.value);
  }
}

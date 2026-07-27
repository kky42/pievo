import { and, desc, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";

import { db } from "../db/index.js";
import { runs, type Loop, type Run, type RunUsage } from "../db/schema.js";
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
export const HISTORY_JSON_TEXT_CAP = 512 * 1024;

const TERMINAL_PHASES = ["done", "error", "canceled"] as const;
const STATUSES = ["keep", "no-change", "block"] as const;
const LOG_FLAGS = new Set(["_", "loop", "help", "run", "diff", "since", "until", "status", "phase", "limit", "json"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Flags = Record<string, string | boolean | undefined>;
type HistoryQuery = {
  mode: "list" | "detail";
  json: boolean;
  diff: boolean;
  run?: number | string;
  since?: string;
  until?: string;
  status?: "keep" | "no-change" | "block";
  phase?: "done" | "error" | "canceled";
  limit: number;
};
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

function iso(name: string, value: unknown): string | undefined | { error: string } {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) {
    return { error: `--${name} must be an ISO timestamp` };
  }
  return new Date(value).toISOString();
}

export function parseHistoryFlags(flags: Flags): Parsed {
  const unknown = Object.keys(flags).filter((key) => !LOG_FLAGS.has(key));
  if (unknown.length) return { ok: false, error: `pievo: unknown flag --${unknown[0]} for log` };

  const limit = positiveInt("limit", flags.limit, HISTORY_LIMIT_MAX);
  if (typeof limit === "string") return { ok: false, error: limit };
  const since = iso("since", flags.since);
  if (since && typeof since === "object") return { ok: false, error: since.error };
  const until = iso("until", flags.until);
  if (until && typeof until === "object") return { ok: false, error: until.error };
  if (since !== undefined && until !== undefined && since > until) return { ok: false, error: "--since must not be after --until" };

  const status = flags.status;
  if (status !== undefined && (typeof status !== "string" || !(STATUSES as readonly string[]).includes(status))) {
    return { ok: false, error: "--status must be keep|no-change|block" };
  }
  const phase = flags.phase;
  if (phase !== undefined && (typeof phase !== "string" || !(TERMINAL_PHASES as readonly string[]).includes(phase))) {
    return { ok: false, error: "--phase must be done|error|canceled" };
  }

  const runRaw = flags.run;
  if (bool(flags.diff) && runRaw === undefined) return { ok: false, error: "--diff requires --run" };
  if (runRaw !== undefined && (since !== undefined || until !== undefined || status !== undefined || phase !== undefined || flags.limit !== undefined)) {
    return { ok: false, error: "--run cannot be combined with time windows, list filters, or --limit" };
  }
  let run: number | string | undefined;
  if (runRaw !== undefined) {
    if (typeof runRaw !== "string") return { ok: false, error: "--run needs a run index or full UUID" };
    if (/^\d+$/.test(runRaw)) {
      const parsed = positiveInt("run", runRaw);
      if (typeof parsed !== "number") return { ok: false, error: typeof parsed === "string" ? parsed : "--run needs a run index" };
      run = parsed;
    } else if (UUID.test(runRaw)) run = runRaw;
    else return { ok: false, error: "--run needs a positive run index or full UUID" };
  }

  return {
    ok: true,
    value: {
      mode: run === undefined ? "list" : "detail",
      json: bool(flags.json),
      diff: bool(flags.diff),
      ...(run !== undefined ? { run } : {}),
      ...(since !== undefined ? { since } : {}),
      ...(until !== undefined ? { until } : {}),
      ...(status !== undefined ? { status: status as HistoryQuery["status"] } : {}),
      ...(phase !== undefined ? { phase: phase as HistoryQuery["phase"] } : {}),
      limit: limit ?? 10,
    },
  };
}

function totalTokenUsage(usage: RunUsage | null): number | null {
  if (!usage || (usage.inputTokens === undefined && usage.outputTokens === undefined)) return null;
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

function fmt(iso: string): string {
  return iso.replace("T", " ").replace(".000Z", "Z");
}

function boundedText(value: string | null, cap = HISTORY_DETAIL_TEXT_CAP): { value: string | null; truncated: boolean } {
  if (value == null) return { value: null, truncated: false };
  return { value: value.slice(0, cap), truncated: value.length > cap };
}

function normalizedListRun(run: Run) {
  const message = boundedText(run.message ?? null, HISTORY_MESSAGE_CAP);
  return {
    runIndex: run.runIndex!,
    terminalAt: run.ts,
    phase: run.phase,
    status: run.status ?? null,
    durationMs: run.durationMs ?? null,
    tokenUsage: totalTokenUsage(run.usage ?? null),
    message: message.value,
    messageTruncated: message.truncated,
    finalTextAvailable: !!run.finalText?.trim(),
  };
}

function jsonText(value: unknown): string | undefined {
  const text = JSON.stringify(value, null, 2);
  return Buffer.byteLength(text, "utf8") <= HISTORY_JSON_TEXT_CAP ? text : undefined;
}

function response(text: string, channel: Record<string, unknown> = {}): HttpResult {
  const body = { ...channel, text };
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > HISTORY_JSON_TEXT_CAP) {
    return { status: 413, body: { error: `history response exceeds ${HISTORY_JSON_TEXT_CAP} bytes; narrow the window` } };
  }
  return { status: 200, body };
}

async function listHistory(loop: Loop, q: HistoryQuery): Promise<HttpResult> {
  const conditions = [
    eq(runs.loopId, loop.id),
    isNotNull(runs.runIndex),
    inArray(runs.phase, [...TERMINAL_PHASES]),
    q.since ? gte(runs.ts, q.since) : undefined,
    q.until ? lte(runs.ts, q.until) : undefined,
    q.status ? eq(runs.status, q.status) : undefined,
    q.phase ? eq(runs.phase, q.phase) : undefined,
  ];
  const [rows, counted] = await Promise.all([
    db.select().from(runs).where(and(...conditions)).orderBy(desc(runs.runIndex)).limit(q.limit),
    db.select({ n: sql<number>`count(*)` }).from(runs).where(and(...conditions)),
  ]);
  const normalized = rows.map(normalizedListRun);
  const data = { count: normalized.length, total: Number(counted[0]?.n ?? 0), runs: normalized };
  if (q.json) {
    const text = jsonText(data);
    return text ? response(text) : { status: 413, body: { error: "history JSON exceeds the response cap; lower --limit" } };
  }
  const table = rows.length
    ? listBlock("runs", ["index", "terminal", "phase", "status", "durationMs", "tokenUsage", "message", "finalTextAvailable"], rows.map((run) => [
        run.runIndex!, fmt(run.ts), run.phase, run.status ?? null, run.durationMs ?? null, totalTokenUsage(run.usage ?? null),
        run.message ? truncate(run.message, HISTORY_MESSAGE_CAP, "use --run for detail").value : null,
        !!run.finalText?.trim(),
      ]))
    : emptyList("runs");
  return response(doc(
    `loop: ${scalar(loop.name)} (${loop.id})`,
    `count: ${rows.length} of ${Number(counted[0]?.n ?? 0)} matching`,
    table,
    helpBlock(["Use `pievo log --run <index>` for one run"]),
  ));
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
  const message = boundedText(run.message ?? null);
  const error = boundedText(run.error ?? null);
  const finalText = boundedText(run.finalText ?? null);
  const detail = {
    runIndex: run.runIndex ?? null,
    terminalAt: TERMINAL_PHASES.includes(run.phase as typeof TERMINAL_PHASES[number]) ? run.ts : null,
    phase: run.phase,
    status: run.status ?? null,
    durationMs: run.durationMs ?? null,
    tokenUsage: totalTokenUsage(run.usage ?? null),
    message: message.value,
    messageTruncated: message.truncated,
    error: error.value,
    errorTruncated: error.truncated,
    finalText: finalText.value,
    finalTextTruncated: finalText.truncated,
    diffAvailable: !!snapshot,
    diff: q.diff ? await boundedDiff(run.id) : { included: false, available: !!snapshot },
  };
  const json = jsonText(detail);
  if (!json) return { status: 413, body: { error: "run detail exceeds the response cap" } };
  if (q.json) return response(json);
  return response(detailBlock("run", [
    ["index", detail.runIndex], ["terminalAt", detail.terminalAt], ["phase", detail.phase], ["status", detail.status],
    ["durationMs", detail.durationMs], ["tokenUsage", detail.tokenUsage], ["message", detail.message],
    ["messageTruncated", detail.messageTruncated], ["error", detail.error], ["errorTruncated", detail.errorTruncated],
    ["finalText", detail.finalText], ["finalTextTruncated", detail.finalTextTruncated],
    ["diffAvailable", detail.diffAvailable], ["diff", { raw: JSON.stringify(detail.diff) }],
  ]));
}

/** Authorized owner history: bounded ordinary terminal list or one run detail. */
export async function readLoopHistory(loop: Loop, flags: Flags): Promise<HttpResult> {
  const parsed = parseHistoryFlags(flags);
  if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
  return parsed.value.mode === "detail" ? detailHistory(loop, parsed.value) : listHistory(loop, parsed.value);
}

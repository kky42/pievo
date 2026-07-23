import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { boundedFetch } from "./http.js";

export type TerminalResult = "success" | "failure" | "canceled" | "timeout";
export interface TerminalReport {
  reportId: string;
  runId: string;
  result: TerminalResult;
  durationMs: number;
  exitCode: number | null;
  message?: string;
  sessionId?: string;
  usage?: unknown;
  taskFileContent?: string;
  error?: string;
  finalText?: string;
}

export interface PersistedReport {
  reportId: string;
  runId: string;
  runToken: string;
  payloadJson: string;
  payloadDigest: string;
  createdAt: number;
  attemptCount: number;
  nextAttemptAt: number;
  lastError?: string;
}

export type ReportAck =
  | { kind: "ack"; reportId: string }
  | { kind: "retired"; reportId: string }
  | { kind: "conflict"; reportId: string; error: string }
  | { kind: "invalid"; reportId: string; error: string }
  | { kind: "retry"; reportId: string; error: string };

const POISON_PREFIXES = ["REPORT_CONFLICT:", "REPORT_INVALID:"] as const;
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

/** Durable terminal-report outbox. Rows are independent so one slow or poisoned
 * report never caps execution/reporting for other loops. The database lives under
 * PIEVO_HOME, outside loop roots, and is owner-only even with a permissive umask. */
export class PendingReportOutbox {
  private readonly db: DatabaseSync;

  constructor(readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(file), 0o700);
    this.db = new DatabaseSync(file);
    fs.chmodSync(file, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS pending_reports (report_id TEXT PRIMARY KEY, run_id TEXT UNIQUE NOT NULL, run_token TEXT NOT NULL, payload_json TEXT NOT NULL, payload_digest TEXT NOT NULL, created_at INTEGER NOT NULL, attempt_count INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL, last_error TEXT NULL)");
    for (const suffix of ["-wal", "-shm"]) {
      const p = file + suffix;
      if (fs.existsSync(p)) fs.chmodSync(p, 0o600);
    }
  }

  put(runToken: string, payload: TerminalReport, now = Date.now()): PersistedReport {
    const payloadJson = JSON.stringify(payload);
    const payloadDigest = createHash("sha256").update(payloadJson).digest("hex");
    const existing = this.db.prepare("SELECT payload_digest FROM pending_reports WHERE report_id=?").get(payload.reportId) as { payload_digest: string } | undefined;
    if (existing) {
      if (existing.payload_digest !== payloadDigest) throw new Error(`local reportId conflict: ${payload.reportId}`);
      return this.get(payload.reportId)!;
    }
    this.db.prepare("INSERT INTO pending_reports (report_id,run_id,run_token,payload_json,payload_digest,created_at,attempt_count,next_attempt_at,last_error) VALUES (?,?,?,?,?,?,0,?,NULL)")
      .run(payload.reportId, payload.runId, runToken, payloadJson, payloadDigest, now, now);
    return this.get(payload.reportId)!;
  }

  private decode(row: Record<string, unknown>): PersistedReport {
    return {
      reportId: String(row.report_id), runId: String(row.run_id), runToken: String(row.run_token),
      payloadJson: String(row.payload_json), payloadDigest: String(row.payload_digest),
      createdAt: Number(row.created_at), attemptCount: Number(row.attempt_count), nextAttemptAt: Number(row.next_attempt_at),
      ...(row.last_error == null ? {} : { lastError: String(row.last_error) }),
    };
  }

  get(reportId: string): PersistedReport | undefined {
    const row = this.db.prepare("SELECT report_id,run_id,run_token,payload_json,payload_digest,created_at,attempt_count,next_attempt_at,last_error FROM pending_reports WHERE report_id=?").get(reportId) as Record<string, unknown> | undefined;
    return row ? this.decode(row) : undefined;
  }

  all(): PersistedReport[] {
    const rows = this.db.prepare("SELECT report_id,run_id,run_token,payload_json,payload_digest,created_at,attempt_count,next_attempt_at,last_error FROM pending_reports ORDER BY created_at,report_id").all() as Record<string, unknown>[];
    return rows.map((row) => this.decode(row));
  }

  ready(now = Date.now()): PersistedReport[] {
    return this.all().filter((row) => row.nextAttemptAt <= now && !POISON_PREFIXES.some((prefix) => row.lastError?.startsWith(prefix)));
  }

  peek(): PersistedReport | undefined { return this.all()[0]; }

  applyAck(ack: ReportAck, now = Date.now()): void {
    const row = this.get(ack.reportId);
    if (!row) return;
    if (ack.kind === "ack" || ack.kind === "retired") {
      this.db.prepare("DELETE FROM pending_reports WHERE report_id=?").run(row.reportId);
      return;
    }
    if (ack.kind === "conflict" || ack.kind === "invalid") {
      const code = ack.kind === "conflict" ? "REPORT_CONFLICT" : "REPORT_INVALID";
      this.db.prepare("UPDATE pending_reports SET last_error=? WHERE report_id=?").run(`${code}: ${ack.error}`, row.reportId);
      return;
    }
    const attempts = row.attemptCount + 1;
    const delay = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)];
    this.db.prepare("UPDATE pending_reports SET attempt_count=?,next_attempt_at=?,last_error=? WHERE report_id=?")
      .run(attempts, now + delay, ack.error, row.reportId);
  }

  diagnostics(): { pendingRunIds: string[]; poisonedRunIds: string[]; lastError?: string } {
    const rows = this.all();
    const poisoned = rows.filter((row) => POISON_PREFIXES.some((prefix) => row.lastError?.startsWith(prefix)));
    const first = rows[0];
    return {
      pendingRunIds: rows.map((row) => row.runId),
      poisonedRunIds: poisoned.map((row) => row.runId),
      ...(first?.lastError ? { lastError: first.lastError } : {}),
    };
  }

  close(): void { this.db.close(); }
}

export function readReportDiagnostics(file: string): { pendingRunIds: string[]; poisonedRunIds: string[]; lastError?: string } {
  if (!fs.existsSync(file)) return { pendingRunIds: [], poisonedRunIds: [] };
  try {
    const box = new PendingReportOutbox(file);
    const result = box.diagnostics();
    box.close();
    return result;
  } catch (err) {
    return { pendingRunIds: [], poisonedRunIds: [], lastError: `could not read report outbox: ${err instanceof Error ? err.message : String(err)}` };
  }
}

const REPORT_TIMEOUT_MS = 60_000;
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** One report transport attempt. Only definitive, report-id-bound responses can
 * tell the outbox to delete. Every ambiguous response remains retryable. */
export async function sendTerminalReport(
  serverUrl: string,
  report: PersistedReport,
  fetchImpl?: FetchLike,
  signal?: AbortSignal,
): Promise<ReportAck> {
  try {
    const fetcher = fetchImpl ?? ((url: string, init: RequestInit) => boundedFetch(url, init, REPORT_TIMEOUT_MS, signal));
    const res = await fetcher(`${serverUrl.replace(/\/$/, "")}/machine/report`, {
      method: "POST",
      headers: { Authorization: `Bearer ${report.runToken}`, "Content-Type": "application/json" },
      body: report.payloadJson,
    });
    let body: { reportId?: unknown; code?: unknown; issues?: unknown; accepted?: unknown; payloadDigest?: unknown; disposition?: unknown } = {};
    try { body = await res.json() as typeof body; } catch { /* malformed is ambiguous */ }
    if (body.reportId === report.reportId && res.status === 409 && body.code === "REPORT_CONFLICT") {
      return { kind: "conflict", reportId: report.reportId, error: "server rejected a different payload for this reportId" };
    }
    if (body.reportId === report.reportId && res.status === 422 && body.code === "REPORT_INVALID") {
      const issues = Array.isArray(body.issues) ? body.issues.filter((issue): issue is string => typeof issue === "string").join("; ") : "invalid terminal payload";
      return { kind: "invalid", reportId: report.reportId, error: issues };
    }
    if (body.reportId === report.reportId && res.status === 410 && body.code === "RETIRED") return { kind: "retired", reportId: report.reportId };
    if (res.ok && body.reportId === report.reportId) {
      // A handled rejection is a terminal transport ACK, not acceptance of the
      // claimed result. Bind it to the exact durable bytes; tolerate additive
      // response fields, but never clear the row for another payload/disposition.
      if (body.accepted === false && (
        body.payloadDigest !== report.payloadDigest ||
        (body.disposition !== "run-error" && body.disposition !== "telemetry-rejected")
      )) return { kind: "retry", reportId: report.reportId, error: "ambiguous handled-report acknowledgement" };
      return { kind: "ack", reportId: report.reportId };
    }
    return { kind: "retry", reportId: report.reportId, error: `ambiguous report response (${res.status})` };
  } catch (err) {
    return { kind: "retry", reportId: report.reportId, error: err instanceof Error ? err.message : String(err) };
  }
}

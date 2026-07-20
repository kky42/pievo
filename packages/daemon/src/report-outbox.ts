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
  [key: string]: unknown;
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
  | { kind: "retry"; error: string };

const POISON_PREFIXES = ["REPORT_CONFLICT:", "REPORT_INVALID:"] as const;
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

/** Durable, single-row terminal-report queue. The database lives under PIEVO_HOME,
 * outside loop roots, and is owner-only even when the caller's umask is permissive. */
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
      return this.peek()!;
    }
    this.db.prepare("INSERT INTO pending_reports (report_id,run_id,run_token,payload_json,payload_digest,created_at,attempt_count,next_attempt_at,last_error) VALUES (?,?,?,?,?,?,0,?,NULL)")
      .run(payload.reportId, payload.runId, runToken, payloadJson, payloadDigest, now, now);
    return this.peek()!;
  }

  peek(): PersistedReport | undefined {
    const row = this.db.prepare("SELECT report_id,run_id,run_token,payload_json,payload_digest,created_at,attempt_count,next_attempt_at,last_error FROM pending_reports LIMIT 1").get() as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      reportId: String(row.report_id), runId: String(row.run_id), runToken: String(row.run_token),
      payloadJson: String(row.payload_json), payloadDigest: String(row.payload_digest),
      createdAt: Number(row.created_at), attemptCount: Number(row.attempt_count), nextAttemptAt: Number(row.next_attempt_at),
      ...(row.last_error == null ? {} : { lastError: String(row.last_error) }),
    };
  }

  applyAck(ack: ReportAck, now = Date.now()): void {
    const row = this.peek();
    if (!row) return;
    if (ack.kind === "ack" || ack.kind === "retired") {
      if (ack.reportId === row.reportId) this.db.prepare("DELETE FROM pending_reports WHERE report_id=?").run(row.reportId);
      return;
    }
    if (ack.kind === "conflict" || ack.kind === "invalid") {
      if (ack.reportId !== row.reportId) return;
      const code = ack.kind === "conflict" ? "REPORT_CONFLICT" : "REPORT_INVALID";
      this.db.prepare("UPDATE pending_reports SET last_error=? WHERE report_id=?").run(`${code}: ${ack.error}`, row.reportId);
      return;
    }
    const attempts = row.attemptCount + 1;
    const delay = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)];
    this.db.prepare("UPDATE pending_reports SET attempt_count=?,next_attempt_at=?,last_error=? WHERE report_id=?")
      .run(attempts, now + delay, ack.error, row.reportId);
  }

  diagnostics(): { pendingRunId?: string; poisoned: boolean; lastError?: string } {
    const row = this.peek();
    return row ? { pendingRunId: row.runId, poisoned: POISON_PREFIXES.some((prefix) => row.lastError?.startsWith(prefix)), ...(row.lastError ? { lastError: row.lastError } : {}) } : { poisoned: false };
  }

  close(): void { this.db.close(); }
}

export function readReportDiagnostics(file: string): { pendingRunId?: string; poisoned: boolean; lastError?: string } {
  if (!fs.existsSync(file)) return { poisoned: false };
  try {
    const box = new PendingReportOutbox(file);
    const result = box.diagnostics();
    box.close();
    return result;
  } catch (err) {
    return { poisoned: false, lastError: `could not read report outbox: ${err instanceof Error ? err.message : String(err)}` };
  }
}

const REPORT_TIMEOUT_MS = 60_000;
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** One report transport attempt. Only definitive, report-id-bound responses can
 * tell the outbox to delete. Every ambiguous response remains retryable. */
export async function sendTerminalReport(serverUrl: string, report: PersistedReport, fetchImpl: FetchLike = (url, init) => boundedFetch(url, init, REPORT_TIMEOUT_MS)): Promise<ReportAck> {
  try {
    const res = await fetchImpl(`${serverUrl.replace(/\/$/, "")}/machine/report`, {
      method: "POST",
      headers: { Authorization: `Bearer ${report.runToken}`, "Content-Type": "application/json" },
      body: report.payloadJson,
    });
    let body: { reportId?: unknown; code?: unknown; issues?: unknown } = {};
    try { body = await res.json() as typeof body; } catch { /* malformed is ambiguous */ }
    if (body.reportId === report.reportId && res.status === 409 && body.code === "REPORT_CONFLICT") {
      return { kind: "conflict", reportId: report.reportId, error: "server rejected a different payload for this reportId" };
    }
    if (body.reportId === report.reportId && res.status === 422 && body.code === "REPORT_INVALID") {
      const issues = Array.isArray(body.issues) ? body.issues.filter((issue): issue is string => typeof issue === "string").join("; ") : "invalid terminal payload";
      return { kind: "invalid", reportId: report.reportId, error: issues };
    }
    if (body.reportId === report.reportId && res.status === 410 && body.code === "RETIRED") return { kind: "retired", reportId: report.reportId };
    if (res.ok && body.reportId === report.reportId) return { kind: "ack", reportId: report.reportId };
    return { kind: "retry", error: `ambiguous report response (${res.status})` };
  } catch (err) {
    return { kind: "retry", error: err instanceof Error ? err.message : String(err) };
  }
}

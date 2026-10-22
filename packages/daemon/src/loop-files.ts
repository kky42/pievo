/**
 * Loop files on the daemon side: the server-owned MEMORY.md and artifacts a run
 * may edit. Each run gets a private directory under PIEVO_HOME/runs/<runId>,
 * populated from the server before launch and read back after the provider
 * exits. The directory doubles as the upload staging area: it is removed only
 * after the terminal report is acknowledged, so the durable outbox can re-upload
 * changed files after a crash or network failure.
 *
 * Limits mirror `packages/server/src/gateway/loopFiles.ts`; the server enforces
 * them again. Change both together.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { PIEVO_DIR } from "./config.js";
import { boundedFetch } from "./http.js";

export const MEMORY_FILE = "MEMORY.md";
export const MEMORY_CHAR_CAP = 8000;
export const ARTIFACT_BYTE_CAP = 256 * 1024;
const ARTIFACT_LIMIT_LABEL = `${ARTIFACT_BYTE_CAP / 1024} KB`;
const LOOP_FILE_BYTE_CAP = Math.max(ARTIFACT_BYTE_CAP, MEMORY_CHAR_CAP * 4);
export const RUNS_DIR = path.join(PIEVO_DIR, "runs");
const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const TRANSFER_TIMEOUT_MS = 60_000;

/** A changed loop file reported to the server; its bytes stay in the run dir until ACK. */
export interface ReportedLoopFile {
  name: string;
  baseHash: string;
  hash: string;
  size: number;
}

export function validLoopFileName(name: string): boolean {
  return FILE_NAME_RE.test(name);
}

export function runDir(runId: string): string {
  if (!RUN_ID_RE.test(runId)) throw new Error(`run id is not a safe directory name: ${runId}`);
  return path.join(RUNS_DIR, runId);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function loopFileIssue(name: string, bytes: Buffer): string | undefined {
  if (bytes.includes(0)) return `${name}: binary content is not allowed`;
  if (name === MEMORY_FILE) {
    const chars = Array.from(bytes.toString("utf8")).length;
    return chars > MEMORY_CHAR_CAP ? `${name}: ${chars} characters exceeds the ${MEMORY_CHAR_CAP}-character limit` : undefined;
  }
  return bytes.length > ARTIFACT_BYTE_CAP
    ? `${name}: ${(bytes.length / 1024).toFixed(1)} KB exceeds the ${ARTIFACT_LIMIT_LABEL} limit`
    : undefined;
}

function fileUrl(serverUrl: string, name: string): string {
  return `${serverUrl.replace(/\/$/, "")}/api/machine/run-files/${encodeURIComponent(name)}`;
}

/** Download every loop file into a fresh run directory. Returns each file's
 *  starting hash, which the server later uses to detect concurrent owner edits. */
export async function prepareLoopFiles(opts: {
  serverUrl: string;
  runToken: string;
  runId: string;
  files: string[];
  fetchImpl?: typeof fetch;
}): Promise<{ dir: string; baseHashes: Map<string, string> }> {
  const dir = runDir(opts.runId);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const baseHashes = new Map<string, string>();
  for (const name of opts.files) {
    if (!validLoopFileName(name)) throw new Error(`invalid loop file name: ${name}`);
    const init: RequestInit = { method: "GET", headers: { Authorization: `Bearer ${opts.runToken}` } };
    const res = opts.fetchImpl
      ? await opts.fetchImpl(fileUrl(opts.serverUrl, name), init)
      : await boundedFetch(fileUrl(opts.serverUrl, name), init, TRANSFER_TIMEOUT_MS);
    if (!res.ok) throw new Error(`could not download loop file ${name} (HTTP ${res.status})`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const hash = sha256(bytes);
    if (res.headers.get("x-pievo-sha256") !== hash) throw new Error(`loop file ${name} failed its integrity check`);
    fs.writeFileSync(path.join(dir, name), bytes, { mode: 0o600 });
    baseHashes.set(name, hash);
  }
  return { dir, baseHashes };
}

/** Read back the run's loop files. Unchanged and missing files are skipped (a
 *  deleted file keeps its previous version); over-limit and non-regular files
 *  become notices. A canceled or timed-out provider was killed mid-edit, so its
 *  changes are reported only as discarded. */
export function collectLoopFiles(
  dir: string,
  baseHashes: Map<string, string>,
  discardReason?: string,
): { files: ReportedLoopFile[]; notices: string[] } {
  const files: ReportedLoopFile[] = [];
  const notices: string[] = [];
  for (const [name, baseHash] of baseHashes) {
    const file = path.join(dir, name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(file);
    } catch (err) {
      // A missing file keeps its previous version; any other inspection failure
      // must still produce a terminal report instead of stranding the run.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      notices.push(`${name}: could not be inspected; the previous version was kept`);
      continue;
    }
    if (!stat.isFile()) {
      notices.push(`${name}: not a regular file; the previous version was kept`);
      continue;
    }
    if (stat.size > LOOP_FILE_BYTE_CAP) {
      notices.push(`${name}: ${(stat.size / 1024).toFixed(1)} KB exceeds the ${name === MEMORY_FILE ? `${MEMORY_CHAR_CAP}-character` : ARTIFACT_LIMIT_LABEL} limit; the previous version was kept`);
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(file);
    } catch {
      notices.push(`${name}: could not be read; the previous version was kept`);
      continue;
    }
    const hash = sha256(bytes);
    if (hash === baseHash) continue;
    if (discardReason) {
      notices.push(`${name}: ${discardReason}; this run's edit was discarded`);
      continue;
    }
    const issue = loopFileIssue(name, bytes);
    if (issue) {
      notices.push(`${issue}; the previous version was kept`);
      continue;
    }
    files.push({ name, baseHash, hash, size: bytes.length });
  }
  return { files, notices };
}

/** Upload a report's changed files from the run dir. Missing or altered staged
 *  bytes and definitive 4xx rejections are skipped: the server then keeps the
 *  previous version and records a notice. Transport failures and 5xx are
 *  retryable so the outbox resends before the report. */
export async function uploadLoopFiles(opts: {
  serverUrl: string;
  runToken: string;
  runId: string;
  files: ReportedLoopFile[];
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  for (const file of opts.files) {
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(path.join(runDir(opts.runId), file.name));
    } catch {
      continue;
    }
    if (sha256(bytes) !== file.hash) continue;
    const init: RequestInit = {
      method: "PUT",
      headers: { Authorization: `Bearer ${opts.runToken}`, "Content-Type": "application/octet-stream", "x-pievo-sha256": file.hash },
      body: new Uint8Array(bytes),
    };
    try {
      const res = opts.fetchImpl
        ? await opts.fetchImpl(fileUrl(opts.serverUrl, file.name), init)
        : await boundedFetch(fileUrl(opts.serverUrl, file.name), init, TRANSFER_TIMEOUT_MS, opts.signal);
      if (res.status >= 500) return { ok: false, error: `loop file upload failed (HTTP ${res.status})` };
    } catch (err) {
      return { ok: false, error: `loop file upload failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return { ok: true };
}

export function removeRunDir(runId: string): void {
  try {
    fs.rmSync(runDir(runId), { recursive: true, force: true });
  } catch {
    // An unsafe id never had a directory; best-effort cleanup only.
  }
}

/** Drop run directories left by crashes, keeping those whose report is still pending. */
export function pruneRunDirs(keepRunIds: Iterable<string>): void {
  const keep = new Set(keepRunIds);
  let entries: string[];
  try {
    entries = fs.readdirSync(RUNS_DIR);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (keep.has(entry)) continue;
    try {
      fs.rmSync(path.join(RUNS_DIR, entry), { recursive: true, force: true });
    } catch {
      // Best-effort startup cleanup; a stuck directory must not block the daemon.
    }
  }
}

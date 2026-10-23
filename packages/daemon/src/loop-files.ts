/**
 * The loop's memory on the daemon side. Each run gets a private directory under
 * PIEVO_HOME/runs/<runId> holding the delivered MEMORY.md, which the agent reads
 * and may rewrite. After the provider exits the daemon reads it back; a changed
 * version travels inline in the terminal report, so the directory is removed
 * right away.
 *
 * The cap mirrors `packages/server/src/gateway/memory.ts`; the server enforces it
 * again. Change both together.
 */
import fs from "node:fs";
import path from "node:path";

import { PIEVO_DIR } from "./config.js";

export const MEMORY_FILE = "MEMORY.md";
export const MEMORY_CHAR_CAP = 8000;
/** Bytes read back at most: a code point is at most 4 bytes in UTF-8. */
const MEMORY_BYTE_CAP = MEMORY_CHAR_CAP * 4;
export const RUNS_DIR = path.join(PIEVO_DIR, "runs");
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function runDir(runId: string): string {
  if (!RUN_ID_RE.test(runId)) throw new Error(`run id is not a safe directory name: ${runId}`);
  return path.join(RUNS_DIR, runId);
}

/** Write the delivered memory into a fresh run directory and return its path. */
export function prepareMemory(runId: string, memory: string): string {
  const dir = runDir(runId);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, MEMORY_FILE), memory, { mode: 0o600 });
  return dir;
}

/** Read back the run's memory. An unchanged or deleted file keeps the previous
 *  version; an unreadable or over-limit one becomes a notice. A canceled or
 *  timed-out provider was killed mid-edit, so its change is only noted. */
export function collectMemory(
  dir: string,
  delivered: string,
  discardReason?: string,
): { memory?: string; notices: string[] } {
  const file = path.join(dir, MEMORY_FILE);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (err) {
    // Any failure other than a deleted file must still produce a terminal report.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { notices: [] };
    return { notices: [`${MEMORY_FILE}: could not be inspected; the previous version was kept`] };
  }
  if (!stat.isFile()) return { notices: [`${MEMORY_FILE}: not a regular file; the previous version was kept`] };
  if (stat.size > MEMORY_BYTE_CAP) {
    return { notices: [`${MEMORY_FILE}: ${(stat.size / 1024).toFixed(1)} KB exceeds the ${MEMORY_CHAR_CAP}-character limit; the previous version was kept`] };
  }
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { notices: [`${MEMORY_FILE}: could not be read; the previous version was kept`] };
  }
  if (text === delivered) return { notices: [] };
  if (discardReason) return { notices: [`${MEMORY_FILE}: ${discardReason}; this run's edit was discarded`] };
  if (text.includes("\0")) return { notices: [`${MEMORY_FILE}: binary content is not allowed; the previous version was kept`] };
  const chars = Array.from(text).length;
  if (chars > MEMORY_CHAR_CAP) {
    return { notices: [`${MEMORY_FILE}: ${chars} characters exceeds the ${MEMORY_CHAR_CAP}-character limit; the previous version was kept`] };
  }
  return { memory: text, notices: [] };
}

export function removeRunDir(runId: string): void {
  try {
    fs.rmSync(runDir(runId), { recursive: true, force: true });
  } catch {
    // An unsafe id never had a directory; best-effort cleanup only.
  }
}

/** Drop run directories a crash left behind. Called before any run starts. */
export function pruneRunDirs(): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(RUNS_DIR);
  } catch {
    return;
  }
  for (const entry of entries) {
    try {
      fs.rmSync(path.join(RUNS_DIR, entry), { recursive: true, force: true });
    } catch {
      // Best-effort startup cleanup; a stuck directory must not block the daemon.
    }
  }
}

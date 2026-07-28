import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { PIEVO_DIR } from "./config.js";

export const PID_FILE = path.join(PIEVO_DIR, "daemon.pid");

export type PidRecord = { pid: number; startTime: string };

/**
 * Pair the PID with its start time so an unclean exit cannot make a reused PID
 * look like our daemon. macOS and Linux both support this `ps` timestamp; using
 * the same helper for writes and checks keeps the identity comparison exact.
 */
export function processStartTime(pid: number): string | undefined {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

export function writePidFile(pid: number = process.pid): void {
  try {
    fs.mkdirSync(PIEVO_DIR, { recursive: true });
    const startTime = processStartTime(pid);
    if (!startTime) return;
    fs.writeFileSync(PID_FILE, `${pid}:${startTime}\n`, { mode: 0o600 });
  } catch {
    /* best-effort — daemon status/stop just won't see a local pid */
  }
}

export function readPidFile(): PidRecord | undefined {
  try {
    const raw = fs.readFileSync(PID_FILE, "utf8").trim();
    const sep = raw.indexOf(":");
    if (sep < 1) return undefined;
    const pid = Number(raw.slice(0, sep));
    const startTime = raw.slice(sep + 1).trim();
    return Number.isInteger(pid) && pid > 0 && startTime ? { pid, startTime } : undefined;
  } catch {
    return undefined;
  }
}

/** An exiting daemon must not clear a pidfile another daemon has since claimed. */
export function clearPidFile(onlyIfPid?: number): void {
  try {
    if (onlyIfPid !== undefined && readPidFile()?.pid !== onlyIfPid) return;
    fs.rmSync(PID_FILE, { force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * Is a process with this pid alive? `kill(pid, 0)` probes without delivering a
 * signal: it throws ESRCH when no such process exists, EPERM when the process
 * exists but is owned by someone else (still alive, so treat as running).
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export type PidCheckDeps = {
  readPid?: () => PidRecord | undefined;
  alive?: (pid: number) => boolean;
  startTime?: (pid: number) => string | undefined;
  clearPid?: () => void;
};

/** Never signal a PID unless its live start time matches the recorded identity. */
export function verifiedRunningPid(deps: PidCheckDeps = {}): number | undefined {
  const readPid = deps.readPid ?? readPidFile;
  const alive = deps.alive ?? isAlive;
  const startTime = deps.startTime ?? processStartTime;
  const clearPid = deps.clearPid ?? clearPidFile;
  const rec = readPid();
  if (rec === undefined) return undefined;
  if (!alive(rec.pid)) {
    clearPid();
    return undefined;
  }
  const live = startTime(rec.pid);
  if (live === undefined) return undefined;
  if (live !== rec.startTime) {
    clearPid();
    return undefined;
  }
  return rec.pid;
}

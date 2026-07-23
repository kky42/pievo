import fs from "node:fs";
import path from "node:path";

export type RuntimeDiagnostics = {
  protocolVersion: 3;
  currentRuns?: Array<{ runId: string; stage: "executing" | "reporting" }>;
  cancelPendingRunIds?: string[];
  persistenceError?: string;
  outboxPath?: string;
};

/** Small owner-only status file used by a separate `pievo daemon status` process. It carries
 * no credentials and is outside watched loop roots. Atomic rename avoids partial reads. */
export function writeRuntimeDiagnostics(file: string, value: RuntimeDiagnostics): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  // Reserve one small filesystem block while the disk is healthy. If a later
  // atomic temp-file write fails with ENOSPC, rewrite that existing allocation
  // in place so status can still expose the SQLite persistence failure.
  const data = JSON.stringify(value).padEnd(4096, " ");
  try {
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    if (!fs.existsSync(file)) throw error;
    const fd = fs.openSync(file, "r+");
    try {
      fs.writeSync(fd, data, 0, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
}

export function readRuntimeDiagnostics(file: string): RuntimeDiagnostics | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as RuntimeDiagnostics;
    if (value?.protocolVersion !== 3) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

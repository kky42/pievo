import fs from "node:fs";
import path from "node:path";

export type RuntimeDiagnostics = {
  protocolVersion: 2;
  currentRun?: { runId: string; stage: "executing" | "reporting" };
  cancelPending?: boolean;
  blockedRunId?: string;
};

/** Small owner-only status file used by a separate `pievo status` process. It carries
 * no credentials and is outside watched loop roots. Atomic rename avoids partial reads. */
export function writeRuntimeDiagnostics(file: string, value: RuntimeDiagnostics): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function readRuntimeDiagnostics(file: string): RuntimeDiagnostics | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as RuntimeDiagnostics;
    if (value?.protocolVersion !== 2) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

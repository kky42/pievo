/** Resolve a loop's configured execution workdir for cwd-based owner commands. */
import os from "node:os";
import path from "node:path";

/** The loop fields needed to resolve its workdir. */
export interface LoopDirSpec {
  workdir: string;
}

export function expandTilde(p: string): string {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

/** Resolve a loop's required workdir. */
export function resolveLoopDir(spec: LoopDirSpec): string {
  return path.resolve(expandTilde(spec.workdir));
}

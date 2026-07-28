import os from "node:os";
import path from "node:path";

export interface LoopDirSpec {
  workdir: string;
}

export function expandTilde(p: string): string {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

export function resolveLoopDir(spec: LoopDirSpec): string {
  return path.resolve(expandTilde(spec.workdir));
}

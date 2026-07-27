import path from "node:path";

import type { PostCliDeps } from "./cli-client.js";
import { postCli } from "./cli-client.js";
import { resolveLoopDir } from "./loopdir.js";

export interface LoopRow {
  id: string;
  name: string;
  workdir: string;
}

export type ResolveError = { error: string; code?: "NOT_FOUND" };

/** Resolve an explicit loop id/name, or infer the most specific containing workdir. */
export function resolveLoopId(
  loops: LoopRow[],
  explicit: string | undefined,
  cwd: string,
): { id: string; name: string } | ResolveError {
  if (explicit) {
    const byId = loops.find((loop) => loop.id === explicit);
    if (byId) return { id: byId.id, name: byId.name };
    const byName = loops.filter((loop) => loop.name === explicit);
    if (byName.length === 1) return { id: byName[0]!.id, name: byName[0]!.name };
    if (byName.length > 1) return { error: `"${explicit}" matches multiple loops — pass the loop id instead` };
    return { error: `no loop "${explicit}" on this machine — run \`pievo loops\` to list them`, code: "NOT_FOUND" };
  }
  if (loops.length === 0) return { error: "no loops on this machine yet" };

  const here = path.resolve(cwd);
  const matches = loops
    .map((loop) => ({ loop, dir: resolveLoopDir({ workdir: loop.workdir }) }))
    .filter(({ dir }) => here === dir || here.startsWith(dir + path.sep))
    .sort((a, b) => b.dir.length - a.dir.length);
  if (matches.length === 0) {
    return { error: "no loop workdir contains this directory — pass a loop id, e.g. `pievo log <loop-id>` (`pievo loops` lists them)" };
  }
  return { id: matches[0]!.loop.id, name: matches[0]!.loop.name };
}

export type OwnerLoopResolution =
  | { kind: "ok"; loop: { id: string; name: string } }
  | { kind: "not-configured" }
  | { kind: "network-error"; message: string }
  | { kind: "list-error"; message: string }
  | { kind: "resolve-error"; error: ResolveError };

/** List the machine's loops through the owner transport, then resolve one locally. */
export async function resolveOwnerLoop(
  explicit: string | undefined,
  cwd: string,
  cliDeps: PostCliDeps,
): Promise<OwnerLoopResolution> {
  const listed = await postCli(["loops"], cliDeps);
  if (listed.kind === "not-configured") return { kind: "not-configured" };
  if (listed.kind === "network-error") return listed;

  const data = listed.body as { loops?: LoopRow[]; error?: string };
  if (listed.status >= 400 || !data.loops) {
    return { kind: "list-error", message: data.error || `could not list loops (${listed.status})` };
  }
  const resolved = resolveLoopId(data.loops, explicit, cwd);
  return "error" in resolved
    ? { kind: "resolve-error", error: resolved }
    : { kind: "ok", loop: resolved };
}

/** Preserve the owner CLI's structured-vs-usage resolution diagnostics. */
export function renderResolveError(
  error: ResolveError,
  out: (text: string) => void,
  err: (text: string) => void,
): number {
  if (error.code) {
    out(`error: ${JSON.stringify(error.error)}\ncode: ${error.code}\n`);
    return 1;
  }
  err(`pievo: ${error.error}\n`);
  return 2;
}

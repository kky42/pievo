/**
 * Workdir-jail helpers (PIEVO_ROOTS). The daemon's env roots are the LOCAL,
 * always-enforced jail; server-sent roots may only NARROW it, never widen it —
 * every server-controlled execution workdir is checked before it is touched.
 * Configured artifact paths are additionally confined beneath that workdir. With no local
 * roots configured, behavior is unchanged (fully open — the documented default).
 */
import path from "node:path";

import { expandTilde } from "./loopdir.js";

function resolveRoot(root: string): string {
  return path.resolve(expandTilde(root));
}

export function resolveRoots(roots: string[]): string[] {
  return roots.map(resolveRoot);
}

/** Compare-only jail check against PRE-RESOLVED roots (see resolveRoots).
 *  An empty list is "no jail" — but callers gate on `roots.length` first, so
 *  empty never silently allows here. `abs` is normalized before the prefix
 *  compare: a server-sent path can carry unresolved `..` segments
 *  (`/jail/root/../../…`) that a raw lexical startsWith would wrongly admit
 *  while the OS resolves it OUTSIDE the jail. */
export function isWithinResolvedRoots(abs: string, resolvedRoots: string[]): boolean {
  const a = path.resolve(abs);
  return resolvedRoots.some((r) => a === r || a.startsWith(r + path.sep));
}

export function isWithinRoots(abs: string, roots: string[]): boolean {
  return isWithinResolvedRoots(abs, resolveRoots(roots));
}

/**
 * The jail a run must obey. Local env roots (when set) ALWAYS apply: server-sent
 * roots survive only when they sit inside a local root (narrowing); disjoint
 * server roots are ignored and the local jail stands — a hostile/compromised
 * server must never be able to widen the jail and point a run at e.g. ~/.ssh.
 * With no local roots the server's roots apply as before (fully open when
 * neither is set).
 */
export function effectiveRoots(local: string[], server: string[] | undefined): string[] {
  if (local.length === 0) return server ?? [];
  if (!server?.length) return local;
  const resolvedLocal = resolveRoots(local);
  const narrowed = server.filter((s) => isWithinResolvedRoots(resolveRoot(s), resolvedLocal));
  return narrowed.length ? narrowed : local;
}

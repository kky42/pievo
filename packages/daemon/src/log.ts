/**
 * `pievo log` — bounded terminal history and run detail.
 * Every mode, including `--json`, is rendered by the server and printed verbatim;
 * provider transcripts are not a daemon telemetry or CLI surface.
 *
 * Like `pievo loops`/`edit`, this is an owner-OUTSIDE-a-run command: it goes
 * through the shared CLI client (`postCli`), which reuses the device token + server
 * URL the daemon persisted under ~/.pievo and POSTs `{argv}` to
 * `/api/machine/cli`. No run token, no re-auth — the machine is already connected.
 *
 * An explicit `<loop>` id wins; otherwise the current working directory is
 * matched against each loop's configured workdir (`resolveLoopDir`), so running there
 * finds that loop — a CLIENT-side resolution, since the server's `log` dispatch
 * needs an explicit loop id. Every external touch is an injectable seam for tests.
 */
import path from "node:path";

import type { PostCliDeps } from "./cli-client.js";
import { postCli, printCliResponse } from "./cli-client.js";
import { resolveLoopDir } from "./loopdir.js";

export interface LoopRow {
  id: string;
  name: string;
  workdir: string;
}

export type LogDeps = {
  cwd?: () => string;
  fetchFn?: typeof fetch;
  out?: (s: string) => void;
  err?: (s: string) => void;
  // Local config — overridable so tests are isolated from the ambient ~/.pievo.
  server?: string;
  token?: string;
};

type Seams = {
  cwd: () => string;
  fetchFn: typeof fetch;
  out: (s: string) => void;
  err: (s: string) => void;
};

function seams(d: LogDeps): Seams {
  return {
    cwd: d.cwd ?? (() => process.cwd()),
    fetchFn: d.fetchFn ?? fetch,
    out: d.out ?? ((s) => process.stdout.write(s)),
    err: d.err ?? ((s) => process.stderr.write(s)),
  };
}

/** Boolean flags that never take a value — so `log --json <loop>` keeps `<loop>`
 *  as a positional instead of swallowing it as `--json`'s argument. */
const BOOL_FLAGS = new Set(["json", "diff", "help"]);
const VALUE_FLAGS = ["run", "since", "until", "status", "phase", "limit"] as const;

/** The daemon only recognizes syntax; the server owns semantic validation. */
const LOG_FLAGS = new Set([...BOOL_FLAGS, ...VALUE_FLAGS, "server-url"]);

/** `--k v` / `--k=v` pairs, bare/boolean `--flag` → true; everything else is positional. */
function parseArgs(args: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const body = a.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        // `--limit=5` — the value rides on the same token.
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const key = body;
      const next = args[i + 1];
      if (!BOOL_FLAGS.has(key) && next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

/** Resolve the loop to read: an explicit id (matched by id, else name) wins;
 * otherwise pick the loop whose workdir contains the current directory, choosing
 * the most specific nested match. Coded errors go to stdout with exit 1; ordinary
 * usage errors go to stderr with exit 2. */
export type ResolveError = { error: string; code?: "NOT_FOUND" };
export function resolveLoopId(
  loops: LoopRow[],
  explicit: string | undefined,
  cwd: string,
): { id: string; name: string } | ResolveError {
  if (explicit) {
    const byId = loops.find((l) => l.id === explicit);
    if (byId) return { id: byId.id, name: byId.name };
    const byName = loops.filter((l) => l.name === explicit);
    if (byName.length === 1) return { id: byName[0]!.id, name: byName[0]!.name };
    if (byName.length > 1) return { error: `"${explicit}" matches multiple loops — pass the loop id instead` };
    // An explicit missing loop is a structured NOT_FOUND result, not a usage error.
    return { error: `no loop "${explicit}" on this machine — run \`pievo loops\` to list them`, code: "NOT_FOUND" };
  }
  if (loops.length === 0) return { error: "no loops on this machine yet" };
  const here = path.resolve(cwd);
  const matches = loops
    .map((l) => ({ l, dir: resolveLoopDir({ workdir: l.workdir }) }))
    .filter(({ dir }) => here === dir || here.startsWith(dir + path.sep))
    // Most specific folder wins when loops nest.
    .sort((a, b) => b.dir.length - a.dir.length);
  if (matches.length === 0) {
    return { error: "no loop workdir contains this directory — pass a loop id, e.g. `pievo log <loop-id>` (`pievo loops` lists them)" };
  }
  return { id: matches[0]!.l.id, name: matches[0]!.l.name };
}

/** Render a `resolveLoopId` failure. A coded error is structured stdout at
 * exit 1; an uncoded error is a prose usage failure on stderr at exit 2. */
export function renderResolveError(
  e: ResolveError,
  out: (s: string) => void,
  err: (s: string) => void,
): number {
  if (e.code) {
    out(`error: ${JSON.stringify(e.error)}\ncode: ${e.code}\n`);
    return 1;
  }
  err(`pievo: ${e.error}\n`);
  return 2;
}

export async function runLog(argv: string[], injected: LogDeps = {}): Promise<number> {
  const d = seams(injected);
  const flagServer = (() => {
    const i = argv.indexOf("--server-url");
    return i >= 0 ? argv[i + 1] : undefined;
  })();
  // Shared postCli deps: injected server/token override the persisted ones so tests
  // never touch ~/.pievo; production leaves them undefined and postCli resolves.
  const cliDeps: PostCliDeps = {
    fetchImpl: injected.fetchFn,
    serverFlag: flagServer,
    ...("server" in injected ? { server: injected.server } : {}),
    ...("token" in injected ? { deviceToken: injected.token } : {}),
  };

  const { positional, flags } = parseArgs(argv);
  // Reject an unknown flag (exit 2) instead of silently ignoring it — uniform with the
  // `loops`/`edit` flag discipline and the unknown-verb exit code.
  const unknown = Object.keys(flags).filter((k) => !LOG_FLAGS.has(k));
  if (unknown.length) return d.err(`pievo: unknown flag --${unknown[0]} — try \`pievo log --help\`\n`), 2;
  if (positional.length > 1) return d.err("pievo: log accepts at most one loop id or name\n"), 2;
  const missingValue = VALUE_FLAGS.find((key) => flags[key] === true);
  if (missingValue) return d.err(`pievo: --${missingValue} requires a value\n`), 2;
  const notConnected = () =>
    d.err("pievo: this machine isn't connected yet — run `pievo daemon start --server-url … --connect-key …` first\n");

  // 1. List the machine's loops so we can resolve which one this directory belongs
  //    to (client-side — the server's unified `log` needs an explicit loop id).
  const listed = await postCli(["loops"], cliDeps);
  if (listed.kind === "not-configured") return notConnected(), 2;
  if (listed.kind === "network-error") return d.err(`pievo: ${listed.message}\n`), 1;
  const listData = listed.body as { loops?: LoopRow[]; error?: string };
  if (listed.status >= 400 || !listData.loops) {
    d.err(`pievo: ${listData.error || `could not list loops (${listed.status})`}\n`);
    return 1;
  }
  const resolved = resolveLoopId(listData.loops, positional[0], d.cwd());
  if ("error" in resolved) return renderResolveError(resolved, d.out, d.err);

  // 2. Fetch the resolved loop's history. Canonicalize flags so the positional
  // loop used for client-side resolution is not sent twice.
  const forwarded: string[] = [];
  for (const key of ["diff", "json"] as const) if (flags[key] === true || flags[key] === "true") forwarded.push(`--${key}`);
  for (const key of VALUE_FLAGS) {
    const value = flags[key];
    if (typeof value === "string") forwarded.push(`--${key}`, value);
  }
  const logArgv = ["log", resolved.id, ...forwarded];
  const got = await postCli(logArgv, cliDeps);
  if (got.kind === "not-configured") return notConnected(), 2;
  if (got.kind === "network-error") return d.err(`pievo: ${got.message}\n`), 1;
  return printCliResponse(got.body, got.status, d.out);
}

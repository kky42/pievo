/**
 * `pievo log [<loop>] [--limit N] [--json]` — print how a loop's recent runs
 * actually went. The default is the server's concise text survey; `--json`
 * returns the retained structured run rows. Provider transcripts are not a
 * daemon telemetry or CLI surface.
 *
 * Like `pievo loops`/`edit`, this is an owner-OUTSIDE-a-run command: it goes
 * through the shared CLI client (`postCli`), which reuses the device token + server
 * URL the daemon persisted under ~/.pievo and POSTs `{argv}` to the unified
 * `/api/machine/cli`, falling back to the legacy `/api/machine/log` on a 404 (old
 * server). No run token, no re-auth — the machine is already connected.
 *
 * The loop is resolved like the watcher resolves what to watch: an explicit
 * `<loop>` id wins; otherwise the current working directory is matched against
 * each loop's folder (`resolveLoopDir`), so running it inside a loop's workdir
 * finds that loop — a CLIENT-side resolution, since the server's `log` dispatch
 * needs an explicit loop id. Every external touch is an injectable seam for tests.
 */
import path from "node:path";

import type { CliResponse, LegacyFallback, PostCliDeps } from "./cli-client.js";
import { postCli, printTextOrTooOld } from "./cli-client.js";
import { resolveLoopDir } from "./loopdir.js";

export interface LoopRow {
  id: string;
  name: string;
  workdir: string | null;
  taskFile: string | null;
}

interface RunRow {
  id: string;
  ts: string;
  role: string;
  phase: string;
  outcome: string | null;
  status: string | null;
  durationMs: number | null;
  error: string | null;
  message: string | null;
  sessionId: string | null;
  // The metrics the run reported (the state object).
  state: Record<string, unknown> | null;
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
const BOOL_FLAGS = new Set(["json"]);

/** The flags `pievo log` accepts (plus the global daemon flags consumed separately).
 *  `help` is allowlisted so it never trips the unknown-flag guard. */
const LOG_FLAGS = new Set(["json", "limit", "help", "server-url"]);

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
 *  otherwise pick the loop whose folder contains the current directory (the most
 *  specific match if several nest). Returns the id, or an error explaining why. A
 *  `code` marks a structured P6 error (rendered `error:`/`code:` to stdout, exit 1);
 *  an uncoded error is a usage failure (prose to stderr, exit 2). */
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
    // An explicitly-named loop that doesn't exist is the P6 NOT_FOUND case (exit 1,
    // structured to stdout) — NOT a usage error. Keep the actionable guidance.
    return { error: `no loop "${explicit}" on this machine — run \`pievo loops\` to list them`, code: "NOT_FOUND" };
  }
  if (loops.length === 0) return { error: "no loops on this machine yet" };
  const here = path.resolve(cwd);
  const matches = loops
    .map((l) => ({ l, dir: resolveLoopDir({ loopId: l.id, workdir: l.workdir, taskFile: l.taskFile }) }))
    .filter(({ dir }) => here === dir || here.startsWith(dir + path.sep))
    // Most specific folder wins when loops nest.
    .sort((a, b) => b.dir.length - a.dir.length);
  if (matches.length === 0) {
    return { error: "no loop folder matches this directory — pass a loop id, e.g. `pievo log <loop-id>` (`pievo loops` lists them)" };
  }
  return { id: matches[0]!.l.id, name: matches[0]!.l.name };
}

/** Render a `resolveLoopId` failure. A coded error (NOT_FOUND) is a P6 structured
 *  error to STDOUT at exit 1 (`error: "<msg>"` / `code: <SLUG>`, the message quoted via
 *  JSON so backticks/quotes survive); an uncoded error stays a prose usage failure to
 *  stderr at exit 2. Shared by `pievo log` and `pievo show`. */
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
  const json = flags["json"] === true || flags["json"] === "true";
  const limit = typeof flags["limit"] === "string" ? flags["limit"] : undefined;

  const notConnected = () =>
    d.err("pievo: this machine isn't connected yet — run `pievo daemon start --server-url … --connect-key …` first\n");

  // 1. List the machine's loops so we can resolve which one this directory belongs
  //    to (client-side — the server's unified `log` needs an explicit loop id).
  const legacyLoops: LegacyFallback = async ({ server, token, fetchImpl }): Promise<CliResponse> => {
    const res = await fetchImpl(`${server}/api/machine/loop`, { method: "GET", headers: { Authorization: `Bearer ${token}` } });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const listed = await postCli(["loops"], legacyLoops, cliDeps);
  if (listed.kind === "not-configured") return notConnected(), 2;
  if (listed.kind === "read-error") return d.err(`pievo: cannot read ${listed.path}\n`), 1;
  if (listed.kind === "network-error") return d.err(`pievo: ${listed.message}\n`), 1;
  const listData = listed.body as { loops?: LoopRow[]; error?: string };
  if (listed.status >= 400 || !listData.loops) {
    d.err(`pievo: ${listData.error || `could not list loops (${listed.status})`}\n`);
    return 1;
  }
  const resolved = resolveLoopId(listData.loops, positional[0], d.cwd());
  if ("error" in resolved) return renderResolveError(resolved, d.out, d.err);

  // 2. Fetch the resolved loop's recent runs.
  const logArgv = ["log", resolved.id, ...(limit ? ["--limit", limit] : [])];
  const legacyLog: LegacyFallback = async ({ server, token, fetchImpl }): Promise<CliResponse> => {
    const qs = new URLSearchParams({ loopId: resolved.id });
    if (limit) qs.set("limit", limit);
    const res = await fetchImpl(`${server}/api/machine/log?${qs.toString()}`, { method: "GET", headers: { Authorization: `Bearer ${token}` } });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const got = await postCli(logArgv, legacyLog, cliDeps);
  if (got.kind === "not-configured") return notConnected(), 2;
  if (got.kind === "read-error") return d.err(`pievo: cannot read ${got.path}\n`), 1;
  if (got.kind === "network-error") return d.err(`pievo: ${got.message}\n`), 1;
  const data = got.body as { runs?: RunRow[]; error?: string };

  // `--json` reads the retained structured `runs` data channel. A missing
  // `runs` means an error status or a too-old server without that channel.
  if (json) {
    if (got.status >= 400 || !data.runs) {
      d.err(`pievo: ${data.error || `log failed (${got.status})`}\n`);
      return 1;
    }
    d.out(`${JSON.stringify(data.runs, null, 2)}\n`);
    return 0;
  }

  // TOON default: text-sink — the server renders the concise survey (incl. the empty
  // state). A too-old server (no `text`) → a definitive SERVER_TOO_OLD error.
  return printTextOrTooOld(got.body, got.status, d.out);
}

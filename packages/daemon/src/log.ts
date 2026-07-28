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
import type { PostCliDeps } from "./cli-client.js";
import { postCli, printCliResponse } from "./cli-client.js";
import { parseLongOptions } from "./long-options.js";
import { renderResolveError, resolveOwnerLoop } from "./owner-loop.js";

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

  const { positional, flags } = parseLongOptions(argv, (key) => !BOOL_FLAGS.has(key));
  // Reject an unknown flag (exit 2) instead of silently ignoring it — uniform with the
  // `loops`/`edit` flag discipline and the unknown-verb exit code.
  const unknown = Object.keys(flags).filter((k) => !LOG_FLAGS.has(k));
  if (unknown.length) return d.err(`pievo: unknown flag --${unknown[0]} — try \`pievo log --help\`\n`), 2;
  if (positional.length > 1) return d.err("pievo: log accepts at most one loop id or name\n"), 2;
  const missingValue = VALUE_FLAGS.find((key) => flags[key] === true);
  if (missingValue) return d.err(`pievo: --${missingValue} requires a value\n`), 2;
  const notConnected = () =>
    d.err("pievo: this machine isn't connected yet — run `pievo daemon connect --server-url … --connect-key …` first\n");

  // 1. List the machine's loops and resolve the target client-side.
  const resolution = await resolveOwnerLoop(positional[0], d.cwd(), cliDeps);
  if (resolution.kind === "not-configured") return notConnected(), 2;
  if (resolution.kind === "network-error") return d.err(`pievo: ${resolution.message}\n`), 1;
  if (resolution.kind === "list-error") return d.err(`pievo: ${resolution.message}\n`), 1;
  if (resolution.kind === "resolve-error") return renderResolveError(resolution.error, d.out, d.err);

  // 2. Fetch the resolved loop's history. Canonicalize flags so the positional
  // loop used for client-side resolution is not sent twice.
  const forwarded: string[] = [];
  for (const key of ["diff", "json"] as const) if (flags[key] === true || flags[key] === "true") forwarded.push(`--${key}`);
  for (const key of VALUE_FLAGS) {
    const value = flags[key];
    if (typeof value === "string") forwarded.push(`--${key}`, value);
  }
  const logArgv = ["log", resolution.loop.id, ...forwarded];
  const got = await postCli(logArgv, cliDeps);
  if (got.kind === "not-configured") return notConnected(), 2;
  if (got.kind === "network-error") return d.err(`pievo: ${got.message}\n`), 1;
  return printCliResponse(got.body, got.status, d.out);
}

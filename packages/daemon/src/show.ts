/**
 * `pievo show [<loop>] [--json] [--full]` OUT of a run — the owner reads a loop's
 * full editable config. Like `pievo log`, it resolves the target loop
 * CLIENT-side (an explicit id/name wins; else the loop whose folder contains the cwd),
 * because the server's `show` dispatch needs an explicit loop id. Then it forwards
 * `show <id> [--json] [--full]` to the unified `/api/machine/cli` on the device
 * credential and prints the server's rendered `text` (the full editable envelope TOON,
 * or — under `--json` — the exact `edit --json` envelope for the read/write roundtrip).
 *
 * The daemon is a text sink here too: the server owns the render. Every external touch
 * is an injectable seam so tests need no real process/network/~.pievo.
 */
import type { PostCliDeps } from "./cli-client.js";
import { postCli, printCliResponse } from "./cli-client.js";
import { parseLongOptions } from "./long-options.js";
import { renderResolveError, resolveOwnerLoop } from "./owner-loop.js";

export type ShowDeps = {
  cwd?: () => string;
  fetchFn?: typeof fetch;
  out?: (s: string) => void;
  err?: (s: string) => void;
  server?: string;
  token?: string;
};

/** The value-taking flags `pievo show` tolerates (consumed separately) — anything
 *  else that isn't a bare `--json`/`--full` is an unknown flag (exit 2). */
const SHOW_VALUE_FLAGS = new Set(["server-url"]);

const SHOW_BOOLEAN_FLAGS = new Set(["json", "full", "help"]);

export async function runShow(argv: string[], injected: ShowDeps = {}): Promise<number> {
  const out = injected.out ?? ((s: string) => void process.stdout.write(s));
  const err = injected.err ?? ((s: string) => void process.stderr.write(s));
  const cwd = injected.cwd ?? (() => process.cwd());
  const flagServer = (() => {
    const i = argv.indexOf("--server-url");
    return i >= 0 ? argv[i + 1] : undefined;
  })();
  const cliDeps: PostCliDeps = {
    fetchImpl: injected.fetchFn,
    serverFlag: flagServer,
    ...("server" in injected ? { server: injected.server } : {}),
    ...("token" in injected ? { deviceToken: injected.token } : {}),
  };

  const { positional, flags, occurrences } = parseLongOptions(argv, (key) => SHOW_VALUE_FLAGS.has(key));
  const unknown = occurrences
    .filter(({ key, value }) => !SHOW_VALUE_FLAGS.has(key) && (!SHOW_BOOLEAN_FLAGS.has(key) || value !== true))
    .map(({ key }) => key);
  if (unknown.length) return err(`pievo: unknown flag --${unknown[0]} — try \`pievo show --help\`\n`), 2;
  if (positional.length > 1) return err("pievo: usage: pievo show [<loop>] [--json] [--full]\n"), 2;
  const notConnected = () =>
    err("pievo: this machine isn't connected yet — run `pievo daemon connect`\n");

  // 1. List the machine's loops and resolve the target client-side.
  const resolution = await resolveOwnerLoop(positional[0], cwd(), cliDeps);
  if (resolution.kind === "not-configured") return notConnected(), 2;
  if (resolution.kind === "network-error") return err(`pievo: ${resolution.message}\n`), 1;
  if (resolution.kind === "list-error") return err(`pievo: ${resolution.message}\n`), 1;
  if (resolution.kind === "resolve-error") return renderResolveError(resolution.error, out, err);

  // 2. Forward `show <id> [--json] [--full]`; the server renders the result.
  const showArgv = [
    "show",
    resolution.loop.id,
    ...(flags["json"] === true ? ["--json"] : []),
    ...(flags["full"] === true ? ["--full"] : []),
  ];
  const got = await postCli(showArgv, cliDeps);
  if (got.kind === "not-configured") return notConnected(), 2;
  if (got.kind === "network-error") return err(`pievo: ${got.message}\n`), 1;
  return printCliResponse(got.body, got.status, out);
}

import fs from "node:fs";
import path from "node:path";

import { postCli, printCliResponse } from "./cli-client.js";
import { buildPostCliDeps, serverFlag } from "./cli-deps.js";
import { expandTilde } from "./loopdir.js";
import { parseLongOptions } from "./long-options.js";
import { renderResolveError, resolveOwnerLoop } from "./owner-loop.js";

export type MemoryDeps = {
  cwd?: () => string;
  fetchFn?: typeof fetch;
  out?: (s: string) => void;
  err?: (s: string) => void;
  server?: string;
  token?: string;
};

const USAGE = "pievo: usage: pievo memory [<loop>] | pievo memory set <loop> --from <path|->\n";

/** `memory [<loop>]` prints a loop's MEMORY.md; `memory set <loop> --from` replaces
 *  it. Content travels as base64 so text starting with `--` survives argv. */
export async function runMemory(argv: string[], injected: MemoryDeps = {}): Promise<number> {
  const out = injected.out ?? ((s: string) => void process.stdout.write(s));
  const err = injected.err ?? ((s: string) => void process.stderr.write(s));
  const cwd = injected.cwd ?? (() => process.cwd());
  const cliDeps = buildPostCliDeps({ ...injected, serverFlag: serverFlag(argv) });

  const { positional, flags } = parseLongOptions(argv, () => true);
  const setting = positional[0] === "set";
  const target = setting ? positional[1] : positional[0];
  const unknown = Object.keys(flags).filter((key) => key !== "server-url" && !(setting && key === "from"));
  if (unknown.length || positional.length > (setting ? 2 : 1) || (setting && (!target || typeof flags["from"] !== "string"))) {
    return err(USAGE), 2;
  }
  const notConnected = () =>
    err("pievo: this machine isn't connected yet — run `pievo daemon connect`\n");

  const resolution = await resolveOwnerLoop(target, cwd(), cliDeps);
  if (resolution.kind === "not-configured") return notConnected(), 2;
  if (resolution.kind === "network-error") return err(`pievo: ${resolution.message}\n`), 1;
  if (resolution.kind === "list-error") return err(`pievo: ${resolution.message}\n`), 1;
  if (resolution.kind === "resolve-error") return renderResolveError(resolution.error, out, err);

  const cliArgv = setting ? ["memory", "set", resolution.loop.id] : ["memory", resolution.loop.id];
  if (setting) {
    let bytes: Buffer;
    try {
      bytes = flags["from"] === "-"
        ? fs.readFileSync(0)
        : fs.readFileSync(path.resolve(expandTilde(String(flags["from"]))));
    } catch (e) {
      return err(`pievo: could not read ${String(flags["from"])}: ${e instanceof Error ? e.message : String(e)}\n`), 1;
    }
    cliArgv.push("--content-base64", bytes.toString("base64"));
  }
  const got = await postCli(cliArgv, cliDeps);
  if (got.kind === "not-configured") return notConnected(), 2;
  if (got.kind === "network-error") return err(`pievo: ${got.message}\n`), 1;
  return printCliResponse(got.body, got.status, out);
}

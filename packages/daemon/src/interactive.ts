import { createInterface } from "node:readline/promises";

import type { PostCliDeps } from "./cli-client.js";
import { postCli, printCliResponse } from "./cli-client.js";
import { parseLongOptions } from "./long-options.js";

type Flags = Record<string, string | boolean>;
const BOOLEAN_FLAGS = new Set(["dry-run", "force", "help"]);

export interface InteractiveDeps {
  fetchImpl?: typeof fetch;
  server?: string;
  token?: string;
  out?: (s: string) => void;
  err?: (s: string) => void;
  confirmForceDelete?: () => Promise<boolean>;
}

export function parseFlags(
  args: string[],
  booleanFlags: ReadonlySet<string> = BOOLEAN_FLAGS,
): { positional: string[]; flags: Flags } {
  const { positional, flags } = parseLongOptions(args, (key) => !booleanFlags.has(key));
  return { positional, flags };
}

const EDIT_FLAGS = new Set(["json", "dry-run", "server-url"]);

/** Parse option syntax locally, but leave `--fields` value semantics to the server. */
const LOOPS_FLAGS = new Set(["fields", "json", "help", "server-url"]);
const LIFECYCLE_VERBS = new Set(["pause", "start", "stop", "delete", "run"]);
const FORCE_DELETE_CONFIRMATION = "delete-server-data-anyway";

async function confirmForceDeleteInteractive(): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`Type ${FORCE_DELETE_CONFIRMATION} to confirm force delete: `);
    return answer.trim() === FORCE_DELETE_CONFIRMATION;
  } finally {
    rl.close();
  }
}

/** Keep semantic validation on the server; reject only syntax and malformed JSON here. */
export function buildPatch(flags: Flags): Record<string, unknown> {
  const unknown = Object.keys(flags).filter((k) => !EDIT_FLAGS.has(k));
  if (unknown.length) {
    throw new Error(`unknown flag --${unknown[0]} — try \`pievo --help\` (edit takes --json '<obj>')`);
  }

  if (flags["json"] !== undefined && typeof flags["json"] !== "string") {
    throw new Error("--json requires a JSON object value");
  }
  if (flags["dry-run"] !== undefined && flags["dry-run"] !== true) {
    throw new Error("--dry-run does not take a value");
  }
  const patch: Record<string, unknown> = {};

  if (typeof flags["json"] === "string") {
    const parsed = JSON.parse(flags["json"]);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("--json must be a JSON object of loop fields");
    }
    Object.assign(patch, parsed);
  }
  return patch;
}

const USAGE =
  "pievo: usage: pievo edit <loop-id> [options]\n" +
  "  --json '<json-object>'      patch name/tags/schedule/workdir/agent/model/reasoningEffort/\n" +
  "                              prompt/statusDefinitions/artifacts/enabled\n" +
  "                              e.g. '{\"schedule\":{\"mode\":\"continuous\",\"delayMinutes\":5}}'\n" +
  "  --dry-run                   validate + preview before/after, change nothing\n" +
  "  the server validates every field; unknown keys are rejected.\n";

export async function runInteractive(argv: string[], injected: InteractiveDeps = {}): Promise<number> {
  const out = injected.out ?? ((s: string) => void process.stdout.write(s));
  const err = injected.err ?? ((s: string) => void process.stderr.write(s));
  const flagServer = (() => {
    const i = process.argv.indexOf("--server-url");
    return i >= 0 ? process.argv[i + 1] : undefined;
  })();
  const cliDeps: PostCliDeps = {
    fetchImpl: injected.fetchImpl,
    serverFlag: flagServer,
    ...("server" in injected ? { server: injected.server } : {}),
    ...("token" in injected ? { deviceToken: injected.token } : {}),
  };

  const verb = argv[0];
  const booleanFlags = verb === "loops" ? new Set([...BOOLEAN_FLAGS, "json"]) : BOOLEAN_FLAGS;
  const { positional, flags } = parseFlags(argv.slice(1), booleanFlags);

  const notConnected = () =>
    err("pievo: this machine isn't connected yet — run `pievo daemon connect --server-url … --connect-key …` first\n");

  if (verb === "loops") {
    const unknown = Object.keys(flags).filter((k) => !LOOPS_FLAGS.has(k));
    if (unknown.length) return err(`pievo: unknown flag --${unknown[0]} — try \`pievo loops --help\`\n`), 2;
    if (positional.length !== 0
      || (flags["fields"] !== undefined && typeof flags["fields"] !== "string")
      || (flags["json"] !== undefined && flags["json"] !== true)) {
      return err("pievo: usage: pievo loops [--fields <set>] [--json]\n"), 2;
    }
    const cliArgv = ["loops"];
    if (typeof flags["fields"] === "string") cliArgv.push("--fields", flags["fields"]);
    if (flags["json"] === true || flags["json"] === "true") cliArgv.push("--json");
    if (flags["help"] === true) cliArgv.push("--help");
    const r = await postCli(cliArgv, cliDeps);
    if (r.kind === "not-configured") return notConnected(), 2;
    if (r.kind === "network-error") return err(`pievo: ${r.message}\n`), 1;
    return printCliResponse(r.body, r.status, out);
  }

  if (LIFECYCLE_VERBS.has(verb ?? "")) {
    const isRunStop = verb === "run";
    const id = isRunStop ? positional[1] : positional[0];
    const validRunShape = isRunStop
      ? positional.length === 2 && positional[0] === "stop"
      : positional.length === 1;
    const force = flags["force"] === true;
    const allowedFlags = verb === "delete" ? new Set(["force", "server-url"]) : new Set(["server-url"]);
    const unknown = Object.keys(flags).filter((k) => !allowedFlags.has(k));
    if (!id || !validRunShape || unknown.length
      || (flags["force"] !== undefined && (verb !== "delete" || flags["force"] !== true))) {
      const syntax = isRunStop ? "pievo run stop <run>" : `pievo ${verb} <loop>${verb === "delete" ? " [--force]" : ""}`;
      return err(`pievo: usage: ${syntax}\n`), 2;
    }
    if (force) {
      const confirmed = await (injected.confirmForceDelete ?? confirmForceDeleteInteractive)();
      if (!confirmed) return err(`pievo: force delete canceled; type ${FORCE_DELETE_CONFIRMATION} when prompted to confirm\n`), 1;
    }
    const cliArgv = isRunStop
      ? ["run", "stop", id]
      : [verb!, id, ...(force ? ["--force", "--confirmation", FORCE_DELETE_CONFIRMATION] : [])];
    const r = await postCli(cliArgv, cliDeps);
    if (r.kind === "not-configured") return notConnected(), 2;
    if (r.kind === "network-error") return err(`pievo: ${r.message}\n`), 1;
    return printCliResponse(r.body, r.status, out);
  }

  if (verb === "edit") {
    const id = positional[0];
    if (!id || positional.length !== 1) return err(USAGE), 2;
    const dryRun = flags["dry-run"] === true;
    let patch: Record<string, unknown>;
    try {
      patch = buildPatch(flags);
    } catch (e) {
      return err(`pievo: ${e instanceof Error ? e.message : String(e)}\n`), 2;
    }
    // Bare `pievo edit <id>` with no edit inputs is a usage error. But `--json '{}'`
    // (or any explicit input flag that resolves to an empty patch) is a VALID no-op:
    // forward it so the server reports "nothing to change" + the allowed-key list,
    // instead of short-circuiting to the usage screen client-side.
    const gaveInput = flags["json"] !== undefined;
    if (!gaveInput) return err(USAGE), 2;
    const cliArgv = ["edit", id, "--json", JSON.stringify(patch), ...(dryRun ? ["--dry-run"] : [])];
    const r = await postCli(cliArgv, cliDeps);
    if (r.kind === "not-configured") return notConnected(), 2;
    if (r.kind === "network-error") return err(`pievo: ${r.message}\n`), 1;
    return printCliResponse(r.body, r.status, out);
  }

  err(`pievo: unknown command "${verb ?? ""}" (try: loops, edit, pause, start, stop, delete, run)\n`);
  return 2;
}

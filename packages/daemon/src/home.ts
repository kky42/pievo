/**
 * Bare `pievo` outside a run renders the machine home. The daemon is
 * a text sink: it collects the local facts only IT knows (cwd + home dir for the
 * directory scoping, the PATH shim path, the daemon pid, the server URL) and posts
 * them as `home` context flags to the unified `/api/machine/cli`; the SERVER owns the
 * whole TOON render (`renderHomeText`). The daemon just prints `body.text`.
 *
 * When this machine has no stored credential/server the post
 * short-circuits to a definitive local "not connected — run `pievo daemon connect`"
 * view. The in-run bare `pievo`
 * is handled separately (cli.ts routes it to the callback as `home` on the run cred).
 *
 * Bounded for responsive interactive use: the home POST goes through `boundedFetch`
 * (a few-second timeout + AbortSignal), so an unreachable-but-not-refused server fails
 * fast to a definitive degraded home (`server unreachable`) instead of waiting for the
 * OS timeout. Other interactive verbs keep their own fetch budgets.
 *
 * Every external touch (fetch, cwd, homedir, pid, server, output) is an injectable
 * seam so tests need no real process/network/~.pievo.
 */
import os from "node:os";

import { resolveDurableBinPath } from "./bin-shim.js";
import type { PostCliDeps } from "./cli-client.js";
import { postCli, printCliResponse } from "./cli-client.js";
import { resolveServerUrl } from "./config.js";
import { boundedFetch } from "./http.js";
import { verifiedRunningPid } from "./pidfile.js";

/** Keep the interactive home responsive when the configured server hangs. */
const HOME_TIMEOUT_MS = 4_000;

/** `fetch` bounded to `HOME_TIMEOUT_MS` — the default home transport (tests inject
 *  their own `fetchImpl`). */
const boundedHomeFetch = ((url: string, init?: RequestInit) =>
  boundedFetch(String(url), init ?? {}, HOME_TIMEOUT_MS)) as unknown as typeof fetch;

export interface HomeDeps {
  fetchImpl?: typeof fetch;
  server?: string;
  token?: string;
  cwd?: () => string;
  homedir?: () => string;
  localPid?: () => number | undefined;
  binPath?: () => string | null;
  serverDisplay?: () => string;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

export async function runHome(injected: HomeDeps = {}): Promise<number> {
  const out = injected.out ?? ((s: string) => void process.stdout.write(s));
  const cwd = (injected.cwd ?? (() => process.cwd()))();
  const homedir = (injected.homedir ?? os.homedir)();
  const pid = (injected.localPid ?? (() => verifiedRunningPid()))();
  // The durable `pievo` path (our shim or a real global on PATH). Null lets the
  // server render the explicit global-install fallback.
  const bin = (injected.binPath ?? (() => resolveDurableBinPath()))();
  const serverDisplay = (injected.serverDisplay ?? (() => resolveServerUrl(undefined)))();

  // Context the SERVER can't know — the render is still entirely server-side, we just
  // feed it the local facts. Omit an absent fact rather than send an empty flag.
  const ctx: string[] = ["--cwd", cwd, "--home", homedir];
  if (bin) ctx.push("--bin", bin);
  if (pid !== undefined) ctx.push("--pid", String(pid));
  if (serverDisplay) ctx.push("--server", serverDisplay);

  const cliDeps: PostCliDeps = {
    fetchImpl: injected.fetchImpl ?? boundedHomeFetch,
    ...("server" in injected ? { server: injected.server } : {}),
    ...("token" in injected ? { deviceToken: injected.token } : {}),
  };

  const r = await postCli(["home", ...ctx], cliDeps);
  // Not connected: no credential/server on this machine yet — render the DEFINITIVE
  // local state (never empty output), telling the owner exactly how to connect.
  if (r.kind === "not-configured") {
    out(notConnectedHome(bin));
    return 0;
  }
  // Unreachable / hung server: render a definitive degraded home — never hang,
  // never empty, never surface a raw transport error.
  if (r.kind === "network-error") {
    out(degradedHome(bin, serverDisplay, r.message));
    return 0;
  }

  return printCliResponse(r.body, r.status, out);
}

/** The `bin:` line that leads every home view: the durable path when known,
 *  else the honest "not on PATH" fallback with the fix. Mirrors the server's
 *  `renderHomeText` so the local and server-rendered homes agree. */
export function binLine(bin: string | null): string {
  return bin ? `bin: ${bin}` : "bin: (not on PATH — run `npm install -g @kky42/pievo@latest`)";
}

/** The definitive not-connected home rendered locally (no server round-trip possible
 *  — there is no credential/server). Mirrors the server's not-connected shape. */
function notConnectedHome(bin: string | null): string {
  return (
    `${binLine(bin)}\n` +
    "description: Run your scheduled Pievo agent loops on this machine with your own coding agent.\n" +
    "machine: not connected — run `pievo daemon connect`\n" +
    "help[2]:\n" +
    "  Run `pievo daemon connect --server-url <url> --connect-key <dk_…>` to connect this machine\n" +
    "  Run `pievo --help` to see every command\n"
  );
}

/** The definitive degraded home when the server is unreachable or hung (the machine
 *  is configured, so this isn't the not-connected view). Never empty; exits 0. */
function degradedHome(bin: string | null, server: string, reason: string): string {
  return (
    `${binLine(bin)}\n` +
    "description: Run your scheduled Pievo agent loops on this machine with your own coding agent.\n" +
    `machine: configured${server ? ` · ${server}` : ""} — server unreachable right now (${reason})\n` +
    "help[1]:\n" +
    "  Run `pievo loops` once the server is reachable to list this machine's loops\n"
  );
}

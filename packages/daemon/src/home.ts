import os from "node:os";

import { resolveDurableBinPath } from "./bin-shim.js";
import type { PostCliDeps } from "./cli-client.js";
import { postCli, printCliResponse } from "./cli-client.js";
import { resolveServerUrl } from "./config.js";
import { boundedFetch } from "./http.js";
import { verifiedRunningPid } from "./pidfile.js";

// Four seconds keeps interactive home responsive when a server hangs, rather than
// waiting for the OS network timeout before rendering the degraded local view.
const HOME_TIMEOUT_MS = 4_000;

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
  const bin = (injected.binPath ?? (() => resolveDurableBinPath()))();
  const serverDisplay = (injected.serverDisplay ?? (() => resolveServerUrl(undefined)))();

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
  if (r.kind === "not-configured") {
    out(notConnectedHome(bin));
    return 0;
  }
  if (r.kind === "network-error") {
    out(degradedHome(bin, serverDisplay, r.message));
    return 0;
  }

  return printCliResponse(r.body, r.status, out);
}

/** Keep local fallback output aligned with the server-rendered home shape. */
export function binLine(bin: string | null): string {
  return bin ? `bin: ${bin}` : "bin: (not on PATH — run `npm install -g @kky42/pievo@latest`)";
}

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

function degradedHome(bin: string | null, server: string, reason: string): string {
  return (
    `${binLine(bin)}\n` +
    "description: Run your scheduled Pievo agent loops on this machine with your own coding agent.\n" +
    `machine: configured${server ? ` · ${server}` : ""} — server unreachable right now (${reason})\n` +
    "help[1]:\n" +
    "  Run `pievo loops` once the server is reachable to list this machine's loops\n"
  );
}

/** Daemon start/restart lifecycle. `start` is detached and idempotent by default;
 * `--foreground` runs the same poller attached. `restart` stops this installed
 * version's daemon and starts it again from persisted configuration. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { ensureBinShim } from "./bin-shim.js";
import { DEVICE_FILE, PIEVO_DIR, SERVER_FILE, flag, persist, readStored, resolveServerUrl } from "./config.js";
import { fetchMachineStatus, runDaemonStop } from "./daemon-control.js";
import { verifiedRunningPid } from "./pidfile.js";
import { type InstallOpts, type InstallOutcome, installSkill } from "./skill-install.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Private re-entry marker for the detached child. Not a CLI flag or route. */
const INTERNAL_DAEMON_CHILD = "PIEVO_INTERNAL_DAEMON_CHILD";

/**
 * The argv/env plan for the detached daemon spawn (pure, exported for tests).
 * The device token travels via ENV (PIEVO_TOKEN — runDaemon reads it), NEVER
 * argv: argv is visible in `ps` for the daemon's whole lifetime while the token
 * file is carefully 0600. The child re-enters through the public nested command;
 * a private environment marker prevents it duplicating the parent's refresh.
 */
export function buildDaemonSpawn(server: string, token: string): { args: string[]; env: NodeJS.ProcessEnv } {
  const args = [...process.execArgv, process.argv[1] ?? "", "daemon", "start", "--foreground", "--server-url", server];
  return { args, env: { ...process.env, PIEVO_TOKEN: token, [INTERNAL_DAEMON_CHILD]: "1" } };
}

/**
 * Spawn the daemon detached so it outlives `pievo daemon start`. Re-execs THIS
 * CLI through `daemon start --foreground`, replaying the exact launcher.
 * stdio is redirected to ~/.pievo/daemon.log. Returns the child pid so a
 * readiness timeout can kill exactly what it started.
 */
function spawnDaemonDefault(server: string, token: string, logFile: string): number | undefined {
  const out = fs.openSync(logFile, "a");
  const { args, env } = buildDaemonSpawn(server, token);
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", out, out],
    env,
  });
  child.unref();
  return child.pid;
}

const READY_TIMEOUT_MS = 45_000;
const POLL_MS = 1_500;

function heartbeatTime(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : undefined;
}

export type DaemonStartDeps = {
  fetchStatus?: (server: string, token: string) => Promise<import("./daemon-control.js").MachineStatus | undefined>;
  spawnDaemon?: (server: string, token: string, logFile: string) => number | undefined;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  /** The local pidfile check (verified alive + start-time match). */
  localPid?: () => number | undefined;
  persist?: (file: string, value: string) => void;
  readToken?: () => string | undefined;
  /** Refresh the user-scope skill (best-effort, announced). Injected in tests. */
  installSkill?: (opts: InstallOpts) => Promise<InstallOutcome>;
  /** Install/refresh the `pievo` PATH shim (best-effort). Injected in tests. */
  ensureBinShim?: () => void;
  /** Override the private detached-child marker in tests. */
  internalChild?: boolean;
  foreground?: (args: string[]) => Promise<number>;
  out?: (s: string) => void;
  err?: (s: string) => void;
};

function validStartArgs(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--foreground") continue;
    if (arg === "--server-url" || arg === "--connect-key") {
      if (!args[i + 1] || args[i + 1]!.startsWith("--")) return false;
      i += 1;
      continue;
    }
    return false;
  }
  return true;
}

export async function runDaemonStart(args: string[], injected: DaemonStartDeps = {}): Promise<number> {
  const d = {
    fetchStatus: injected.fetchStatus ?? fetchMachineStatus,
    spawnDaemon: injected.spawnDaemon ?? spawnDaemonDefault,
    kill: injected.kill ?? ((pid: number, sig: NodeJS.Signals) => process.kill(pid, sig)),
    sleep: injected.sleep ?? sleep,
    localPid: injected.localPid ?? (() => verifiedRunningPid()),
    persist: injected.persist ?? persist,
    readToken: injected.readToken ?? (() => readStored(DEVICE_FILE)),
    installSkill: injected.installSkill ?? installSkill,
    ensureBinShim: injected.ensureBinShim ?? (() => void ensureBinShim()),
    internalChild: injected.internalChild ?? process.env[INTERNAL_DAEMON_CHILD] === "1",
    foreground: injected.foreground ?? ((daemonArgs: string[]) => import("./daemon.js").then((m) => m.runDaemon(daemonArgs))),
    out: injected.out ?? ((s: string) => process.stdout.write(s)),
    err: injected.err ?? ((s: string) => process.stderr.write(s)),
  };

  /** Best-effort user-scope skill and PATH refresh. */
  const refreshSkill = async (): Promise<void> => {
    try {
      const r = await d.installSkill({ global: true });
      d.out(r.line + "\n");
    } catch {
      /* never let a skill refresh fail daemon start */
    }
    try {
      d.ensureBinShim();
    } catch {
      /* never let the PATH shim fail daemon start */
    }
  };

  if (!validStartArgs(args)) {
    d.err("pievo: usage: pievo daemon start [--foreground] [--server-url <url>] [--connect-key <dk_…>]\n");
    return 2;
  }
  const server = resolveServerUrl(flag(args, "server-url"));
  // Reuse this machine's stored identity first (so we stay the SAME machine across
  // runs); only adopt the connect-key the first time, when nothing is stored yet.
  const token = d.readToken() || flag(args, "connect-key") || process.env.PIEVO_TOKEN;
  if (!server || !token) {
    d.err("pievo: usage: pievo daemon start [--foreground] [--server-url <url>] [--connect-key <dk_…>]\n");
    return 2;
  }

  // Persist both now so `pievo new` and a restart are zero-config (the daemon
  // persists them too on boot; doing it here makes them available immediately).
  d.persist(SERVER_FILE, server);
  d.persist(DEVICE_FILE, token);

  if (args.includes("--foreground")) {
    // Start polling before any potentially 90s skill install. A detached child does
    // no refresh at all: its parent owns the single post-readiness refresh.
    const running = d.foreground(["--server-url", server]);
    if (!d.internalChild) void refreshSkill();
    return running;
  }

  const logFile = path.join(PIEVO_DIR, "daemon.log");
  const localPid = d.localPid();
  if (localPid !== undefined) {
    const st = await d.fetchStatus(server, token);
    if (st?.online) {
      d.out(`daemon already running for this machine${st.name ? ` (${st.name})` : ""}\n`);
    } else {
      d.out(`daemon already running locally (pid ${localPid}) — server unreachable or machine still connecting; check ${logFile}\n`);
    }
    await refreshSkill();
    return 0;
  }

  // Server presence lingers after a daemon exits. Capture its heartbeat, but never
  // let it substitute for local liveness or satisfy the replacement's readiness.
  const before = await d.fetchStatus(server, token);
  const initialHeartbeat = heartbeatTime(before?.lastSeen);
  let baselineKnown = before !== undefined && initialHeartbeat !== undefined;
  let baselineHeartbeat = initialHeartbeat ?? null;

  d.out("starting daemon…\n");
  const childPid = d.spawnDaemon(server, token, logFile);

  const attempts = Math.ceil(READY_TIMEOUT_MS / POLL_MS);
  for (let i = 0; i < attempts; i++) {
    await d.sleep(POLL_MS);
    const st = await d.fetchStatus(server, token);
    if (!st) continue;
    const currentHeartbeat = heartbeatTime(st.lastSeen);
    if (!baselineKnown) {
      if (currentHeartbeat === undefined) continue;
      baselineKnown = true;
      baselineHeartbeat = currentHeartbeat;
      continue;
    }
    if (st.online && typeof currentHeartbeat === "number"
      && (baselineHeartbeat === null || currentHeartbeat > baselineHeartbeat)) {
      d.out(`daemon online — this machine is connected${st.name ? ` (${st.name})` : ""}\n`);
      await refreshSkill();
      return 0;
    }
  }

  // Readiness timeout: don't leave the just-spawned daemon running detached —
  // we're about to report failure, so tear down exactly what we started (its
  // SIGTERM handler exits cleanly and clears its own pidfile).
  if (childPid !== undefined) {
    try {
      d.kill(childPid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  d.err(`pievo: daemon did not come online within ${READY_TIMEOUT_MS / 1000}s — check ${logFile}\n`);
  return 1;
}

export type DaemonRestartDeps = {
  stop?: (args: string[]) => Promise<number>;
  start?: (args: string[]) => Promise<number>;
  err?: (s: string) => void;
};

/** Restart never installs or downloads anything. npm owns upgrades; this command
 * stops and starts the currently installed CLI, preserving stored configuration. */
export async function runDaemonRestart(args: string[], injected: DaemonRestartDeps = {}): Promise<number> {
  const force = args.length === 1 && args[0] === "--force";
  if (args.length > 0 && !force) {
    (injected.err ?? ((s) => process.stderr.write(s)))("pievo: usage: pievo daemon restart [--force]\n");
    return 2;
  }
  const stop = injected.stop ?? ((stopArgs) => runDaemonStop(stopArgs));
  const start = injected.start ?? ((startArgs) => runDaemonStart(startArgs));
  const stopped = await stop(force ? ["--force"] : []);
  if (stopped !== 0) return stopped;
  return start([]);
}

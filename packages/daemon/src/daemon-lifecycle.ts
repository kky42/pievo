import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { ensureBinShim } from "./bin-shim.js";
import { activeConnection, connectionFor, normalizeServerUrl, PIEVO_DIR, readConnections, saveActiveConnection, validServerUrl, type SavedConnection } from "./config.js";
import { fetchMachineStatus, runDaemonStop } from "./daemon-control.js";
import { boundedFetch } from "./http.js";
import { verifiedRunningPid } from "./pidfile.js";
import { type InstallOutcome, installSkill } from "./skill-install.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const INTERNAL_DAEMON_CHILD = "PIEVO_INTERNAL_DAEMON_CHILD";

/**
 * The argv/env plan for the detached daemon spawn (pure, exported for tests).
 * The device token travels via ENV (PIEVO_TOKEN — runDaemon reads it), NEVER
 * argv: argv is visible in `ps` for the daemon's whole lifetime while the token
 * file is carefully 0600. The child re-enters through the public nested command;
 * a private environment marker prevents it duplicating the parent's refresh.
 */
export function buildDaemonSpawn(token: string): { args: string[]; env: NodeJS.ProcessEnv } {
  const args = [...process.execArgv, process.argv[1] ?? "", "daemon", "start", "--foreground"];
  return { args, env: { ...process.env, PIEVO_TOKEN: token, [INTERNAL_DAEMON_CHILD]: "1" } };
}

function spawnDaemonDefault(server: string, token: string, logFile: string): number | undefined {
  const out = fs.openSync(logFile, "a");
  const { args, env } = buildDaemonSpawn(token);
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

function mustReconnect(status: import("./daemon-control.js").MachineStatus | undefined): boolean {
  return status?.registered === false && status.claimValid === false;
}

const RECONNECT_GUIDANCE = "pievo: saved identity is no longer registered — connect to a server with `pievo daemon connect --server-url <url> --connect-key <dk_…>`\n";

export type DaemonStartDeps = {
  fetchStatus?: (server: string, token: string) => Promise<import("./daemon-control.js").MachineStatus | undefined>;
  spawnDaemon?: (server: string, token: string, logFile: string) => number | undefined;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  localPid?: () => number | undefined;
  readConnection?: () => SavedConnection | undefined;
  installSkill?: () => Promise<InstallOutcome>;
  ensureBinShim?: () => void;
  internalChild?: boolean;
  foreground?: (args: string[]) => Promise<number>;
  out?: (s: string) => void;
  err?: (s: string) => void;
};

function validStartArgs(args: string[]): boolean {
  return args.length === 0 || (args.length === 1 && args[0] === "--foreground");
}

export async function runDaemonStart(args: string[], injected: DaemonStartDeps = {}): Promise<number> {
  const d = {
    fetchStatus: injected.fetchStatus ?? fetchMachineStatus,
    spawnDaemon: injected.spawnDaemon ?? spawnDaemonDefault,
    kill: injected.kill ?? ((pid: number, sig: NodeJS.Signals) => process.kill(pid, sig)),
    sleep: injected.sleep ?? sleep,
    localPid: injected.localPid ?? (() => verifiedRunningPid()),
    readConnection: injected.readConnection ?? (() => activeConnection()),
    installSkill: injected.installSkill ?? installSkill,
    ensureBinShim: injected.ensureBinShim ?? (() => void ensureBinShim()),
    internalChild: injected.internalChild ?? process.env[INTERNAL_DAEMON_CHILD] === "1",
    foreground: injected.foreground ?? ((daemonArgs: string[]) => import("./daemon.js").then((m) => m.runDaemon(daemonArgs))),
    out: injected.out ?? ((s: string) => process.stdout.write(s)),
    err: injected.err ?? ((s: string) => process.stderr.write(s)),
  };

  const refreshSkill = async (): Promise<void> => {
    try {
      const r = await d.installSkill();
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
    d.err("pievo: usage: pievo daemon start [--foreground]\n");
    return 2;
  }
  const connection = d.readConnection();
  const server = connection?.serverUrl;
  // Detached children receive the credential only through the environment. A
  // direct foreground invocation uses the active connection's saved identity.
  const token = process.env.PIEVO_TOKEN || connection?.deviceToken;
  if (!server || !token) {
    d.err("pievo: no active connection — run `pievo daemon connect --server-url <url> --connect-key <dk_…>`\n");
    return 2;
  }

  if (args.includes("--foreground")) {
    // The detached parent already checked this identity. A direct foreground start
    // still fails fast instead of entering an unauthorized polling loop.
    if (!d.internalChild && mustReconnect(await d.fetchStatus(server, token))) {
      d.err(RECONNECT_GUIDANCE);
      return 1;
    }
    // Start polling before the best-effort skill refresh. A detached child does no
    // refresh at all: its parent owns the single post-readiness refresh.
    const running = d.foreground([]);
    if (!d.internalChild) void refreshSkill();
    return running;
  }

  const logFile = path.join(PIEVO_DIR, "daemon.log");
  const localPid = d.localPid();
  if (localPid !== undefined) {
    const st = await d.fetchStatus(server, token);
    if (mustReconnect(st)) {
      d.err(RECONNECT_GUIDANCE);
      return 1;
    }
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
  if (mustReconnect(before)) {
    d.err(RECONNECT_GUIDANCE);
    return 1;
  }
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

export type DaemonConnectDeps = {
  readConfig?: () => ReturnType<typeof readConnections>;
  save?: (serverUrl: string, token: string) => void;
  probeSaved?: (serverUrl: string, token: string) => Promise<"valid" | "invalid" | "unreachable">;
  stop?: (args: string[]) => Promise<number>;
  start?: (args: string[]) => Promise<number>;
  out?: (s: string) => void;
  err?: (s: string) => void;
};

async function probeSavedConnection(serverUrl: string, token: string): Promise<"valid" | "invalid" | "unreachable"> {
  try {
    const response = await boundedFetch(`${serverUrl}/api/machine/status`, {
      headers: { Authorization: `Bearer ${token}` },
    }, 3000);
    if (response.ok) {
      const status = await response.json() as { registered?: unknown };
      return status.registered === false ? "invalid" : "valid";
    }
    return response.status === 401 || response.status === 403 || response.status === 404 ? "invalid" : "unreachable";
  } catch {
    return "unreachable";
  }
}

function parseConnectArgs(args: string[]): { serverUrl: string; connectKey?: string } | undefined {
  let serverUrl: string | undefined;
  let connectKey: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg !== "--server-url" && arg !== "--connect-key") return undefined;
    const value = args[++i];
    if (!value || value.startsWith("--")) return undefined;
    if (arg === "--server-url") {
      if (serverUrl !== undefined) return undefined;
      serverUrl = value;
    } else {
      if (connectKey !== undefined) return undefined;
      connectKey = value;
    }
  }
  return serverUrl ? { serverUrl, ...(connectKey ? { connectKey } : {}) } : undefined;
}

/** Select a saved server or enroll a new one, stopping the old execution plane
 * before changing the active credential. */
export async function runDaemonConnect(args: string[], injected: DaemonConnectDeps = {}): Promise<number> {
  const out = injected.out ?? ((s: string) => process.stdout.write(s));
  const err = injected.err ?? ((s: string) => process.stderr.write(s));
  const parsed = parseConnectArgs(args);
  if (!parsed) {
    err("pievo: usage: pievo daemon connect --server-url <url> [--connect-key <dk_…>]\n");
    return 2;
  }
  if (!validServerUrl(parsed.serverUrl)) {
    err("pievo: server URL must be an http(s) origin without credentials, path, query, or fragment\n");
    return 2;
  }
  const serverUrl = normalizeServerUrl(parsed.serverUrl);
  const config = (injected.readConfig ?? readConnections)();
  const saved = connectionFor(serverUrl, config);
  if (!saved && !parsed.connectKey) {
    err(`pievo: first connection to ${serverUrl} requires --connect-key\n`);
    return 2;
  }
  let token = saved?.deviceToken ?? parsed.connectKey!;
  let identityChanged = false;
  if (saved && parsed.connectKey && parsed.connectKey !== saved.deviceToken) {
    const state = await (injected.probeSaved ?? probeSavedConnection)(serverUrl, saved.deviceToken);
    if (state === "unreachable") {
      err(`pievo: could not verify the saved connection to ${serverUrl}; it was not replaced\n`);
      return 1;
    }
    identityChanged = state === "invalid";
    if (identityChanged) token = parsed.connectKey;
    else out(`using saved identity for ${serverUrl}; the supplied key remains available for loop creation\n`);
  }
  if (config.active !== null && (config.active !== serverUrl || identityChanged)) {
    const stopped = await (injected.stop ?? ((stopArgs) => runDaemonStop(stopArgs)))(["--force"]);
    if (stopped !== 0) return stopped;
  }
  try {
    (injected.save ?? ((target, deviceToken) => { saveActiveConnection(target, deviceToken); }))(serverUrl, token);
  } catch (cause) {
    err(`pievo: could not save connection: ${cause instanceof Error ? cause.message : String(cause)}\n`);
    return 1;
  }
  if (identityChanged) out(`replaced saved identity for ${serverUrl}\n`);
  return (injected.start ?? ((startArgs) => runDaemonStart(startArgs)))([]);
}

export function runDaemonConnections(args: string[], injected: Pick<DaemonConnectDeps, "readConfig" | "out" | "err"> = {}): number {
  const out = injected.out ?? ((s: string) => process.stdout.write(s));
  const err = injected.err ?? ((s: string) => process.stderr.write(s));
  if (args.length) {
    err("pievo: usage: pievo daemon connections\n");
    return 2;
  }
  const config = (injected.readConfig ?? readConnections)();
  const urls = Object.keys(config.connections).sort();
  if (!urls.length) {
    out("no saved daemon connections\n");
    return 0;
  }
  out("pievo daemon connections:\n");
  for (const url of urls) out(`  ${url === config.active ? "*" : " "} ${url}\n`);
  return 0;
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

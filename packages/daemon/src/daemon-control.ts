/** `pievo daemon status` and `pievo daemon stop` inspect and stop this
 * machine's detached daemon.
 *
 * Both are built on the local pidfile (`pidfile.ts`): the daemon records its pid
 * on boot, so status can report it and stop can signal it — no
 * round-trip to the server required. `status` ALSO reports what's locally
 * knowable about identity (the configured server URL, whether a device token is
 * stored) and, best-effort, the server's view (online + machine name) when both
 * a server and token are available. Nothing is fabricated: an unreachable server
 * or absent pidfile simply degrades to "unknown / can't tell locally".
 *
 * Every external touch (pidfile read, liveness probe, start-time lookup, kill,
 * server fetch, output) is an injectable seam so the tests need no real process
 * or network.
 */
import path from "node:path";

import { DEVICE_FILE, PIEVO_DIR, readStored, resolveServerUrl } from "./config.js";
import { boundedFetch } from "./http.js";
import { readPidFile, clearPidFile, isAlive, processStartTime, verifiedRunningPid, type PidRecord } from "./pidfile.js";
import { readReportDiagnostics } from "./report-outbox.js";
import { readRuntimeDiagnostics, type RuntimeDiagnostics } from "./runtime-diagnostics.js";

export type MachineStatus = {
  online: boolean;
  name: string | null;
  lastSeen?: string | null;
  daemonProtocol?: number | null;
  currentRuns?: Array<{ runId: string; stage: "executing" | "reporting"; cancelPending?: boolean }>;
};

/** Best-effort server view of this machine (`/api/machine/status`) — shared by
 *  status's connection line and `pievo daemon start`'s readiness probe. Bounded (3s)
 *  and swallow-all: an unreachable/hung server degrades to undefined, never a
 *  crash or a long stall. */
export async function fetchMachineStatus(server: string, token: string): Promise<MachineStatus | undefined> {
  try {
    const res = await boundedFetch(
      `${server}/api/machine/status`,
      { headers: { Authorization: `Bearer ${token}` } },
      3000,
    );
    if (!res.ok) return undefined;
    return (await res.json()) as MachineStatus;
  } catch {
    return undefined;
  }
}

export type DaemonControlDeps = {
  readPid?: () => PidRecord | undefined;
  alive?: (pid: number) => boolean;
  startTime?: (pid: number) => string | undefined;
  clearPid?: () => void;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  fetchOnline?: (server: string, token: string) => Promise<MachineStatus | undefined>;
  out?: (s: string) => void;
  err?: (s: string) => void;
  reportDiagnostics?: () => { pendingRunIds: string[]; poisonedRunIds: string[]; lastError?: string };
  runtimeDiagnostics?: () => RuntimeDiagnostics | undefined;
  // The local config inputs `status` reports — overridable so tests are isolated
  // from the ambient ~/.pievo. Omitted ⇒ read from disk.
  server?: string;
  token?: string;
};

type Seams = Required<Omit<DaemonControlDeps, "server" | "token">>;

function deps(d: DaemonControlDeps): Seams {
  return {
    readPid: d.readPid ?? readPidFile,
    alive: d.alive ?? isAlive,
    startTime: d.startTime ?? processStartTime,
    clearPid: d.clearPid ?? clearPidFile,
    kill: d.kill ?? ((pid, signal) => process.kill(pid, signal)),
    sleep: d.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    fetchOnline: d.fetchOnline ?? fetchMachineStatus,
    out: d.out ?? ((s) => process.stdout.write(s)),
    err: d.err ?? ((s) => process.stderr.write(s)),
    reportDiagnostics: d.reportDiagnostics ?? (() => readReportDiagnostics(path.join(PIEVO_DIR, "pending-reports.sqlite"))),
    runtimeDiagnostics: d.runtimeDiagnostics ?? (() => readRuntimeDiagnostics(path.join(PIEVO_DIR, "runtime-status.json"))),
  };
}

export async function runDaemonStatus(args: string[], injected: DaemonControlDeps = {}): Promise<number> {
  if (args.length > 0) {
    (injected.err ?? ((s: string) => process.stderr.write(s)))("pievo: usage: pievo daemon status\n");
    return 2;
  }
  const d = deps(injected);
  const server = "server" in injected ? (injected.server ?? "") : resolveServerUrl(undefined);
  const token = "token" in injected ? injected.token : readStored(DEVICE_FILE);
  // The shared pidfile.verifiedRunningPid check (reused-pid safe), fed our seams.
  const pid = verifiedRunningPid(d);

  d.out("pievo daemon status:\n");
  d.out(
    pid !== undefined
      ? `  daemon:    running (pid ${pid})\n`
      : "  daemon:    not running — run `pievo daemon start` to start it\n",
  );
  d.out(`  server:    ${server || "not configured — run `pievo daemon start --server-url <url>`"}\n`);
  if (!token) d.out("  identity:  no device token — run `pievo daemon start`\n");
  const report = d.reportDiagnostics();
  // The runtime file is a live-process handoff, not durable execution authority.
  // Ignore stale contents when the verified daemon pid is absent.
  const runtime = pid !== undefined ? d.runtimeDiagnostics() : undefined;
  const pendingRunIds = report.pendingRunIds;
  const pendingSet = new Set(pendingRunIds);
  const runtimeRuns = runtime?.currentRuns ?? [];
  for (const run of runtimeRuns) if (!pendingSet.has(run.runId)) d.out(`  current run: ${run.runId} (${run.stage})\n`);
  if (runtime?.cancelPendingRunIds?.length) d.out("  cancel pending: stop requested; waiting for daemon confirmation\n");
  if (runtime?.persistenceError) {
    d.out(`  local persistence: needs attention — ${runtime.persistenceError}\n`);
    d.out(`  report database: ${runtime.outboxPath ?? "unknown"}; affected runs remain occupied\n`);
  }
  const poisonedSet = new Set(report.poisonedRunIds);
  for (const runId of pendingRunIds) {
    d.out(`  current run: ${runId} (reporting)\n`);
    d.out(poisonedSet.has(runId)
      ? `  terminal report: needs attention (${runId}); affected loop remains occupied\n`
      : `  terminal report: saved locally; retrying (${runId})\n`);
  }
  if (report.lastError) d.out(`  last report error: ${report.lastError}\n`);

  // Best-effort: only the server can say whether this machine is currently
  // CONNECTED (the local pid being alive doesn't prove the poll loop is healthy).
  if (server && token) {
    const view = await d.fetchOnline(server, token);
    if (view) {
      d.out(`  server connectivity: ${view.online ? "online" : "offline"}${view.name ? ` (${view.name})` : ""}\n`);
      if (view.daemonProtocol === 3) d.out("  daemon protocol: 3\n");
      else d.out(`  daemon upgrade required: protocol ${view.daemonProtocol ?? "unknown"} -> 3; run \`npm install -g @kky42/pievo@latest\`, then \`pievo daemon restart\`\n`);
      const serverRuns = view.currentRuns ?? [];
      if (!runtimeRuns.length) for (const run of serverRuns) if (!pendingSet.has(run.runId)) d.out(`  current run: ${run.runId} (${run.stage})\n`);
      if (!runtime?.cancelPendingRunIds?.length && serverRuns.some((run) => run.cancelPending)) d.out("  cancel pending: stop requested; waiting for daemon confirmation\n");
    } else {
      d.out("  server connectivity: unknown — server unreachable\n");
      d.out("  daemon protocol: 3 locally; server support unknown\n");
    }
  } else {
    d.out("  daemon protocol: 3 locally; server not configured\n");
  }
  return 0;
}

const FORCE_DOWN_WAIT_STEPS = 100;
const DOWN_WAIT_MS = 100;

export async function runDaemonStop(args: string[], injected: DaemonControlDeps = {}): Promise<number> {
  const force = args.length === 1 && args[0] === "--force";
  if (args.length > 0 && !force) {
    (injected.err ?? ((s: string) => process.stderr.write(s)))("pievo: usage: pievo daemon stop [--force]\n");
    return 2;
  }
  const d = deps(injected);
  const record = d.readPid();
  const pid = verifiedRunningPid({ ...d, readPid: () => record });

  if (pid === undefined) {
    d.out("no daemon running for this machine\n");
    return 0;
  }
  // Never signal a merely-live numeric PID. Current pidfiles always carry the
  // process start time; a malformed file or failed identity lookup requires
  // manual inspection rather than risking an unrelated reused process.
  const confirmedStart = record?.startTime ? d.startTime(pid) : undefined;
  if (!record?.startTime || confirmedStart !== record.startTime) {
    d.err(`pievo: refusing to stop pid ${pid} because process identity cannot be confirmed\n`);
    return 1;
  }

  if (force) {
    d.err("pievo: WARNING: --force may discard a terminal result that is not durable yet and may leave local/external side effects uncertain\n");
  }

  try {
    d.kill(pid, "SIGTERM");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      // Raced: the daemon exited between the liveness probe and the signal.
      d.clearPid();
      d.out("no daemon running for this machine\n");
      return 0;
    }
    d.err(`pievo: could not stop daemon (pid ${pid}): ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  // Keep the old pidfile authoritative until that exact process is gone. This
  // is the handoff fence that prevents `restart` from starting daemon #2 while
  // daemon #1 is still persisting its terminal report.
  const sameProcessAlive = () => {
    if (!d.alive(pid)) return false;
    if (!record?.startTime) return true;
    const current = d.startTime(pid);
    return current === undefined || current === record.startTime;
  };
  // Default is correctness-first and waits forever for the report durability
  // boundary. --force is the explicit operator escape hatch: allow TERM enough
  // time to stop the provider process group, then abandon a stuck local write.
  let waits = 0;
  while (sameProcessAlive() && (!force || waits < FORCE_DOWN_WAIT_STEPS)) {
    waits += 1;
    await d.sleep(DOWN_WAIT_MS);
  }
  if (force && sameProcessAlive()) {
    // A delayed SIGKILL requires positive identity, not merely a live numeric PID:
    // the daemon may have exited and the OS may have reused its pid during TERM.
    const currentStart = record?.startTime ? d.startTime(pid) : undefined;
    if (!record?.startTime || currentStart !== record.startTime) {
      d.err(`pievo: refusing delayed SIGKILL for pid ${pid} because process identity cannot be confirmed\n`);
      return 1;
    }
    try {
      d.kill(pid, "SIGKILL");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
        d.err(`pievo: could not force-stop daemon (pid ${pid}): ${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
      }
    }
    let killWaits = 0;
    while (sameProcessAlive() && killWaits < FORCE_DOWN_WAIT_STEPS) {
      killWaits += 1;
      await d.sleep(DOWN_WAIT_MS);
    }
    if (sameProcessAlive()) {
      d.err(`pievo: daemon pid ${pid} did not exit after SIGKILL\n`);
      return 1;
    }
  }
  d.clearPid();
  d.out(`stopped daemon (pid ${pid})\n`);
  return 0;
}

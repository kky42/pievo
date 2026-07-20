/**
 * `pievo status` and `pievo down` — the owner-outside-a-run commands that
 * inspect and stop THIS machine's detached daemon (the one `pievo up` started).
 *
 * Both are built on the local pidfile (`pidfile.ts`): the daemon records its pid
 * on boot, so `status` can say "running (pid N)" and `down` can signal it — no
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
  currentRun?: { runId: string; stage: "executing" | "reporting"; cancelPending?: boolean };
  cancelPending?: boolean;
  blockedRunId?: string | null;
  runConflict?: { daemonRunId: string; serverRunId: string };
  reliability?: { terminalGraceLeases: number; retiredLeases: number; reportReceipts: number };
};

/** Best-effort server view of this machine (`/api/machine/status`) — shared by
 *  `status`'s connection line and `pievo up`'s readiness probe. Bounded (3s)
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

export type ControlDeps = {
  readPid?: () => PidRecord | undefined;
  alive?: (pid: number) => boolean;
  startTime?: (pid: number) => string | undefined;
  clearPid?: () => void;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  fetchOnline?: (server: string, token: string) => Promise<MachineStatus | undefined>;
  out?: (s: string) => void;
  err?: (s: string) => void;
  reportDiagnostics?: () => { pendingRunId?: string; poisoned: boolean; lastError?: string };
  runtimeDiagnostics?: () => RuntimeDiagnostics | undefined;
  // The local config inputs `status` reports — overridable so tests are isolated
  // from the ambient ~/.pievo. Omitted ⇒ read from disk.
  server?: string;
  token?: string;
};

type Seams = Required<Omit<ControlDeps, "server" | "token">>;

function deps(d: ControlDeps): Seams {
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

export async function runStatus(args: string[], injected: ControlDeps = {}): Promise<number> {
  const d = deps(injected);
  const server = "server" in injected ? (injected.server ?? "") : resolveServerUrl(undefined);
  const token = "token" in injected ? injected.token : readStored(DEVICE_FILE);
  // The shared pidfile.verifiedRunningPid check (reused-pid safe), fed our seams.
  const pid = verifiedRunningPid(d);

  d.out("pievo status:\n");
  d.out(
    pid !== undefined
      ? `  daemon:    running (pid ${pid})\n`
      : "  daemon:    not running — run `pievo up` to start it\n",
  );
  d.out(`  server:    ${server || "not configured — run `pievo up --server-url <url>`"}\n`);
  if (!token) d.out("  identity:  no device token — run `pievo up`\n");
  const report = d.reportDiagnostics();
  // The runtime file is a live-process handoff, not durable execution authority.
  // Ignore stale contents when the verified daemon pid is absent.
  const runtime = pid !== undefined ? d.runtimeDiagnostics() : undefined;
  if (runtime?.currentRun && runtime.currentRun.runId !== report.pendingRunId) {
    d.out(`  current run: ${runtime.currentRun.runId} (${runtime.currentRun.stage})\n`);
  }
  if (runtime?.cancelPending) d.out("  cancel pending: stop requested; waiting for daemon confirmation\n");
  if (runtime?.blockedRunId) d.out(`  blocked prior run: ${runtime.blockedRunId} — previous run state is unknown; no new work will start\n`);
  if (runtime?.runConflict) d.out(`  run conflict: daemon ${runtime.runConflict.daemonRunId}, server ${runtime.runConflict.serverRunId} — operator decision required; no new work will start\n`);
  if (runtime?.persistenceError) {
    d.out(`  local persistence: needs attention — ${runtime.persistenceError}\n`);
    d.out(`  report database: ${runtime.outboxPath ?? "unknown"}; new work is blocked\n`);
  }
  if (report.poisoned) {
    d.out(`  terminal report: needs attention (${report.pendingRunId ?? "unknown run"}); new work is blocked\n`);
  } else if (report.pendingRunId) {
    d.out(`  current run: ${report.pendingRunId} (reporting)\n`);
    d.out(`  terminal report: saved locally; retrying (${report.pendingRunId})\n`);
  }
  if (report.lastError) d.out(`  last report error: ${report.lastError}\n`);

  // Best-effort: only the server can say whether this machine is currently
  // CONNECTED (the local pid being alive doesn't prove the poll loop is healthy).
  if (server && token) {
    const view = await d.fetchOnline(server, token);
    if (view) {
      d.out(`  server connectivity: ${view.online ? "online" : "offline"}${view.name ? ` (${view.name})` : ""}\n`);
      if (view.daemonProtocol === 2) d.out("  daemon protocol: 2\n");
      else d.out(`  daemon update required: protocol ${view.daemonProtocol ?? "unknown"} -> 2\n`);
      if (!runtime?.currentRun && view.currentRun && view.currentRun.runId !== report.pendingRunId) {
        d.out(`  current run: ${view.currentRun.runId} (${view.currentRun.stage})\n`);
      }
      if (!runtime?.cancelPending && (view.cancelPending || view.currentRun?.cancelPending)) d.out("  cancel pending: stop requested; waiting for daemon confirmation\n");
      if (!runtime?.blockedRunId && view.blockedRunId) d.out(`  blocked prior run: ${view.blockedRunId} — previous run state is unknown; no new work will start\n`);
      if (!runtime?.runConflict && view.runConflict) d.out(`  run conflict: daemon ${view.runConflict.daemonRunId}, server ${view.runConflict.serverRunId} — operator decision required; no new work will start\n`);
      if (view.reliability) d.out(`  server lifecycle: ${view.reliability.terminalGraceLeases} terminal-grace, ${view.reliability.retiredLeases} retired, ${view.reliability.reportReceipts} report receipts\n`);
    } else {
      d.out("  server connectivity: unknown — server unreachable\n");
      d.out("  daemon protocol: 2 locally; server support unknown\n");
    }
  } else {
    d.out("  daemon protocol: 2 locally; server not configured\n");
  }
  return 0;
}

export async function runDown(args: string[], injected: ControlDeps = {}): Promise<number> {
  const d = deps(injected);
  const record = d.readPid();
  const pid = verifiedRunningPid({ ...d, readPid: () => record });

  if (pid === undefined) {
    d.out("no daemon running for this machine\n");
    return 0;
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
  // is the handoff fence that prevents `update` from starting daemon #2 while
  // daemon #1 is still persisting its terminal report.
  const sameProcessAlive = () => {
    if (!d.alive(pid)) return false;
    if (!record?.startTime) return true;
    const current = d.startTime(pid);
    return current === undefined || current === record.startTime;
  };
  // Do not impose a SIGKILL deadline here. The daemon may still be terminating
  // a provider tree or retrying the local SQLite write that makes its terminal
  // report durable. Handoff must wait for that exact process to exit; killing it
  // to make update faster would violate persist-before-restart.
  while (sameProcessAlive()) await d.sleep(100);
  d.clearPid();
  d.out(`stopped daemon (pid ${pid})\n`);
  return 0;
}

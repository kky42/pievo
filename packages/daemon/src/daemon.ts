/** Protocol-v2 fixed single-flight daemon runtime. */
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { boundedFetch } from "./http.js";
import { logger } from "./logger.js";
import { executeDelivery, RUN_CANCEL_REASON, type Delivery } from "./runner.js";
import { PendingReportOutbox, sendTerminalReport, type TerminalReport } from "./report-outbox.js";
import { DEVICE_FILE, PIEVO_DIR, SERVER_FILE, persist, readStored } from "./config.js";
import { ensureCallbackBin } from "./callback-bin.js";
import { WatchManager, type WatchSpec } from "./watcher.js";
import { writePidFile, clearPidFile, verifiedRunningPid } from "./pidfile.js";
import { daemonVersion, writeRunningVersion } from "./version.js";
import { writeRuntimeDiagnostics } from "./runtime-diagnostics.js";

const POLL_MS = Number(process.env.PIEVO_POLL_MS || 3000);
const POLL_TIMEOUT_MS = 30_000;
const REPOLL_MS = 250;
const SHUTDOWN_REASON = "pievo:daemon-shutdown";
export type RunStage = "executing" | "reporting";
export type CurrentRun = { runId: string; stage: RunStage };

type Execute = (delivery: Delivery, serverUrl: string, roots: string[], signal: AbortSignal) => Promise<TerminalReport>;

/** Owns the daemon's sole execution/report slot. The slot remains occupied after
 * execution until its durable report receives a definitive acknowledgement. */
export class SingleFlightRuntime {
  private active: { runId: string; stage: RunStage; abortController: AbortController; cancelRequested: boolean } | null;
  private execution: Promise<void> | null = null;

  constructor(
    private readonly outbox: PendingReportOutbox,
    private readonly execute: Execute = executeDelivery,
    private readonly onState: (state: { currentRun: CurrentRun | null; cancelPending: boolean }) => void = () => {},
  ) {
    const pending = outbox.peek();
    this.active = pending ? { runId: pending.runId, stage: "reporting", abortController: new AbortController(), cancelRequested: false } : null;
    this.emitState();
  }

  currentRun(): CurrentRun | null { return this.active ? { runId: this.active.runId, stage: this.active.stage } : null; }
  private emitState(): void { this.onState({ currentRun: this.currentRun(), cancelPending: this.active?.cancelRequested ?? false }); }
  poisoned(): boolean { return this.outbox.diagnostics().poisoned; }

  async accept(delivery: Delivery, serverUrl: string, roots: string[]): Promise<boolean> {
    if (this.active || this.outbox.peek()) return false;
    const controller = new AbortController();
    this.active = { runId: delivery.runId, stage: "executing", abortController: controller, cancelRequested: false };
    this.emitState();
    this.execution = (async () => {
      let terminal: TerminalReport;
      try {
        terminal = await this.execute(delivery, serverUrl, roots, controller.signal);
      } catch (err) {
        terminal = {
          reportId: randomUUID(), runId: delivery.runId, result: "failure", durationMs: 0, exitCode: null,
          ok: false, error: err instanceof Error ? err.message : String(err),
        };
      }
      // SQLite commit is the boundary: stage cannot become reporting and the
      // slot cannot be released—or graceful shutdown complete—until the exact
      // payload is durable. A transient local lock/I/O error must not turn a
      // terminal result into process exit and data loss.
      for (;;) {
        try {
          this.outbox.put(delivery.runToken, terminal);
          break;
        } catch (err) {
          logger.error({ runId: delivery.runId, err: err instanceof Error ? err.message : String(err) }, "terminal report persistence failed; retrying before exit");
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
      if (this.active?.runId === delivery.runId) this.active.stage = "reporting";
      this.emitState();
    })();
    await this.execution;
    return true;
  }

  start(delivery: Delivery, serverUrl: string, roots: string[]): boolean {
    if (this.active || this.outbox.peek()) return false;
    void this.accept(delivery, serverUrl, roots).catch((err) => logger.error({ err }, "execution persistence failed"));
    return true;
  }

  cancel(runId: string): boolean {
    if (!this.active || this.active.runId !== runId || this.active.stage !== "executing") return false;
    if (!this.active.cancelRequested) {
      this.active.cancelRequested = true;
      this.active.abortController.abort(RUN_CANCEL_REASON);
      this.emitState();
    }
    return true;
  }

  shutdown(): void {
    if (this.active?.stage === "executing" && !this.active.abortController.signal.aborted) {
      this.active.abortController.abort(SHUTDOWN_REASON);
    }
  }

  async waitForPersistence(): Promise<void> {
    if (this.execution) await this.execution;
  }

  async sendPending(serverUrl: string, force = false): Promise<void> {
    const pending = this.outbox.peek();
    if (!pending || this.poisoned() || (!force && pending.nextAttemptAt > Date.now())) return;
    const ack = await sendTerminalReport(serverUrl, pending);
    this.outbox.applyAck(ack);
    if (!this.outbox.peek()) this.active = null;
    else if (ack.kind === "conflict") logger.error({ runId: pending.runId }, "REPORT_CONFLICT: terminal report needs attention; new work is blocked");
    this.emitState();
  }
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export function buildPollBody(info: Record<string, unknown>, currentRun: CurrentRun | null, watchDigest: string | undefined): Record<string, unknown> {
  return { protocolVersion: 2, ...info, ...(currentRun ? { currentRun } : {}), ...(watchDigest ? { watchDigest } : {}) };
}

export function nextPollDelayMs(elapsedMs: number, pollMs = POLL_MS): number {
  return Math.max(REPOLL_MS, pollMs - elapsedMs);
}

function resolveStored(file: string, explicit: string | undefined): string | undefined {
  if (explicit) { persist(file, explicit); return explicit; }
  return readStored(file);
}

export async function runDaemon(): Promise<number> {
  const token = resolveStored(DEVICE_FILE, flag("--api-key") || process.env.PIEVO_TOKEN);
  const server = resolveStored(SERVER_FILE, (flag("--server-url") || process.env.PIEVO_SERVER_URL)?.replace(/\/$/, ""));
  if (!token || !server) { logger.error("pass --server-url <url> --api-key <token> (or set PIEVO_SERVER_URL / PIEVO_TOKEN)"); return 1; }
  const roots = (process.env.PIEVO_ROOTS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const info = { host: os.hostname(), platform: process.platform, arch: process.arch, version: daemonVersion() };
  const existing = verifiedRunningPid();
  if (existing !== undefined) { logger.error({ pid: existing }, "daemon already running — use `pievo down` first"); return 1; }

  ensureCallbackBin();
  writePidFile();
  writeRunningVersion();
  const pollAbort = new AbortController();
  let stopping = false;
  const outbox = new PendingReportOutbox(path.join(PIEVO_DIR, "pending-reports.sqlite"));
  const runtimeStatusFile = path.join(PIEVO_DIR, "runtime-status.json");
  let blockedRunId: string | undefined;
  let runtimeState: { currentRun: CurrentRun | null; cancelPending: boolean } = { currentRun: null, cancelPending: false };
  const persistRuntime = () => {
    try {
      writeRuntimeDiagnostics(runtimeStatusFile, {
        protocolVersion: 2,
        ...(runtimeState.currentRun ? { currentRun: runtimeState.currentRun } : {}),
        ...(runtimeState.cancelPending ? { cancelPending: true } : {}),
        ...(blockedRunId ? { blockedRunId } : {}),
      });
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "could not persist runtime diagnostics");
    }
  };
  const runtime = new SingleFlightRuntime(outbox, executeDelivery, (state) => { runtimeState = state; persistRuntime(); });
  const onShutdown = () => { stopping = true; pollAbort.abort(SHUTDOWN_REASON); runtime.shutdown(); };
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, onShutdown);
  const watchManager = new WatchManager(server, token, roots);
  let watchDigest: string | undefined;

  logger.info({ server, protocolVersion: 2 }, "polling for deliveries");
  // Startup ordering is deliberate: replay once before machine polling can
  // observe or claim anything. Force ignores a persisted backoff timestamp;
  // failure leaves the slot in reporting state.
  await runtime.sendPending(server, true);

  while (!stopping) {
    const started = Date.now();
    try {
      const res = await boundedFetch(`${server}/api/machine/poll`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(buildPollBody(info, runtime.currentRun(), watchDigest)),
      }, POLL_TIMEOUT_MS, pollAbort.signal);
      if (res.status === 426) logger.error("daemon protocol rejected; update Pievo daemon (protocol 2 required)");
      else if (!res.ok) logger.warn({ status: res.status, statusText: res.statusText }, "poll non-ok");
      else {
        const data = await res.json() as { delivery?: Delivery | null; cancelRunId?: string; blockedRunId?: string | null; watch?: WatchSpec[]; watchDigest?: string };
        if (Array.isArray(data.watch)) watchManager.reconcile(data.watch);
        if (typeof data.watchDigest === "string") watchDigest = data.watchDigest;
        if (typeof data.cancelRunId === "string") runtime.cancel(data.cancelRunId);
        blockedRunId = data.blockedRunId || undefined;
        persistRuntime();
        if (data.blockedRunId) logger.warn({ runId: data.blockedRunId }, "previous run state is unknown; no new work will start");
        if (data.delivery) runtime.start(data.delivery, server, roots);
      }
      await runtime.sendPending(server);
    } catch (err) {
      if (!stopping) logger.error({ err: err instanceof Error ? err.message : String(err) }, "poll failed");
    }
    await sleep(nextPollDelayMs(Date.now() - started), pollAbort.signal);
  }

  runtime.shutdown();
  // Execution owns a bounded TERM→KILL subprocess shutdown, but report creation
  // and the synchronous SQLite commit are not optional. Never close the outbox
  // or exit while that persistence boundary is still in flight.
  await runtime.waitForPersistence();
  await watchManager.closeAll();
  outbox.close();
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.off(sig, onShutdown);
  clearPidFile(process.pid);
  return 0;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = () => { clearTimeout(t); resolve(); };
    const t = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

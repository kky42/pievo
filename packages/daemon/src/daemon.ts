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
import { daemonVersion } from "./version.js";
import { writeRuntimeDiagnostics } from "./runtime-diagnostics.js";

const POLL_MS = Number(process.env.PIEVO_POLL_MS || 3000);
const POLL_TIMEOUT_MS = 30_000;
const REPOLL_MS = 250;
const SHUTDOWN_REASON = "pievo:daemon-shutdown";
const PERSIST_RETRY_MS = [250, 1_000, 5_000, 30_000] as const;
const PERSIST_LOG_INTERVAL_MS = 60_000;
export type RunStage = "executing" | "reporting";
export type CurrentRun = { runId: string; stage: RunStage };

type Execute = (delivery: Delivery, serverUrl: string, roots: string[], signal: AbortSignal) => Promise<TerminalReport>;

export function persistenceRetryDelayMs(attempt: number): number {
  return PERSIST_RETRY_MS[Math.min(Math.max(1, attempt) - 1, PERSIST_RETRY_MS.length - 1)]!;
}

/** Owns the daemon's sole execution/report slot. The slot remains occupied after
 * execution until its durable report receives a definitive acknowledgement. */
export class SingleFlightRuntime {
  private active: { runId: string; stage: RunStage; abortController: AbortController; cancelRequested: boolean } | null;
  private execution: Promise<void> | null = null;
  private persistenceError: string | undefined;

  constructor(
    private readonly outbox: PendingReportOutbox,
    private readonly execute: Execute = executeDelivery,
    private readonly onState: (state: { currentRun: CurrentRun | null; cancelPending: boolean; persistenceError?: string; outboxPath: string }) => void = () => {},
  ) {
    const pending = outbox.peek();
    this.active = pending ? { runId: pending.runId, stage: "reporting", abortController: new AbortController(), cancelRequested: false } : null;
    this.emitState();
  }

  currentRun(): CurrentRun | null { return this.active ? { runId: this.active.runId, stage: this.active.stage } : null; }
  private emitState(): void {
    this.onState({ currentRun: this.currentRun(), cancelPending: this.active?.cancelRequested ?? false, outboxPath: this.outbox.file, ...(this.persistenceError ? { persistenceError: this.persistenceError } : {}) });
  }
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
          error: err instanceof Error ? err.message : String(err),
        };
      }
      // SQLite commit is the boundary: stage cannot become reporting and the
      // slot cannot be released—or graceful shutdown complete—until the exact
      // payload is durable. A transient local lock/I/O error must not turn a
      // terminal result into process exit and data loss.
      let persistenceAttempts = 0;
      let lastLoggedError: string | undefined;
      let lastLoggedAt = 0;
      for (;;) {
        try {
          this.outbox.put(delivery.runToken, terminal);
          this.persistenceError = undefined;
          break;
        } catch (err) {
          persistenceAttempts += 1;
          const message = err instanceof Error ? err.message : String(err);
          if (this.persistenceError !== message) {
            this.persistenceError = message;
            this.emitState();
          }
          const now = Date.now();
          if (message !== lastLoggedError || now - lastLoggedAt >= PERSIST_LOG_INTERVAL_MS) {
            logger.error({ runId: delivery.runId, err: message, persistenceAttempts }, "terminal report persistence failed; new work remains blocked while retrying");
            lastLoggedError = message;
            lastLoggedAt = now;
          }
          await new Promise((resolve) => setTimeout(resolve, persistenceRetryDelayMs(persistenceAttempts)));
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
    else if (ack.kind === "conflict" || ack.kind === "invalid") logger.error({ runId: pending.runId }, `${ack.kind === "conflict" ? "REPORT_CONFLICT" : "REPORT_INVALID"}: terminal report needs attention; new work is blocked`);
    this.emitState();
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export function buildPollBody(info: Record<string, unknown>, currentRun: CurrentRun | null, watchDigest: string | undefined): Record<string, unknown> {
  return { protocolVersion: 2, ...info, ...(currentRun ? { currentRun } : {}), ...(watchDigest ? { watchDigest } : {}) };
}

export function nextPollDelayMs(elapsedMs: number, pollMs = POLL_MS): number {
  return Math.max(REPOLL_MS, pollMs - elapsedMs);
}

export function nextRunConflict(
  previous: { daemonRunId: string; serverRunId: string } | undefined,
  incoming: { daemonRunId: string; serverRunId: string } | undefined,
  currentRun: CurrentRun | null,
) {
  return incoming ?? (currentRun ? previous : undefined);
}

function resolveStored(file: string, explicit: string | undefined): string | undefined {
  if (explicit) { persist(file, explicit); return explicit; }
  return readStored(file);
}

export async function runDaemon(args: string[] = []): Promise<number> {
  const token = resolveStored(DEVICE_FILE, process.env.PIEVO_TOKEN);
  const server = resolveStored(SERVER_FILE, (flag(args, "--server-url") || process.env.PIEVO_SERVER_URL)?.replace(/\/$/, ""));
  if (!token || !server) { logger.error("run `pievo daemon start --server-url <url> --connect-key <dk_…>` first"); return 1; }
  const roots = (process.env.PIEVO_ROOTS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const info = { host: os.hostname(), platform: process.platform, arch: process.arch, version: daemonVersion() };
  const existing = verifiedRunningPid();
  if (existing !== undefined) { logger.error({ pid: existing }, "daemon already running — use `pievo daemon stop` first"); return 1; }

  ensureCallbackBin();
  writePidFile();
  const pollAbort = new AbortController();
  let stopping = false;
  const outbox = new PendingReportOutbox(path.join(PIEVO_DIR, "pending-reports.sqlite"));
  const runtimeStatusFile = path.join(PIEVO_DIR, "runtime-status.json");
  let blockedRunId: string | undefined;
  let lastNeedsUpdateKey: string | undefined;
  let runConflict: { daemonRunId: string; serverRunId: string } | undefined;
  let runtimeState: { currentRun: CurrentRun | null; cancelPending: boolean; persistenceError?: string; outboxPath?: string } = { currentRun: null, cancelPending: false };
  const persistRuntime = () => {
    try {
      writeRuntimeDiagnostics(runtimeStatusFile, {
        protocolVersion: 2,
        ...(runtimeState.currentRun ? { currentRun: runtimeState.currentRun } : {}),
        ...(runtimeState.cancelPending ? { cancelPending: true } : {}),
        ...(blockedRunId ? { blockedRunId } : {}),
        ...(runConflict ? { runConflict } : {}),
        ...(runtimeState.persistenceError ? { persistenceError: runtimeState.persistenceError } : {}),
        ...(runtimeState.outboxPath ? { outboxPath: runtimeState.outboxPath } : {}),
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
      if (res.status === 426) logger.error("daemon protocol rejected; run `npm install -g @kky42/pievo@latest`, then `pievo daemon restart` (protocol 2 required)");
      else if (!res.ok) logger.warn({ status: res.status, statusText: res.statusText }, "poll non-ok");
      else {
        const data = await res.json() as { delivery?: Delivery | null; cancelRunId?: string; blockedRunId?: string | null; runConflict?: { daemonRunId: string; serverRunId: string }; needsUpdate?: { current: string | null; required: string; command: string }; watch?: WatchSpec[]; watchDigest?: string };
        if (Array.isArray(data.watch)) watchManager.reconcile(data.watch);
        if (typeof data.watchDigest === "string") watchDigest = data.watchDigest;
        if (typeof data.cancelRunId === "string") runtime.cancel(data.cancelRunId);
        blockedRunId = data.blockedRunId || undefined;
        const incomingConflict = data.runConflict && typeof data.runConflict.daemonRunId === "string" && typeof data.runConflict.serverRunId === "string" ? data.runConflict : undefined;
        // Keep execution uncertainty visible until the local run reaches a
        // definitive report ACK (or an operator stops the daemon). A transient
        // change in the server's running row is not reconciliation.
        runConflict = nextRunConflict(runConflict, incomingConflict, runtime.currentRun());
        persistRuntime();
        if (data.blockedRunId) logger.warn({ runId: data.blockedRunId }, "previous run state is unknown; no new work will start");
        const needsUpdateKey = data.needsUpdate ? `${data.needsUpdate.current ?? "unknown"}->${data.needsUpdate.required}` : undefined;
        if (data.needsUpdate && needsUpdateKey !== lastNeedsUpdateKey) logger.error(data.needsUpdate, "daemon update required by server; no new work will start");
        lastNeedsUpdateKey = needsUpdateKey;
        if (runConflict) logger.error(runConflict, "local/server run conflict; no new work will start");
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

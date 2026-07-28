import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { boundedFetch } from "./http.js";
import { logger } from "./logger.js";
import { executeDelivery, RUN_CANCEL_REASON, type Delivery } from "./runner.js";
import { PendingReportOutbox, sendTerminalReport, type PersistedReport, type ReportAck, type TerminalReport } from "./report-outbox.js";
import { activeConnection, PIEVO_DIR, serverOutboxPath } from "./config.js";
import { ensureCallbackBin } from "./callback-bin.js";
import { writePidFile, clearPidFile, verifiedRunningPid } from "./pidfile.js";
import { daemonVersion } from "./version.js";
import { writeRuntimeDiagnostics } from "./runtime-diagnostics.js";
import { parsePollResponse } from "./poll-protocol.js";
import { DAEMON_PROTOCOL_VERSION } from "./protocol.js";

const POLL_MS = Number(process.env.PIEVO_POLL_MS || 3000);
const POLL_TIMEOUT_MS = 30_000;
const REPOLL_MS = 250;
const SHUTDOWN_REASON = "pievo:daemon-shutdown";
const PERSIST_RETRY_MS = [250, 1_000, 5_000, 30_000] as const;
const PERSIST_LOG_INTERVAL_MS = 60_000;
const REPORT_SEND_CONCURRENCY = 4;
export type RunStage = "executing" | "reporting";
export type CurrentRun = { runId: string; stage: RunStage };

type Execute = (delivery: Delivery, serverUrl: string, roots: string[], signal: AbortSignal) => Promise<TerminalReport>;
type SendReport = (serverUrl: string, report: PersistedReport, signal: AbortSignal) => Promise<ReportAck>;

export function persistenceRetryDelayMs(attempt: number): number {
  return PERSIST_RETRY_MS[Math.min(Math.max(1, attempt) - 1, PERSIST_RETRY_MS.length - 1)]!;
}

/** Owns independent execution/report state for every delivered loop. A run stays
 * active after execution until its exact durable report receives a definitive ACK. */
export class ConcurrentRuntime {
  private readonly active = new Map<string, { loopId?: string; stage: RunStage; abortController: AbortController; cancelRequested: boolean }>();
  private readonly executions = new Map<string, Promise<void>>();
  private reportDrain: Promise<void> | null = null;
  private readonly reportAbort = new AbortController();
  private readonly persistenceErrors = new Map<string, string>();

  constructor(
    private readonly outbox: PendingReportOutbox,
    private readonly execute: Execute = executeDelivery,
    private readonly onState: (state: { currentRuns: CurrentRun[]; cancelPendingRunIds: string[]; persistenceError?: string; outboxPath: string }) => void = () => {},
    private readonly sendReport: SendReport = (serverUrl, report, signal) => sendTerminalReport(serverUrl, report, undefined, signal),
  ) {
    for (const pending of outbox.all()) {
      this.active.set(pending.runId, { stage: "reporting", abortController: new AbortController(), cancelRequested: false });
    }
    this.emitState();
  }

  currentRuns(): CurrentRun[] {
    return [...this.active].map(([runId, run]) => ({ runId, stage: run.stage }));
  }
  private emitState(): void {
    const cancelPendingRunIds = [...this.active].filter(([, run]) => run.cancelRequested).map(([runId]) => runId);
    const persistenceError = this.persistenceErrors.values().next().value;
    this.onState({
      currentRuns: this.currentRuns(),
      cancelPendingRunIds,
      outboxPath: this.outbox.file,
      ...(typeof persistenceError === "string" ? { persistenceError } : {}),
    });
  }

  private canAccept(delivery: Delivery): boolean {
    return !this.active.has(delivery.runId) && ![...this.active.values()].some((run) => run.loopId === delivery.loop.id);
  }

  async accept(delivery: Delivery, serverUrl: string, roots: string[]): Promise<boolean> {
    if (!this.canAccept(delivery)) return false;
    const controller = new AbortController();
    this.active.set(delivery.runId, { loopId: delivery.loop.id, stage: "executing", abortController: controller, cancelRequested: false });
    this.emitState();
    const execution = (async () => {
      let terminal: TerminalReport;
      try {
        terminal = await this.execute(delivery, serverUrl, roots, controller.signal);
      } catch (err) {
        terminal = {
          reportId: randomUUID(), runId: delivery.runId, result: "failure", durationMs: 0, exitCode: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      // Each exact payload crosses the same synchronous SQLite durability
      // boundary independently. A failed local write retries forever without
      // discarding this run or stopping unrelated loops from executing.
      let persistenceAttempts = 0;
      let lastLoggedError: string | undefined;
      let lastLoggedAt = 0;
      for (;;) {
        try {
          this.outbox.put(delivery.runToken, terminal);
          this.persistenceErrors.delete(delivery.runId);
          break;
        } catch (err) {
          persistenceAttempts += 1;
          const message = err instanceof Error ? err.message : String(err);
          if (this.persistenceErrors.get(delivery.runId) !== message) {
            this.persistenceErrors.set(delivery.runId, message);
            this.emitState();
          }
          const now = Date.now();
          if (message !== lastLoggedError || now - lastLoggedAt >= PERSIST_LOG_INTERVAL_MS) {
            logger.error({ runId: delivery.runId, err: message, persistenceAttempts }, "terminal report persistence failed; this run remains occupied while retrying");
            lastLoggedError = message;
            lastLoggedAt = now;
          }
          await new Promise((resolve) => setTimeout(resolve, persistenceRetryDelayMs(persistenceAttempts)));
        }
      }
      const active = this.active.get(delivery.runId);
      if (active) active.stage = "reporting";
      this.emitState();
    })().finally(() => this.executions.delete(delivery.runId));
    this.executions.set(delivery.runId, execution);
    await execution;
    return true;
  }

  start(delivery: Delivery, serverUrl: string, roots: string[]): boolean {
    if (!this.canAccept(delivery)) return false;
    void this.accept(delivery, serverUrl, roots).catch((err) => logger.error({ runId: delivery.runId, err }, "execution persistence failed"));
    return true;
  }

  cancel(runId: string): boolean {
    const active = this.active.get(runId);
    if (!active || active.stage !== "executing") return false;
    if (!active.cancelRequested) {
      active.cancelRequested = true;
      active.abortController.abort(RUN_CANCEL_REASON);
      this.emitState();
    }
    return true;
  }

  shutdown(): void {
    this.reportAbort.abort(SHUTDOWN_REASON);
    for (const active of this.active.values()) {
      if (active.stage === "executing" && !active.abortController.signal.aborted) active.abortController.abort(SHUTDOWN_REASON);
    }
  }

  async waitForPersistence(): Promise<void> {
    await Promise.all([...this.executions.values()]);
  }

  async waitForReportStop(): Promise<void> {
    if (this.reportDrain) await this.reportDrain;
  }

  async sendPending(serverUrl: string, force = false): Promise<void> {
    if (this.reportDrain) return this.reportDrain;
    const pending = force ? this.outbox.all() : this.outbox.ready();
    const drain = (async () => {
      const queue = [...pending];
      let failure: { error: unknown } | undefined;
      const worker = async () => {
        while (!this.reportAbort.signal.aborted) {
          const report = queue.shift();
          if (!report) return;
          try {
            const ack = await this.sendReport(serverUrl, report, this.reportAbort.signal);
            if (this.reportAbort.signal.aborted) return;
            this.outbox.applyAck(ack);
            if (!this.outbox.get(report.reportId)) this.active.delete(report.runId);
            this.emitState();
          } catch (error) {
            // A broken injected/custom transport must not prevent independent rows
            // from being attempted. Preserve the drain rejection after all workers stop.
            failure ??= { error };
          }
        }
      };
      const workers = Array.from(
        { length: Math.min(REPORT_SEND_CONCURRENCY, queue.length) },
        () => worker(),
      );
      await Promise.all(workers);
      if (failure) throw failure.error;
    })();
    this.reportDrain = drain;
    try {
      await drain;
    } finally {
      if (this.reportDrain === drain) this.reportDrain = null;
    }
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export function buildPollBody(
  info: Record<string, unknown>,
  currentRuns: CurrentRun[],
  daemonInstanceId: string,
): Record<string, unknown> {
  return { protocolVersion: DAEMON_PROTOCOL_VERSION, ...info, daemonInstanceId, recoveryComplete: true, currentRuns };
}

export function nextPollDelayMs(elapsedMs: number, pollMs = POLL_MS): number {
  return Math.max(REPOLL_MS, pollMs - elapsedMs);
}

export async function runDaemon(args: string[] = []): Promise<number> {
  if (args.length) { logger.error("daemon runtime does not accept connection arguments"); return 1; }
  const connection = activeConnection();
  const token = process.env.PIEVO_TOKEN || connection?.deviceToken;
  const server = connection?.serverUrl;
  if (!token || !server) { logger.error("run `pievo daemon connect --server-url <url> --connect-key <dk_…>` first"); return 1; }
  const roots = (process.env.PIEVO_ROOTS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const info = { host: os.hostname(), platform: process.platform, arch: process.arch, version: daemonVersion() };
  const daemonInstanceId = randomUUID();
  const existing = verifiedRunningPid();
  // A second daemon would replace the first daemon's pidfile, then clear it on exit,
  // leaving the original invisible to status/stop while both poll the server.
  if (existing !== undefined) { logger.error({ pid: existing }, "daemon already running — use `pievo daemon stop` first"); return 1; }

  ensureCallbackBin();
  writePidFile();
  const pollAbort = new AbortController();
  let stopping = false;
  const outbox = new PendingReportOutbox(serverOutboxPath(server));
  const runtimeStatusFile = path.join(PIEVO_DIR, "runtime-status.json");
  let lastNeedsUpdateKey: string | undefined;
  let runtimeState: { currentRuns: CurrentRun[]; cancelPendingRunIds: string[]; persistenceError?: string; outboxPath?: string } = { currentRuns: [], cancelPendingRunIds: [] };
  const persistRuntime = () => {
    try {
      writeRuntimeDiagnostics(runtimeStatusFile, {
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        currentRuns: runtimeState.currentRuns,
        ...(runtimeState.cancelPendingRunIds.length ? { cancelPendingRunIds: runtimeState.cancelPendingRunIds } : {}),
        ...(runtimeState.persistenceError ? { persistenceError: runtimeState.persistenceError } : {}),
        ...(runtimeState.outboxPath ? { outboxPath: runtimeState.outboxPath } : {}),
      });
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "could not persist runtime diagnostics");
    }
  };
  const runtime = new ConcurrentRuntime(
    outbox,
    (delivery, serverUrl, allowedRoots, signal) => executeDelivery(delivery, serverUrl, allowedRoots, signal, token),
    (state) => { runtimeState = state; persistRuntime(); },
  );
  const onShutdown = () => { stopping = true; pollAbort.abort(SHUTDOWN_REASON); runtime.shutdown(); };
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, onShutdown);
  logger.info({ server, protocolVersion: DAEMON_PROTOCOL_VERSION }, "polling for deliveries");
  // Start replay immediately, but never let a slow report transport stall
  // heartbeats, cancellation, or delivery for unrelated loops.
  void runtime.sendPending(server, true).catch((err) => logger.error({ err }, "report replay failed"));

  while (!stopping) {
    const started = Date.now();
    try {
      const res = await boundedFetch(`${server}/api/machine/poll`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(buildPollBody(info, runtime.currentRuns(), daemonInstanceId)),
      }, POLL_TIMEOUT_MS, pollAbort.signal);
      if (res.status === 426) logger.error(`daemon protocol rejected; run \`npm install -g @kky42/pievo@latest\`, then \`pievo daemon restart\` (protocol ${DAEMON_PROTOCOL_VERSION} required)`);
      else if (!res.ok) logger.warn({ status: res.status, statusText: res.statusText }, "poll non-ok");
      else {
        const decoded = parsePollResponse(await res.json());
        if (!decoded.ok) throw new Error(`invalid poll response; no work was started and polling will retry: ${decoded.error}`);
        const data = decoded.value;
        for (const runId of data.cancelRunIds) runtime.cancel(runId);
        persistRuntime();
        const needsUpdateKey = data.needsUpdate ? `${data.needsUpdate.current ?? "unknown"}->${data.needsUpdate.required}` : undefined;
        if (data.needsUpdate && needsUpdateKey !== lastNeedsUpdateKey) logger.error(data.needsUpdate, "daemon update required by server; no new work will start");
        lastNeedsUpdateKey = needsUpdateKey;
        if (data.delivery && !runtime.start(data.delivery, server, roots)) {
          logger.error({ runId: data.delivery.runId, loopId: data.delivery.loop.id }, "rejected unexpected same-loop delivery");
        }
      }
      void runtime.sendPending(server).catch((err) => logger.error({ err }, "report retry failed"));
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
  await runtime.waitForReportStop();
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

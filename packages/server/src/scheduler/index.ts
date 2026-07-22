import { Cron } from "croner";

import { logger } from "../logger.js";
import * as store from "../db/store.js";
import type { EnqueueRunRequest, EnqueueRunResult } from "../db/store.js";
import type { Loop, Run } from "../db/schema.js";

const log = logger.child({ mod: "scheduler" });
const MAX_TIMER_MS = 2_147_483_647;
const DUE_RETRY_MS = 20_000;

/** Best-effort latency hint. Durable loop schedule facts and pending run rows are
 * authoritative; a daemon poll advances/claims them even if every timer is lost. */
export interface Dispatcher {
  dispatch(loop: Loop, run: Run): Promise<void> | void;
}

export type QueueResult = EnqueueRunResult;

/** Thin timer layer over durable schedule facts. All state transitions live in
 * the store; this class only arms hints and wakes parked machine polls. */
export class Scheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly dispatcher: Dispatcher) {}

  async start(signal: AbortSignal): Promise<void> {
    await store.initializeCronCadence();
    const all = await store.listLoops();
    for (const loop of all) this.addLoop(loop);
    // Recover facts that became due while no process was running. This is not
    // historical catch-up: only persisted due facts are consumed.
    await this.advanceDueSchedules();
    signal.addEventListener("abort", () => this.stopAll(), { once: true });
    log.info({ loops: all.length, timers: this.timers.size }, "scheduler started");
  }

  static nextRun(expr: string): Date {
    const probe = new Cron(expr, { paused: true });
    try {
      const next = probe.nextRun();
      if (!next) throw new Error(`cron expression never fires again: ${expr}`);
      return next;
    } finally {
      probe.stop();
    }
  }

  /** Re-arm this loop's next durable fact. Queue rows are never changed here. */
  addLoop(loop: Loop): void {
    this.armLoop(loop, false);
  }

  private armLoop(loop: Loop, retryDue: boolean): void {
    const old = this.timers.get(loop.id);
    if (old) clearTimeout(old);
    this.timers.delete(loop.id);
    if (!loop.enabled) return;
    const targets = [loop.nextCadenceAt, loop.nextRunAt]
      .filter((v): v is string => v != null)
      .map(Date.parse)
      .filter(Number.isFinite);
    if (!targets.length) return;
    const target = Math.min(...targets);
    const rawDelay = target - Date.now();
    // A due fact can be temporarily fenced by terminal-grace. Retry calmly;
    // poll fallback remains authoritative in the meantime.
    const delay = rawDelay <= 0 ? (retryDue ? DUE_RETRY_MS : 0) : Math.min(rawDelay, MAX_TIMER_MS);
    const timer = setTimeout(() => void this.fire(loop.id), delay);
    timer.unref?.();
    this.timers.set(loop.id, timer);
  }

  removeLoop(id: string): void {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
  }

  runNow(id: string): Promise<QueueResult> {
    return this.enqueue(id, { role: "exec", requestedBy: "owner" });
  }

  enqueueInitialExec(id: string): Promise<QueueResult> {
    return this.enqueue(id, { role: "exec", requestedBy: "system" });
  }

  evolveNow(id: string): Promise<QueueResult> {
    return this.enqueue(id, { role: "evolve", requestedBy: "owner" });
  }

  requestEdit(id: string, instruction: string): Promise<QueueResult> {
    return this.enqueue(id, { role: "edit", requestedBy: "owner", requestText: instruction });
  }

  /** Poll fallback and timer callback converge here. */
  async advanceDueSchedules(machineId?: string, loopId?: string): Promise<store.AdvancedSchedule[]> {
    const advanced = await store.advanceDueSchedules(new Date().toISOString(), { machineId, loopId });
    for (const item of advanced) {
      this.addLoop(item.loop);
      await this.wake(item.loop, item.run);
    }
    return advanced;
  }

  async runningIds(): Promise<string[]> {
    return [...new Set((await store.openRuns()).filter((r) => r.phase === "running").map((r) => r.loopId))];
  }

  private async enqueue(id: string, request: EnqueueRunRequest): Promise<QueueResult> {
    const result = await store.enqueueRun(id, request);
    if ("run" in result) {
      const loop = await store.getLoop(id);
      if (loop) await this.wake(loop, result.run);
    }
    return result;
  }

  private async fire(loopId: string): Promise<void> {
    this.timers.delete(loopId);
    try {
      await this.advanceDueSchedules(undefined, loopId);
    } catch (err) {
      log.warn({ loopId, err: msg(err) }, "schedule hint failed; polling will recover");
    } finally {
      const loop = await store.getLoop(loopId).catch(() => undefined);
      if (loop && !this.timers.has(loopId)) this.armLoop(loop, true);
    }
  }

  private async wake(loop: Loop, run: Run): Promise<void> {
    try {
      await this.dispatcher.dispatch(loop, run);
    } catch (err) {
      log.warn({ loopId: loop.id, runId: run.id, err: msg(err) }, "queue wake failed; polling will recover");
    }
  }

  private stopAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    log.info("scheduler stopped");
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

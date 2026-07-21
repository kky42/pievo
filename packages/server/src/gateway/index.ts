/**
 * Machine gateway - the run-lifecycle core of the HTTP surface the daemon talks
 * to (poll transport: short-poll while a run is in flight, opt-in server-held
 * long-poll while idle). Framework-agnostic like the rest of the gateway
 * (return `{ status, body }` so the methods can be mounted on a plain http
 * server or TanStack server routes):
 *
 *   POST /api/machine/poll   (Bearer device token) → claim pending runs, deliver
 *   POST /machine/report     (Bearer run token)    → finalize a run
 *
 * plus the owner verbs (createLoop/listLoops/editLoop/loopLog) and retention.
 * Also exposes `dispatcher` (a `Dispatcher` for the Scheduler: "is the machine
 * online?") and `sweep()` (mark stale machines offline, reclaim stuck runs).
 * The CLI verb dispatch (`/api/machine/cli` + `/agent-api/loop`) lives in
 * `gateway/cli.ts` (`CliGateway`), which reuses this class's methods; the
 * shared ui/schema validators live in `gateway/validate.ts`.
 */
import { Cron } from "croner";

import { logger } from "../logger.js";
import * as store from "../db/store.js";
import type { CodingAgent, Loop, NewLoop, NewRun, Run, RunRole, RunUsage } from "../db/schema.js";
import { CODING_AGENTS, coerceCodingAgent } from "../types.js";
import type { ReportIncident, ReportIncidentCode, ReportIncidentFaultDomain } from "../types.js";
import type { Scheduler } from "../scheduler/index.js";
import { buildDelivery, type Delivery } from "./delivery.js";
import { autopauseMessage, completionMessage, deferredMessage, dispatchNotification, failureMessage, shouldNotify, shouldNotifyFailure } from "./notify.js";
import { createBlobStore, type BlobStore } from "./blobstore.js";
import { maintainStorage, type MaintainResult } from "./retention.js";
import { machinePresence } from "../lib/machinePresence.js";
import { loginGateEnabled } from "../lib/loginGate.js";
import { snapshotRetention } from "../env.js";
import {
  machineIdFromToken,
  isDeviceTokenShape,
  getDeviceOwner,
  readClaimIntent,
  TERMINAL_GRACE_MS,
  resolveLease,
  retireLease,
  pruneExpiredLeases,
  fulfillClaim,
  readClaim,
  readNewIdempotency,
  recordNewIdempotency,
  sha256,
  type ClaimResult,
  type RunLease,
} from "./tokens.js";
import {
  countLine,
  detailBlock,
  doc,
  emptyList,
  helpBlock,
  inlineArray,
  kvLine,
  listBlock,
  scalar,
  truncate,
  type Scalar,
} from "./toon.js";
import { normalizeProviderSetting, validateSchema, validateUi } from "./validate.js";
import { clipText, nowIso, stripNul, WIRE_TEXT_CAP, type HttpResult } from "./http.js";

const log = logger.child({ mod: "gateway" });

export const ONLINE_TTL_MS = 30_000;
/** Circuit breaker: auto-pause a loop after this many CONSECUTIVE failed exec
 *  runs (`skipped` is transparent — the streak counts only phase `error`). A
 *  loop failing every tick burns credits and attention until a human notices
 *  (the anti-spam alert cadence means most failures are silent); past this bar
 *  the honest move is to stop the bleeding and say so once. 0 disables. */
const AUTOPAUSE_STREAK = Math.max(0, Number(process.env.PIEVO_FAILURE_AUTOPAUSE_STREAK ?? 3));

/** How long a ready AUTO pending run on an offline machine stays claimable
 *  before it retires as `skipped`. Same-role fires coalesce in place; this horizon
 *  bounds the durable slot when a machine never returns. */
const DEFERRED_MAX_MS = 7 * 86_400_000;
/** Offline deferred notifications use `runs.deferredAt` as their dedicated marker. */
/** A claimed run that never reports within this window is reclaimed as timed out. */
const configuredRunTimeoutMs = Number(process.env.PIEVO_RUN_TIMEOUT_MS || 20 * 60_000);
const RUN_TIMEOUT_MS = Number.isFinite(configuredRunTimeoutMs) && configuredRunTimeoutMs > 0
  ? configuredRunTimeoutMs
  : 20 * 60_000;
/** `runAt`/`reschedule` horizon - shared by the owner edit path here and the
 *  run-token reschedule path in `cli.ts`. */
export const MAX_NEXT_MS = 30 * 86_400_000;
/** The ONLY keys an owner `editLoop` patch may touch. A key outside this set is
 *  rejected (400) rather than silently ignored, so a `--json` typo fails loudly
 *  and identity/ownership columns (id/teamId/userId/machineId/timestamps) can
 *  never be patched over the device-token edit surface. Exported for `cli.ts`
 *  (the `new`/`edit` verb help lists these keys). */
export const EDITABLE_LOOP_FIELDS = new Set([
  "name",
  "cron",
  "scheduleMode",
  "continuousDelayMinutes",
  "timezone",
  "notify",
  "model",
  "reasoningEffort",
  "allowControl",
  "taskFile",
  "enabled",
  "runAt",
  "ui",
  "stateSchema",
  "goal",
  "agent",
]);
const MIN_INTERVAL_MS = 60_000;
/** Run messages (report --message / finalText fallback).
 *  Run errors share the same cap. Exported for `cli.ts` (the report/finish verbs
 *  clip to the same budget). */
export const MESSAGE_CAP = 2000;
/** A claude-code session id is a UUID-ish token — anything longer is garbage. */
const SESSION_ID_CAP = 200;
/** A loop's goal (setpoint) is a one-line, checkable statement — clip generously
 *  but keep it a single line's worth (not a document). Shared by createLoop/editLoop. */
const GOAL_CAP = 2000;
/** The 2MB machine-body cap is the primary bound; this generous secondary cap
 * covers machines running thousands of independent loops without query abuse. */
const MAX_ACTIVE_RUN_IDS = 5_000;
/** Keep heartbeat throttling safely inside custom short timeout windows. */
export function heartbeatRefreshMs(runTimeoutMs: number): number {
  if (!Number.isFinite(runTimeoutMs) || runTimeoutMs <= 0) return 1;
  return Math.max(1, Math.min(60_000, runTimeoutMs / 3));
}
const HEARTBEAT_STAMP_REFRESH_MS = heartbeatRefreshMs(RUN_TIMEOUT_MS);
/** How often the poll hot path re-stamps `machines.lastSeen`. Only the sweep
 *  (ONLINE_TTL_MS granularity) and presence reads consume the stamp, so an
 *  every-poll UPDATE is pure write amplification on Postgres — refresh at 10s
 *  and an idle poll becomes read-only, with worst-case staleness well inside
 *  the 30s TTL (max stamp gap = refresh + one poll interval). */
const LAST_SEEN_REFRESH_MS = 10_000;

interface MachineReportBody {
  reportId?: string;
  runId?: string;
  result?: "success" | "failure" | "canceled" | "timeout";
  ok?: boolean;
  exitCode?: number | null;
  durationMs?: number;
  outcome?: "direct" | "silent" | "exec" | "evolve";
  sessionId?: string;
  usage?: unknown;
  taskFileContent?: unknown;
  message?: string;
  error?: string;
  finalText?: string;
}
/** How long an opted-in poll (`wait:true`) is held open for work before returning
 *  empty. Bounded under the daemon's 30s fetch timeout AND under ONLINE_TTL_MS
 *  (with the end-of-wait re-stamp) so a parked long-poll never looks offline. */
const LONG_POLL_WAIT_MS = 20_000;
/** Watch-set cache TTL: the per-poll `loopsForMachine` rebuild is served from a
 *  short per-machine cache. Any delivery (the run may belong to a brand-new loop)
 *  and every gateway create/edit invalidates early, so a new or re-pathed loop
 *  folder is watched promptly; slower write paths are covered by the TTL. */
const WATCH_CACHE_TTL_MS = 15_000;
/** The run outcomes a report may claim (untrusted wire input; anything else falls
 *  back to the role default). Mirrors the runs.outcome enum minus "error", which
 *  only the server assigns. */
const RUN_OUTCOMES = new Set(["direct", "silent", "exec", "evolve"]);

/** `pievo log` recent-history window. */
export const LOG_RUNS_DEFAULT = 8;
const LOG_RUNS_MAX = 20;
const USAGE_MAX = 1e12;
const REPORT_ID_CAP = 200;

/** Resolve the user-facing run summary. An agent may already have persisted its
 * message through `pievo report`; provider final text is only the last-resort fallback. */
function receiptFor(body: MachineReportBody, runId: string, ackStatus = 200, ackBody?: Record<string, unknown>) {
  if (typeof body.reportId !== "string") return undefined;
  return {
    reportId: body.reportId,
    runId,
    payloadDigest: sha256(canonicalJson(body)),
    ackStatus,
    ackBody: ackBody ?? { ok: true, reportId: body.reportId },
    createdAt: nowIso(),
  };
}

function receiptResponse(
  receipt: Awaited<ReturnType<typeof store.getReportReceipt>>,
  expected: NonNullable<ReturnType<typeof receiptFor>>,
): HttpResult | undefined {
  if (!receipt || receipt.runId !== expected.runId) return undefined;
  if (receipt.payloadDigest !== expected.payloadDigest) {
    log.warn({ reportId: expected.reportId, runId: expected.runId }, "report: same-run payload changed after commit; replaying authoritative ACK");
  }
  return { status: receipt.ackStatus, body: receipt.ackBody };
}

function incidentReceiptResponse(
  receipt: Awaited<ReturnType<typeof store.getExactTerminalReportIncident>> | undefined,
): HttpResult | undefined {
  return receipt ? { status: 200, body: receipt.ackBody } : undefined;
}

async function committedReportEvidence(
  reportId: string,
  payloadDigest: string,
  authoritativeRunId: unknown,
  allowExactIncidentReplay = false,
): Promise<{ response?: HttpResult; foreignRun: boolean }> {
  const normal = await store.getReportReceipt(reportId);
  const exactIncident = await store.getExactTerminalReportIncident(reportId, payloadDigest);
  if (allowExactIncidentReplay && exactIncident) return { response: incidentReceiptResponse(exactIncident), foreignRun: false };
  if (typeof authoritativeRunId === "string") {
    if (exactIncident?.runId === authoritativeRunId) return { response: incidentReceiptResponse(exactIncident), foreignRun: false };
    if (normal?.runId === authoritativeRunId) {
      if (normal.payloadDigest !== payloadDigest) {
        log.warn({ reportId, runId: authoritativeRunId }, "report: same-run payload changed after commit; replaying authoritative ACK");
      }
      return { response: { status: normal.ackStatus, body: normal.ackBody }, foreignRun: false };
    }
  }
  const incidents = await store.getTerminalReportIncidents(reportId);
  return { foreignRun: !!normal || !!exactIncident || incidents.length > 0 };
}

function correlatableReportId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= REPORT_ID_CAP && !value.includes("\0");
}

function incidentDiagnosis(
  code: ReportIncidentCode,
  issues: string[],
  reportId: string,
  payloadDigest: string,
): ReportIncident {
  const faultDomain: ReportIncidentFaultDomain = code === "REPORT_CONFLICT"
    ? "internal"
    : issues.some((issue) => issue.includes("runId does not match")) ? "daemon" : "compatibility";
  const reason = code === "REPORT_CONFLICT"
    ? "Terminal report rejected because its reportId was already committed for another run."
    : `Terminal report rejected: ${issues.join("; ")}.`;
  const recommendedAction = faultDomain === "internal"
    ? "Inspect pievo show and pievo log; retry only after confirming the daemon and server agree on the active run."
    : "Upgrade Pievo to the latest version and restart the daemon, then inspect pievo show and pievo log.";
  return { at: nowIso(), code, reason, issues, reportId, payloadDigest, faultDomain, recommendedAction };
}

function reportMessage(body: MachineReportBody, run: Run | undefined): string | undefined {
  const raw = typeof body.message === "string"
    ? body.message
    : run?.message
      ? run.message
      : typeof body.finalText === "string"
        ? body.finalText
        : undefined;
  return raw === undefined ? undefined : clipText(raw, MESSAGE_CAP);
}

function validateTerminalReport(body: MachineReportBody): string[] {
  const issues: string[] = [];
  if (body.result !== undefined) {
    if (!["success", "failure", "canceled", "timeout"].includes(body.result as string)) issues.push("result must be success, failure, canceled, or timeout");
  } else if (typeof body.ok !== "boolean") {
    issues.push("result must be success, failure, canceled, or timeout");
  }
  if (body.durationMs !== undefined && (typeof body.durationMs !== "number" || !Number.isInteger(body.durationMs) || body.durationMs < 0 || body.durationMs > 2_147_483_647)) {
    issues.push("durationMs must be a non-negative 32-bit integer");
  }
  if (body.exitCode !== undefined && body.exitCode !== null && (typeof body.exitCode !== "number" || !Number.isInteger(body.exitCode) || body.exitCode < 0 || body.exitCode > 2_147_483_647)) {
    issues.push("exitCode must be a non-negative 32-bit integer or null");
  }
  return issues;
}

function coerceTelemetry(body: MachineReportBody): Partial<Pick<NewRun, "durationMs" | "exitCode" | "sessionId" | "finalText" | "usage">> {
  const whole = (v: unknown, max: number): number | undefined =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max ? v : undefined;
  const usageRaw = body.usage && typeof body.usage === "object" ? body.usage as Record<string, unknown> : {};
  const usage: RunUsage = {};
  for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"] as const) {
    const value = whole(usageRaw[key], USAGE_MAX);
    if (value !== undefined) usage[key] = value;
  }
  return {
    ...(whole(body.durationMs, 2_147_483_647) !== undefined ? { durationMs: body.durationMs } : {}),
    ...(whole(body.exitCode, 2_147_483_647) !== undefined ? { exitCode: body.exitCode } : {}),
    ...(typeof body.sessionId === "string" ? { sessionId: clipText(body.sessionId, SESSION_ID_CAP) } : {}),
    ...(typeof body.finalText === "string" ? { finalText: clipText(body.finalText, WIRE_TEXT_CAP) } : {}),
    ...(Object.keys(usage).length ? { usage } : {}),
  };
}

/** One entry of the poll response's watch set (the daemon resolves the folder). */
interface WatchEntry {
  loopId: string;
  workdir: string | null;
  taskFile: string | null;
}

export class MachineGateway {
  constructor(
    /** Public (not private): `CliGateway.applyMutation` re-arms it after a
     *  run-token schedule mutation. */
    readonly scheduler: Scheduler,
    /** Artifact bytes (local filesystem default, R2 when configured; injectable in tests).
     *  Only `maintainStorage` (retention/GC) reads it here - the byte-ingress
     *  methods live on `ArtifactSync` (`sync.ts`), and boot hands BOTH classes
     *  the same instance. */
    private readonly blobStore: BlobStore = createBlobStore(),
    /** Push dispatcher — injectable (like blobStore) so tests observe notifications
     *  without a network call; defaults to the real per-channel `dispatchNotification`. */
    private readonly notify: (loop: Loop, message: string) => Promise<void> = dispatchNotification,
  ) {}

  /** In-flight latch: the maintenance pass is sequential and the first post-deploy
   *  backlog reclamation can overrun the interval, so a fresh tick skips rather than
   *  running a second pass concurrently (idempotent but wasteful + double-counts). */
  private maintenanceRunning = false;

  /** Fire-and-forget push through the injected notifier, rejection-guarded: the
   *  real dispatchNotification never lets its network call throw, but its leading
   *  store read can reject (transient DB error) - and every caller is a bare
   *  fire-and-forget off a hot path, where an escaped rejection is process-fatal
   *  under Node's default unhandled-rejection policy. */
  private pushNotify(loop: Loop, message: string): void {
    void this.notify(loop, message).catch((err) => log.warn({ loop: loop.id, err: String(err) }, "notify failed"));
  }

  /**
   * Alert the user that an exec run FAILED (error / timeout / machine-offline),
   * through the loop's chosen channel, gated by the anti-spam streak policy
   * (`shouldNotifyFailure` over `store.execFailureStreak`). Evolve/edit runs are
   * internal — they never produce user-facing failure noise. Best-effort + non-
   * throwing: the run's error is already on the dashboard regardless. Call AFTER
   * the run row has been finalized to `error`, so the streak count includes it.
   */
  private async notifyRunFailure(
    loopId: string,
    role: RunRole,
    reason: string | null,
    terminal: { failureStreak: number; autoPaused: boolean },
    options: { alert?: boolean } = {},
  ): Promise<void> {
    if (role !== "exec") return;
    const loop = await store.getLoop(loopId);
    if (!loop) return;
    // The store already made the breaker decision while committing the failure
    // under the loop lock. Notification is deliberately post-commit and has no
    // lifecycle authority of its own.
    if (terminal.autoPaused) {
      this.scheduler.removeLoop(loopId);
      log.warn({ loopId, streak: terminal.failureStreak }, "circuit breaker: auto-paused after consecutive exec failures");
      if (loop.notify !== "never") this.pushNotify(loop, autopauseMessage(terminal.failureStreak));
      return;
    }
    if (options.alert !== false && shouldNotifyFailure(loop.notify, terminal.failureStreak)) {
      this.pushNotify(loop, failureMessage(reason));
    }
  }

  /**
   * Dispatcher for the Scheduler. The pending run row IS the queue (the daemon's
   * next poll claims it, so nothing is ever lost); dispatch additionally WAKES
   * the machine's parked long-poll, so an opted-in idle daemon claims the run
   * immediately instead of on its next cadence tick.
   */
  readonly dispatcher = {
    dispatch: (loop: Loop): void => this.wakeMachine(loop.machineId),
  };

  /** One parked long-poll waiter per machine (the pidfile enforces one daemon).
   *  The stored settle fn resolves `true` on wake (new pending run) and `false`
   *  on timeout / supersede / cancel, then disarms itself. Poll waiters are
   *  process-local; unlike durable run leases, a deploy drops them and the daemon
   *  simply re-polls. */
  private readonly pollWaiters = new Map<string, (woken: boolean) => void>();

  /** Per-machine watch-set cache (TTL + explicit invalidation) — the poll hot
   *  path serves the watch list from here instead of rebuilding it every poll. */
  private readonly watchCache = new Map<string, { at: number; digest: string; watch: WatchEntry[] }>();

  /** Resolve (and disarm) a machine's parked long-poll waiter, if any. */
  private wakeMachine(machineId: string): void {
    this.pollWaiters.get(machineId)?.(true);
  }

  /** Drop a machine's cached watch set (its loop bindings/paths just changed). */
  private invalidateWatch(machineId: string): void {
    this.watchCache.delete(machineId);
  }

  /** Arm this machine's long-poll waiter: the promise resolves `true` when
   *  `wakeMachine` fires (a run went pending), `false` on timeout or cancel.
   *  A pre-existing waiter is superseded (woken) first — a dangling held
   *  request must never strand a newer one. */
  private armPollWaiter(machineId: string, waitMs: number): { promise: Promise<boolean>; cancel: () => void } {
    this.pollWaiters.get(machineId)?.(true);
    let settle!: (woken: boolean) => void;
    const promise = new Promise<boolean>((resolve) => {
      let done = false;
      const timer = setTimeout(() => settle(false), waitMs);
      timer.unref?.();
      settle = (woken: boolean): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (this.pollWaiters.get(machineId) === settle) this.pollWaiters.delete(machineId);
        resolve(woken);
      };
      this.pollWaiters.set(machineId, settle);
    });
    return { promise, cancel: () => settle(false) };
  }

  /**
   * Periodic maintenance: mark stale machines offline, and reclaim stuck runs.
   * A RUNNING run that went silent is reclaimed as timed out; a PENDING run on
   * an OFFLINE machine is NOT failed — it is held as a deferred catch-up (the
   * pending row is the durable inbox; the daemon's next poll claims it, and later
   * same-role fires coalesce into it), bounded by DEFERRED_MAX_MS.
   * Only a pending run a healthy ONLINE machine never claims becomes an error.
   */
  async sweep(): Promise<void> {
    const now = Date.now();
    for (const m of await store.listMachines()) {
      if (m.online && (!m.lastSeen || now - Date.parse(m.lastSeen) > ONLINE_TTL_MS)) {
        await store.updateMachine(m.id, { online: false });
      }
    }
    for (const run of await store.openRuns()) {
      // A future queued run is not stale before it is eligible to claim. For a
      // pending row also start the claimability clock after the latest same-loop
      // blocker terminal; a 21-minute wait behind another role is not instantly
      // stale when that blocker ends.
      const blockerAt = run.phase === "pending" ? await store.lastTerminalRunAt(run.loopId) : null;
      const eligibleAt = Math.max(Date.parse(run.updatedAt), blockerAt ? Date.parse(blockerAt) || 0 : 0);
      const age = now - eligibleAt;
      const pendingLifetime = now - Date.parse(run.createdAt);
      if (run.phase === "pending") {
        const machine = await store.getMachine(run.machineId);
        if (machine?.online) {
          // A queued follow-up may legitimately wait behind this loop's running
          // role for longer than RUN_TIMEOUT_MS. Only a READY, UNBLOCKED row an
          // online daemon still never claims is a delivery anomaly.
          if (!(await store.hasRunningRun(run.loopId)) && age > RUN_TIMEOUT_MS) {
            await this.reclaimRun(run, "run never claimed");
          }
        } else if (run.requestedBy === "system" && pendingLifetime > DEFERRED_MAX_MS) {
          // The machine never came back inside the catch-up horizon — retire
          // the queue slot honestly: skipped, not failed, no alert.
          await store.expirePendingRun(
            run.id,
            { requestedBy: run.requestedBy, updatedAt: run.updatedAt },
            nowIso(),
            DEFERRED_MAX_MS,
            "skipped - the machine stayed offline past the catch-up window",
          );
        } else {
          // DEFERRED, not failed: the pending row IS the durable inbox — the
          // daemon's next poll claims it on reconnect, and later same-role auto
          // triggers coalesce, so this role stays depth-1.
          // Alarm policy mirrors presence: asleep (<6h) is the common calm case
          // and stays fully silent; a genuinely OFFLINE machine gets ONE calm
          // note per deferred exec run (`deferredAt` is the dedicated dedup marker).
          const presence = machinePresence(machine?.online ?? false, machine?.lastSeen ?? null, now);
          if (presence === "offline" && run.role === "exec" && run.requestedBy === "system" && !run.deferredAt) {
            const loop = await store.markPendingRunDeferred(
              run.id,
              { requestedBy: run.requestedBy, updatedAt: run.updatedAt },
              nowIso(),
            );
            if (loop && loop.notify !== "never") this.pushNotify(loop, deferredMessage());
          }
        }
      } else if (run.phase === "running") {
        // INACTIVITY-based timeout. `heartbeatAt` is refreshed only when the daemon
        // explicitly lists this run in `activeRunIds`; claim time is the fallback
        // until the first heartbeat arrives.
        const heardAt = Math.max(Date.parse(run.ts), run.heartbeatAt ? Date.parse(run.heartbeatAt) || 0 : 0);
        if (now - heardAt > RUN_TIMEOUT_MS) {
          await this.reclaimRun(run, "machine timed out / disconnected");
        }
      }
    }
    // Expired reconciliation authority becomes durable retired evidence. Report
    // receipts are intentionally not age-pruned: daemon outboxes have no TTL.
    await pruneExpiredLeases(now);
    for (const loop of await store.listLoops()) {
      if (loop.deleteRequestedAt) await store.tryDeleteLoop(loop.id);
    }
  }

  /** Finalize one stuck run as an error (the sweep's reclaim path): persist the
   *  failure, TERMINALIZE its run lease (flip it to `terminal-grace` rather than
   *  retiring it outright), clear an evolve marker, and surface the failure through
   *  the anti-spam'd notify path.
   *
   *  Why terminalize, not retire: the usual cause is a laptop that merely fell
   *  ASLEEP mid-run. When it wakes, claude finishes and the daemon delivers the real
   *  (often SUCCESSFUL) result. Retiring the lease here would 401 that late report
   *  and strand the run as a permanent false failure with its message lost (the
   *  investigated bug). So the lease survives a bounded grace window
   *  (`TERMINAL_GRACE_MS`) during which exactly ONE late wake-report may reconcile
   *  the run — see `report()`'s terminal-grace branch. The credential is still
   *  bounded: agent-api mutations are refused while terminal-grace, and the
   *  reconciliation retires the lease single-shot. A pending run (no lease minted
   *  yet) is unaffected — the terminalize is a no-op there. */
  private async reclaimRun(run: Run, reason: string): Promise<void> {
    if (run.phase !== "pending" && run.phase !== "running") return;
    const at = nowIso();
    const reclaimed = run.phase === "pending"
      ? await store.reclaimUnclaimedPendingRun(
          run.id,
          { requestedBy: run.requestedBy, updatedAt: run.updatedAt },
          at,
          RUN_TIMEOUT_MS,
          reason,
          AUTOPAUSE_STREAK,
        )
      : await store.reclaimRun(run.id, "running", reason, at, TERMINAL_GRACE_MS);
    // A claim/report/cancel won after sweep read openRuns(). The phase guard is
    // the side-effect gate: never notify or mutate stale work.
    if (!reclaimed) return;
    // A running timeout remains provisional during terminal grace: a late
    // success can correct it. Alert normally, but do not permanently trip the
    // breaker on that provisional third failure. Never-claimed errors are final.
    await this.notifyRunFailure(run.loopId, run.role, reason, reclaimed);
    if (reclaimed.loop.enabled) this.scheduler.addLoop(reclaimed.loop);
    else this.scheduler.removeLoop(reclaimed.loop.id);
  }

  /**
   * Periodic storage maintenance: prune each loop's run snapshots to the
   * retention window, then GC blob bytes no live row needs. Wired to its own
   * interval in boot (independent of the faster offline-sweep) and exposed for
   * tests / on-demand triggers. Safe to run concurrently with active syncs (a
   * grace window + final re-check protect freshly-written/referenced blobs) and
   * idempotent with no garbage. Best-effort — never throws into the caller.
   */
  async maintainStorage(): Promise<MaintainResult> {
    if (this.maintenanceRunning) {
      log.info("storage maintenance already in progress — skipping this tick");
      return { snapshotsPruned: 0, blobsReclaimed: 0 };
    }
    this.maintenanceRunning = true;
    try {
      return await maintainStorage(this.blobStore);
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "storage maintenance failed");
      return { snapshotsPruned: 0, blobsReclaimed: 0 };
    } finally {
      this.maintenanceRunning = false;
    }
  }

  // ---- POST /api/machine/poll ----

  async poll(
    deviceToken: string,
    info?: { host?: string; platform?: string; arch?: string; version?: string },
    activeRunIds?: string[],
    /** The daemon's echo of the last watch digest it applied — matching ⇒ the
     *  watch array is omitted from the response (an old daemon never echoes). */
    watchDigest?: string,
    claimWork = true,
  ): Promise<HttpResult> {
    // Reject malformed tokens (empty / wrong prefix / junk) before any DB work —
    // a cheap filter at the enrollment surface (the auth boundary is the gate below).
    if (!isDeviceTokenShape(deviceToken)) {
      return { status: 401, body: { error: "invalid device token" } };
    }
    const machineId = machineIdFromToken(deviceToken);
    let machine = await store.getMachine(machineId);
    if (machine) {
      // Already enrolled: the derived machine id matched. Verify the FULL token hash
      // too — defense against a 64-bit machine-id truncation collision handing one
      // machine's authority to a different token (audit H-01 criterion (a)).
      if (machine.tokenHash && machine.tokenHash !== sha256(deviceToken)) {
        return { status: 401, body: { error: "device token mismatch" } };
      }
    } else {
      // First contact — self-register, but ONLY an enrollable token:
      //  - open/dev mode (gate off): any well-shaped token enrolls into the shared
      //    workspace (anonymous BYOA is intentional there);
      //  - gated mode (GitHub login on): the token MUST resolve to a live, unexpired
      //    connect key bound to a signed-in user (getDeviceOwner) — i.e. the owner
      //    ran the web/AI-First connect flow. An unknown/forged token is REJECTED,
      //    never minted into a "shared" machine (audit H-01 / M2). This closes the
      //    unauthenticated self-registration + resource-creation hole.
      const owner = await getDeviceOwner(machineId);
      if (loginGateEnabled() && owner == null) {
        return { status: 401, body: { error: "unknown device token — connect this machine first" } };
      }
      const ownerId = owner ?? "shared";
      // Home/default team for this machine: ALWAYS the owner's personal team (the
      // no-claim fallback for loops created on it later). A loop's actual team comes
      // from the validated claim intent at createLoop time, never from this home
      // team — so cross-team capture still lands in team B. Keeping home = personal
      // team preserves the safe invariant that a machine's fallback can never be a
      // shared team the owner is merely a (possibly later-revoked) member of.
      const teamId = store.teamIdForUser(ownerId);
      await store.ensureTeam(teamId, ownerId === "shared" ? "Shared Workspace" : "Personal Team", ownerId === "shared" ? null : ownerId);
      machine = await store.createMachine({
        id: machineId,
        userId: ownerId,
        teamId,
        // Always name it (never blank) — listMachines hides empty-name rows, so a
        // self-registered machine must carry a name to show up + be counted.
        name: info?.host || `machine-${machineId.slice(2, 8)}`,
        tokenHash: sha256(deviceToken),
        token: deviceToken,
        online: true,
      });
      log.info({ machineId, host: info?.host }, "poll: self-registered machine");
    }
    // Stamp online + lastSeen — THROTTLED: only when the flag must flip or the
    // stamp is older than LAST_SEEN_REFRESH_MS. Only the sweep (ONLINE_TTL_MS)
    // and presence reads consume it, so the hot path stays read-only.
    if (!machine.online || !machine.lastSeen || Date.now() - Date.parse(machine.lastSeen) > LAST_SEEN_REFRESH_MS) {
      await store.setMachineOnline(machineId, true);
    }
    // Identity rarely changes after the first poll — only write it when a field
    // actually differs, so the hot path (every ~3s/machine) isn't a 2nd UPDATE.
    if (info) {
      // Untrusted wire input: a version is a short semver, so clip defensively.
      const version = typeof info.version === "string" ? clipText(info.version, 64) : undefined;
      const patch = {
        ...(info.host && info.host !== machine.hostname ? { hostname: info.host } : {}),
        ...(info.platform && info.platform !== machine.platform ? { platform: info.platform } : {}),
        ...(info.arch && info.arch !== machine.arch ? { arch: info.arch } : {}),
        ...(version && version !== machine.daemonVersion ? { daemonVersion: version } : {}),
        ...(info.host && !machine.name?.trim() ? { name: info.host } : {}),
      };
      if (Object.keys(patch).length) await store.updateMachine(machineId, patch);
    }

    // Provider-neutral liveness: dedupe body-bounded ids, then refresh all stale
    // rows in one UPDATE scoped to this machine + running phase.
    if (Array.isArray(activeRunIds)) {
      const ids = new Set<string>();
      for (const value of activeRunIds) {
        if (typeof value === "string") ids.add(value);
        if (ids.size >= MAX_ACTIVE_RUN_IDS) break;
      }
      if (ids.size) {
        const now = Date.now();
        await store.refreshRunHeartbeats(
          machineId,
          [...ids],
          new Date(now).toISOString(),
          new Date(now - HEARTBEAT_STAMP_REFRESH_MS).toISOString(),
        );
      }
    }

    const deliveries: Delivery[] = [];
    if (claimWork) {
      // Timers are latency hints; the singular claim is machine-serialized.
      await this.scheduler.advanceDueSchedules(machineId);
      const claimed = await store.claimReadyRunForMachine(machineId);
      if (claimed) deliveries.push(await buildDelivery(claimed.loop, claimed.run, claimed.runToken, machine.roots ?? []));
    }

    // Watch set: every loop bound to this machine (not just those with a pending
    // run) so the daemon watches each loop's folder continuously — between runs
    // and across restarts (the set stays server-authoritative). Served from a
    // short-TTL cache; any delivery recomputes (the run may belong to a brand-new
    // loop whose folder must be watched before it writes). The daemon resolves
    // the actual folder per loop (dirname(taskFile) → workdir).
    let cached = this.watchCache.get(machineId);
    if (!cached || deliveries.length || Date.now() - cached.at > WATCH_CACHE_TTL_MS) {
      const watch: WatchEntry[] = (await store.loopsForMachine(machineId))
        .map((l) => ({
          loopId: l.id,
          workdir: l.workdir ?? null,
          taskFile: l.taskFile ?? null,
        }))
        .sort((a, b) => (a.loopId < b.loopId ? -1 : a.loopId > b.loopId ? 1 : 0));
      cached = { at: Date.now(), digest: sha256(JSON.stringify(watch)), watch };
      this.watchCache.set(machineId, cached);
    }

    if (deliveries.length) log.info({ machineId, exec: deliveries.length }, "poll: delivered");
    // A matching digest echo means the daemon already holds this exact watch set —
    // omit the array. An old daemon never echoes, so it always gets the full list
    // (omission requires proof the client speaks the digest protocol, never a default).
    return {
      status: 200,
      body: {
        deliveries,
        watchDigest: cached.digest,
        ...(watchDigest === cached.digest ? {} : { watch: cached.watch }),
      },
    };
  }

  /** Breaking protocol-v2 single-flight poll seam. */
  async pollV2(deviceToken: string, request: {
    protocolVersion?: number;
    currentRun?: { runId: string; stage: "executing" | "reporting" };
    watchDigest?: string;
    info?: { host?: string; platform?: string; arch?: string; version?: string };
  }): Promise<HttpResult> {
    if (request.protocolVersion !== 2) {
      // Do not leave stale v2 capability behind when a machine rolls back to an
      // incompatible daemon. Update only an already-authenticated machine; this
      // mismatch path is not an enrollment surface.
      if (isDeviceTokenShape(deviceToken)) {
        const machineId = machineIdFromToken(deviceToken);
        const machine = await store.getMachine(machineId);
        if (machine?.tokenHash === sha256(deviceToken)) {
          const reported = typeof request.protocolVersion === "number" && Number.isInteger(request.protocolVersion)
            ? request.protocolVersion
            : null;
          await store.updateMachine(machineId, { daemonProtocol: reported });
        }
      }
      return { status: 426, body: { error: "daemon upgrade required; run `npm install -g @kky42/pievo@latest`, then `pievo daemon restart`", code: "UPGRADE_REQUIRED", requiredProtocol: 2 } };
    }
    const current = request.currentRun;
    if (current && (typeof current.runId !== "string" || !["executing", "reporting"].includes(current.stage))) {
      return { status: 400, body: { error: "invalid currentRun", code: "VALIDATION_ERROR" } };
    }
    const base = await this.poll(deviceToken, request.info, current ? [current.runId] : undefined, request.watchDigest, !current);
    if (base.status !== 200) return base;
    const machineId = machineIdFromToken(deviceToken);
    const machine = await store.getMachine(machineId);
    if (machine?.daemonProtocol !== 2) await store.updateMachine(machineId, { daemonProtocol: 2 });
    const running = await store.runningRunForMachine(machineId);
    const body = base.body as { deliveries: Delivery[]; watchDigest: string; watch?: WatchEntry[] };
    const cancelRunId = current && running?.id === current.runId && running.cancelRequestedAt ? current.runId : undefined;
    return {
      status: 200,
      body: {
        delivery: current ? null : body.deliveries[0] ?? null,
        ...(cancelRunId ? { cancelRunId } : {}),
        ...(current && running && current.runId !== running.id
          ? { runConflict: { daemonRunId: current.runId, serverRunId: running.id } }
          : {}),
        ...(!current && running && !body.deliveries.length ? { blockedRunId: running.id } : {}),
        watchDigest: body.watchDigest,
        ...(body.watch ? { watch: body.watch } : {}),
      },
    };
  }

  /** Protocol-v2 idle polls long-poll automatically; active/reporting polls never park. */
  async pollV2Wait(deviceToken: string, request: Parameters<MachineGateway["pollV2"]>[1], waitMs = LONG_POLL_WAIT_MS): Promise<HttpResult> {
    if (request.currentRun || request.protocolVersion !== 2) return this.pollV2(deviceToken, request);
    const machineId = machineIdFromToken(deviceToken);
    const waiter = this.armPollWaiter(machineId, Math.min(Math.max(waitMs, 0), LONG_POLL_WAIT_MS));
    try {
      const first = await this.pollV2(deviceToken, request);
      if (first.status !== 200) return first;
      const body = first.body as { delivery?: Delivery | null; blockedRunId?: string };
      if (body.delivery || body.blockedRunId) return first;
      const woken = await waiter.promise;
      if (!woken) {
        await store.setMachineOnline(machineId, true);
        return first;
      }
      return this.pollV2(deviceToken, request);
    } finally {
      waiter.cancel();
    }
  }

  /**
   * Legacy long-poll wrapper over `poll()`: when the daemon opted in (`wait:true`) and
   * the immediate pass claimed nothing, park the request on the machine's waiter
   * until the Dispatcher wakes it (a run went pending) or the bounded window
   * elapses, then re-claim. Old daemons never send `wait` and keep the classic
   * instant response. The waiter is armed BEFORE the first claim pass, so a run
   * that goes pending while the pass is in flight can never slip past the park.
   */
  async pollWait(
    deviceToken: string,
    info?: { host?: string; platform?: string; arch?: string; version?: string },
    activeRunIds?: string[],
    opts?: { wait?: boolean; watchDigest?: string; waitMs?: number },
  ): Promise<HttpResult> {
    if (!opts?.wait) return this.poll(deviceToken, info, activeRunIds, opts?.watchDigest);
    const machineId = machineIdFromToken(deviceToken);
    const waitMs = Math.min(Math.max(opts.waitMs ?? LONG_POLL_WAIT_MS, 0), LONG_POLL_WAIT_MS);
    const waiter = this.armPollWaiter(machineId, waitMs);
    try {
      const first = await this.poll(deviceToken, info, activeRunIds, opts.watchDigest);
      if (first.status !== 200) return first;
      if ((first.body as { deliveries: Delivery[] }).deliveries.length) return first;
      const woken = await waiter.promise;
      if (!woken) {
        // Timed out empty: re-stamp before returning so the ~20s hold never eats
        // into the 30s ONLINE_TTL budget (the first pass's stamp is now that old).
        await store.setMachineOnline(machineId, true);
        return first;
      }
      // Woken: re-run the claim pass (identity/heartbeats were already applied).
      return await this.poll(deviceToken, undefined, undefined, opts.watchDigest);
    } finally {
      waiter.cancel();
    }
  }

  // ---- GET /api/machine/status ----

  /**
   * Whether this machine (by device token) currently has a live daemon — so
   * Claude Code can avoid starting a duplicate. `online` is fresh-checked against
   * the poll TTL, not just the stored flag.
   */
  async status(deviceToken: string): Promise<HttpResult> {
    const machineId = machineIdFromToken(deviceToken);
    const machine = await store.getMachine(machineId);
    // Unknown token ⇒ not connected yet (the daemon self-registers on first poll),
    // so report offline rather than erroring — keeps the skill's check uniform.
    if (!machine) return { status: 200, body: { online: false, name: null, lastSeen: null, daemonProtocol: null } };
    const fresh = !!machine.lastSeen && Date.now() - Date.parse(machine.lastSeen) < ONLINE_TTL_MS;
    const online = !!machine.online && fresh;
    const running = await store.runningRunForMachine(machineId);
    return {
      status: 200,
      body: {
        online,
        name: machine.name || null,
        lastSeen: machine.lastSeen ?? null,
        daemonProtocol: machine.daemonProtocol ?? null,
        ...(running ? {
          ...(online ? { currentRun: { runId: running.id, stage: "executing", cancelPending: running.cancelRequestedAt != null } } : { blockedRunId: running.id }),
          ...(running.cancelRequestedAt ? { cancelPending: true } : {}),
        } : {}),
      },
    };
  }

  // ---- POST /api/machine/loop ----

  /**
   * Create a loop from Claude Code (Bearer device token). The user perfected the
   * task in their own Claude Code session, then — per SKILL.md — claude authors
   * the loop config and POSTs it here. Binds the loop to the token's machine and
   * schedules it immediately. The web's New-loop dialog is just waiting on this.
   */
  async createLoop(
    deviceToken: string,
    body: {
      name?: unknown;
      cron?: unknown;
      scheduleMode?: unknown;
      continuousDelayMinutes?: unknown;
      timezone?: unknown;
      /** Optional provider model id used by the selected coding agent. */
      model?: unknown;
      /** Optional provider reasoning effort; arbitrary text, passed through verbatim. */
      reasoningEffort?: unknown;
      workdir?: unknown;
      taskFile?: unknown;
      stateSchema?: unknown;
      /** Optional initial dashboard UI (small HTML, same surface as `set-ui`). Lets a
       *  template-driven loop ship a day-one dashboard instead of waiting for an
       *  evolve pass. Validated by the same `validateUi` editLoop uses. */
      ui?: unknown;
      notify?: unknown;
      /** Optional closed-loop setpoint. Non-null ⇒ the loop is CLOSED (self-finishes
       *  when met); null/absent ⇒ OPEN (monitor/digest). */
      goal?: unknown;
      /** Coding agent this loop is bound to and EXECUTED with (claude-code | codex).
       *  Absent for older daemons defaults to claude-code. The daemon spawns that
       *  agent on the bound machine. */
      agent?: unknown;
      /** Web's New-loop claim token — correlates this loop back to the dialog. */
      claim?: unknown;
      /** Validate-only (`pievo new --dry-run`): run every check, persist NOTHING,
       *  and return the normalized config + fire preview. Zero-exec preserved. */
      dryRun?: unknown;
      /** Content-hash idempotency key the daemon derives (sha256 over machine id +
       *  canonical config, §8.1). A retry with a still-live key returns the loop it
       *  first created instead of a twin (F8). Absent ⇒ no dedupe (old daemon). */
      idempotencyKey?: unknown;
    },
  ): Promise<HttpResult> {
    const machineId = machineIdFromToken(deviceToken);
    const machine = await store.getMachine(machineId);
    if (!machine) return { status: 401, body: { error: "unknown machine (token not registered)" } };

    const scheduleMode: "cron" | "continuous" = body.scheduleMode === "continuous" ? "continuous" : "cron";
    if (body.scheduleMode !== undefined && body.scheduleMode !== "cron" && body.scheduleMode !== "continuous") {
      return { status: 400, body: { error: "scheduleMode must be cron|continuous" } };
    }
    const continuousDelayMinutes = body.continuousDelayMinutes === undefined ? 1 : Number(body.continuousDelayMinutes);
    if (!Number.isInteger(continuousDelayMinutes) || continuousDelayMinutes < 1) {
      return { status: 400, body: { error: "continuousDelayMinutes must be an integer >= 1" } };
    }
    const cron = str(body.cron);
    if (!cron) return { status: 400, body: { error: "cron required (retained while continuous mode ignores it)" } };
    // Timezone first: the cadence is validated IN the loop's timezone (a cron's
    // fire times shift with it), so the tz must be known-good before the probe.
    const timezone = str(body.timezone);
    if (timezone && !validTimezone(timezone)) {
      return { status: 400, body: { error: invalidTimezoneError(timezone) } };
    }
    const cadence = validCadence(cron, timezone);
    if (!cadence.ok) return { status: 400, body: { error: `invalid cron: ${cadence.detail}` } };

    // Untrusted wire input — clip the free-text fields defensively (same
    // discipline as taskFileContent on report). A loop's standing brief lives in
    // its task file's Spec, and the run message is the server-composed exec CORE
    // (see buildExecTask).
    const taskFile = str(body.taskFile);
    if (!taskFile) return { status: 400, body: { error: "taskFile required (path to the loop's Spec)" } };
    // Optional setpoint (clipped one-liner); absent/blank ⇒ open loop.
    const goal = str(body.goal)?.slice(0, GOAL_CAP) ?? null;

    const notify = body.notify === "always" || body.notify === "never" ? body.notify : "auto";
    const model = normalizeProviderSetting(body.model);
    const reasoningEffort = normalizeProviderSetting(body.reasoningEffort);
    // Recorded coding agent: trust the daemon's resolved value when it's known.
    // Older daemons may omit it and generic unknown values retain the historical
    // claude-code fallback. The explicitly retired Grok executor fails loud so an
    // old daemon cannot silently create a loop that runs on a different CLI.
    if (body.agent === "grok") {
      return { status: 400, body: { error: "grok agent support was removed; upgrade pievo and choose claude-code or codex" } };
    }
    const agent: CodingAgent = coerceCodingAgent(body.agent) ?? "claude-code";

    const stateSchema = store.coerceStateSchema(body.stateSchema) ?? null;
    // Optional day-one dashboard — same validate/clip surface as `set-ui` (editLoop).
    // Sanitized to the allowed tags/attrs; an unusable value coerces to null.
    const ui = validateUi(str(body.ui)?.slice(0, WIRE_TEXT_CAP) ?? "").value;
    // A dashboard the caller PROVIDED but that validated to nothing must never vanish
    // silently — surface it (dry-run + real create) so a dropped dashboard is LOUD.
    // The create still succeeds; the loop just has no dashboard until it's fixed.
    const uiDropped = body.ui != null && body.ui !== "" && ui == null;
    const uiWarning = uiDropped
      ? "the provided ui was empty after validation and was NOT applied — the loop was created without a dashboard"
      : undefined;

    // Validate-only (`pievo new --dry-run`): every check above has passed, so
    // return the normalized config + fire preview + open/closed classification and
    // persist NOTHING (no store write, no scheduler, no team-auth side effects).
    if (body.dryRun === true) {
      const config = {
        name: str(body.name),
        cron,
        scheduleMode,
        continuousDelayMinutes,
        timezone: timezone ?? null,
        taskFile: taskFile ?? null,
        workdir: str(body.workdir) ?? null,
        model: model ?? null,
        reasoningEffort: reasoningEffort ?? null,
        // The dashboard HTML can be large — report presence, not the markup.
        ui: ui != null,
        goal,
        notify,
        agent,
        stateSchema,
      };
      const nextRuns = scheduleMode === "cron" ? nextFires(cron, timezone, 3) : [];
      return {
        status: 200,
        body: {
          ok: true,
          dryRun: true,
          config,
          timezone: timezone ?? null,
          nextRuns,
          classification: goal != null ? "closed" : "open",
          classificationText:
            goal != null
              ? "closed (has goal): will self-finish when the goal is met"
              : "open: runs until paused",
          ...(uiWarning ? { warning: uiWarning } : {}),
          text: renderCreateDryRunText(config, nextRuns, uiWarning),
        },
      };
    }

    // Idempotency (F8): a timed-out `pievo new` retry must never make a twin. The
    // daemon sends a stable content key; if we already created a loop for this key on
    // THIS machine within the window, return that loop (an idempotent REPLAY, §4.5)
    // rather than a second one. Checked AFTER validation (so only a real, valid
    // create is deduped) and AFTER the dry-run branch (a preview never dedupes).
    const idempotencyKey = str(body.idempotencyKey);
    if (idempotencyKey) {
      const existingId = readNewIdempotency(idempotencyKey, machineId);
      const existing = existingId ? await store.getLoop(existingId) : undefined;
      // Recheck existence + ownership: a since-deleted loop (or a stale record) falls
      // through to a fresh create rather than replaying a loop that is gone.
      if (existing && existing.machineId === machineId) {
        return {
          status: 200,
          body: {
            ok: true,
            id: existing.id,
            name: existing.name ?? existing.id,
            idempotent: true,
            ui: existing.ui != null,
            text: renderReplayText(existing.name ?? existing.id, existing.id, existing.goal),
          },
        };
      }
    }

    // Resolve the loop's TEAM. The connect-key/claim was minted under a specific
    // team's dashboard session; that bound team — not the machine's single home
    // team — decides where the loop lands. This is what lets ONE machine/daemon
    // serve MANY teams (report §2.1). With no claim intent (older daemon, CLI
    // direct path) we fall back to the machine's home team, exactly as before.
    const homeTeam = machine.teamId ?? store.teamIdForUser(machine.userId);
    let teamId = homeTeam;
    const intent = await readClaimIntent(str(body.claim));
    if (intent && intent.teamId !== homeTeam) {
      // CROSS-TEAM create. SECURITY (report §4) — fail CLOSED, never silently
      // mis-file into the home team (the original bug):
      //  - bind the claim to its minter: the same human who minted it under a
      //    validated team session must be the one creating the loop;
      //  - RE-VALIDATE authorization NOW (membership can change after mint),
      //    mirroring requestScope: a current team member. The team value itself
      //    is server-minted, never client input.
      if (machine.userId !== intent.userId) {
        return { status: 403, body: { error: "connect-key was minted by a different user" } };
      }
      const authorized = await store.isTeamMember(intent.teamId, machine.userId);
      if (!authorized) {
        return { status: 403, body: { error: "not authorized to create loops in that team" } };
      }
      teamId = intent.teamId;
    }
    // Default to the team's most recently configured channel (listChannels is
    // newest-first) so a freshly-added Feishu/Telegram channel auto-applies to new
    // loops — computed against the RESOLVED team so it routes to that team's channel.
    const channelId = await store.defaultChannelId(teamId);
    const loop = await store.createLoop({
      userId: machine.userId ?? "shared",
      teamId,
      channelId,
      machineId,
      name: str(body.name),
      cron,
      scheduleMode,
      continuousDelayMinutes,
      timezone,
      model,
      reasoningEffort,
      workdir: str(body.workdir),
      taskFile,
      stateSchema,
      ui,
      notify,
      goal,
      agent,
      enabled: true,
    });
    this.invalidateWatch(machineId); // a new loop folder must be watched promptly
    // Preserve the immediate first run. The recurring cadence remains a separate
    // durable fact; addLoop merely arms its latency timer.
    if (loop.enabled) await this.scheduler.enqueueInitialExec(loop.id);
    this.scheduler.addLoop(loop);
    const name = loop.name ?? loop.id;
    if (typeof body.claim === "string" && body.claim.trim()) {
      fulfillClaim(body.claim.trim(), { loopId: loop.id, name, machineId, agent });
    }
    // Remember this create against its content key so an immediate retry replays it.
    if (idempotencyKey) recordNewIdempotency(idempotencyKey, machineId, loop.id);
    if (uiDropped) log.warn({ machineId, loopId: loop.id }, "createLoop: provided ui dropped — loop created without a dashboard");
    log.info({ machineId, loopId: loop.id, agent, ui: ui != null }, "createLoop: created from a coding agent");
    // Echo `ui` presence (like dry-run) + a warning when a provided dashboard was
    // dropped, so the CLI/response can surface it — never a silent no-dashboard.
    return {
      status: 200,
      body: {
        ok: true,
        id: loop.id,
        name,
        ui: ui != null,
        ...(uiWarning ? { warning: uiWarning } : {}),
        text: renderCreatedText(name, loop.id, cron, scheduleMode, continuousDelayMinutes, timezone ?? null, goal, ui != null, uiWarning),
      },
    };
  }

  // ---- GET/PATCH /api/machine/loop — the owner's interactive agent edits ----

  /** List the loops bound to this machine, for `pievo loops`. The default columns
   *  are the minimal `{id,name,cron,enabled,nextFire}` (P2); `--fields` extends them
   *  from the optional set, and an unknown field fails loud (P6, VALIDATION_ERROR).
   *  `--json` (OQ4) is the escape hatch: the full structured records as real JSON
   *  (first byte `[`), mirroring `show --json` — the daemon prints `text` either way. */
  async listLoops(deviceToken: string, fieldsFlag?: string, json?: boolean): Promise<HttpResult> {
    const machineId = machineIdFromToken(deviceToken);
    if (!(await store.getMachine(machineId))) return { status: 401, body: { error: "unknown machine (token not registered)" } };

    // --fields extends the default columns with any of the optional set; an unknown
    // field fails loud (exit 1) listing what IS available (matches gh-axi's shape).
    const extras: string[] = [];
    if (fieldsFlag !== undefined) {
      const requested = String(fieldsFlag).split(",").map((s) => s.trim()).filter(Boolean);
      const unknown = requested.filter((f) => !LIST_OPTIONAL_FIELDS.includes(f));
      if (unknown.length) {
        return { status: 400, body: { error: `unknown field(s): ${unknown.join(", ")} — available: ${LIST_OPTIONAL_FIELDS.join(", ")}` } };
      }
      // Preserve request order and dedup.
      for (const f of requested) if (!extras.includes(f)) extras.push(f);
    }
    const fields = [...LIST_DEFAULT_FIELDS, ...extras];
    // The derived cells cost an extra query per loop; the TOON path pays for them only
    // when the column is actually selected (the default `pievo loops` computes
    // neither). The `--json` escape hatch mirrors `show --json`, which ALWAYS computes
    // both, so force them on for JSON — a plain `pievo loops --json` must report the
    // real `runs`/`lastOutcome` per loop, never a lazy 0/null.
    const wantRuns = json || fields.includes("runs");
    const wantLastOutcome = json || fields.includes("lastOutcome");

    const loops: LoopListRecord[] = await Promise.all(
      (await store.loopsForMachine(machineId)).map(async (l) => {
        // Derived cadence fire (P4): the NEXT time the cron fires in the loop's tz. A
        // paused loop shows no next fire (— in the cell), matching §4.2.
        const nextFire = l.enabled && l.scheduleMode === "cron" ? (nextFires(l.cron, l.timezone, 1)[0] ?? null) : null;
        // The last-outcome cell tracks the newest EXEC (scheduled) run, aligning with
        // `show` — a later successful evolve/edit must never mask a failed scheduled run.
        const last = wantLastOutcome ? await store.lastExecRun(l.id) : undefined;
        return {
          id: l.id,
          name: l.name ?? l.id,
          cron: l.cron,
          scheduleMode: l.scheduleMode,
          continuousDelayMinutes: l.continuousDelayMinutes,
          timezone: l.timezone,
          enabled: l.enabled,
          notify: l.notify,
          model: l.model ?? null,
          reasoningEffort: l.reasoningEffort ?? null,
          goal: l.goal ?? null,
          taskFile: l.taskFile ?? null,
          nextRunAt: l.nextRunAt,
          // Folder hint so a workdir-scoped CLI (`pievo log`) can map the current
          // directory back to a loop the same way the watcher resolves it.
          workdir: l.workdir ?? null,
          nextFire,
          runs: wantRuns ? await store.countRuns(l.id) : 0,
          lastOutcome: last ? runOutcomeToken(last) : null,
        };
      }),
    );
    // `--json` escape hatch: emit the full records as real JSON in `text` (the daemon
    // prints it verbatim), the exact counterpart to `show --json`. TOON is the default.
    const text = json ? JSON.stringify(loops, null, 2) : renderLoopsText(loops, fields);
    // `loops` is a RETAINED data channel (`CLI_RETAINED_KEYS`): the daemon resolves
    // cwd→loop CLIENT-side (`log`/`show`/`home`) from these rows. `ok` is render-only and
    // stripped at the cli boundary; the legacy `/api/machine/loop` GET route keeps it.
    return { status: 200, body: { ok: true, loops, text } };
  }

  /** Recent provider-neutral run history for `pievo log`, machine scoped. */
  async loopLog(deviceToken: string, loopId: unknown, limit?: unknown): Promise<HttpResult> {
    const machineId = machineIdFromToken(deviceToken);
    if (!(await store.getMachine(machineId))) return { status: 401, body: { error: "unknown machine (token not registered)" } };
    return this.renderLoopLog(machineId, loopId, limit);
  }

  /** The machine-scoped run survey, shared by the device-token `loopLog` (resolves
   *  the machine from the token) AND the unified-dispatch run-credential `log` branch
   *  in `CliGateway` (passes the run lease's own machineId + loopId — this is what
   *  closes the in-run `pievo log` 400 seam); public for that second consumer.
   *  Scoping is identical for both callers: only a loop
   *  bound to `machineId` is visible; anything else is a flat 404 (existence never
   *  leaks), exactly as before for the device path. */
  async renderLoopLog(machineId: string, loopId: unknown, limit?: unknown): Promise<HttpResult> {
    if (typeof loopId !== "string" || !loopId) return { status: 400, body: { error: "loopId required" } };
    const loop = await store.getLoop(loopId);
    // Loop+device scoping: only a loop bound to this machine is visible. A token
    // for device A, or for a different loop, gets a flat 404 (existence never leaks).
    if (!loop || loop.machineId !== machineId) return { status: 404, body: { error: "no such loop on this machine" } };

    const want = Number(limit);
    const n = Math.min(Math.max(Number.isFinite(want) && want > 0 ? Math.floor(want) : LOG_RUNS_DEFAULT, 1), LOG_RUNS_MAX);
    // listRuns returns the newest n runs oldest-first; reverse to newest-first so
    // the agent reads the most recent history at the top.
    const rows = (await store.listRuns(loopId, n)).slice().reverse();
    const runs = rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      role: r.role,
      phase: r.phase,
      outcome: r.outcome ?? null,
      status: r.status ?? null,
      durationMs: r.durationMs ?? null,
      exitCode: r.exitCode ?? null,
      finalText: r.finalText ?? null,
      usage: r.usage
        ? {
            inputTokens: r.usage.inputTokens,
            outputTokens: r.usage.outputTokens,
            cacheReadTokens: r.usage.cacheReadTokens,
            cacheCreationTokens: r.usage.cacheCreationTokens,
          }
        : null,
      error: r.error ?? null,
      message: r.message ?? null,
      sessionId: r.sessionId ?? null,
      state: r.state ?? null,
    }));
    const survey = renderLogText(loop.name ?? loop.id, loop.id, runs, await store.countRuns(loopId));
    return { status: 200, body: { ok: true, loopId: loop.id, name: loop.name ?? loop.id, runs, text: survey } };
  }

  /**
   * Edit a loop's scheduling envelope from the owner's interactive agent
   * (`pievo edit`). Authed by the machine's device token and scoped to loops
   * bound to THAT machine — deliberately NOT gated by allowControl (that flag
   * governs a running run rescheduling ITSELF; the human owner may always edit).
   * Task CONTENT lives in the loop's README.md on the machine, so it's edited there, not here.
   */
  async editLoop(
    deviceToken: string,
    id: unknown,
    patch: {
      name?: unknown;
      cron?: unknown;
      scheduleMode?: unknown;
      continuousDelayMinutes?: unknown;
      timezone?: unknown;
      notify?: unknown;
      model?: unknown;
      reasoningEffort?: unknown;
      allowControl?: unknown;
      taskFile?: unknown;
      enabled?: unknown;
      runAt?: unknown;
      ui?: unknown;
      stateSchema?: unknown;
      goal?: unknown;
      agent?: unknown;
    },
    /** Validate-only (`pievo edit --dry-run`): compute the per-key before→after
     *  preview + rejections, persist NOTHING. */
    dryRun = false,
  ): Promise<HttpResult> {
    const machineId = machineIdFromToken(deviceToken);
    if (!(await store.getMachine(machineId))) return { status: 401, body: { error: "unknown machine (token not registered)" } };
    if (typeof id !== "string" || !id) return { status: 400, body: { error: "loop id required" } };
    const loop = await store.getLoop(id);
    if (!loop || loop.machineId !== machineId) return { status: 404, body: { error: "no such loop on this machine" } };

    const p = (patch ?? {}) as Record<string, unknown>;
    // Whitelist: a typo in `--json` must fail loudly, never silently no-op, and
    // no non-listed field (id/teamId/userId/machineId/timestamps/…) may be touched.
    const unknownKeys = Object.keys(p).filter((k) => !EDITABLE_LOOP_FIELDS.has(k));
    // The real path rejects any unknown key up front (unchanged behavior). Dry-run
    // reports them as per-key rejections instead, alongside the valid preview.
    if (!dryRun && unknownKeys.length) {
      return {
        status: 400,
        body: { error: `unknown field(s): ${unknownKeys.join(", ")} — allowed: ${[...EDITABLE_LOOP_FIELDS].join(", ")}` },
      };
    }

    const { update, changes, rejections } = await this.buildEditUpdate(loop, p);

    if (dryRun) {
      const allRejections = [
        ...unknownKeys.map((k) => ({ key: k, reason: `unknown field — allowed: ${[...EDITABLE_LOOP_FIELDS].join(", ")}` })),
        ...rejections,
      ];
      // Reflect store.updateLoop's derived lifecycle side effects in the preview so
      // the owner sees the FULL consequence: clearing the goal (goal:null) or
      // reopening a completed loop (enabled:true) also drops the terminal stamps.
      const clearsStamps =
        (update.goal === null || (update.enabled === true && update.completedAt === undefined)) && loop.completedAt != null;
      if (clearsStamps) {
        changes.push({ key: "completedAt", from: loop.completedAt, to: null });
        changes.push({ key: "completionReason", from: loop.completionReason, to: null });
      }
      return {
        status: 200,
        body: {
          ok: allRejections.length === 0,
          dryRun: true,
          id: loop.id,
          name: loop.name ?? loop.id,
          changes,
          rejections: allRejections,
          // The preview request itself succeeds (HTTP 200 + the rich changes/rejections
          // tables), but a rejected key means the proposed patch is invalid — signal
          // that to the CLI as exit 1 (§4.4), not the misleading exit 0 of a clean run.
          exitCode: allRejections.length ? 1 : 0,
          text: renderEditDryRunText(loop.id, loop.name ?? loop.id, changes, allRejections),
        },
      };
    }

    // Real path: a validation rejection fails loudly (first one, preserving the
    // per-field message + order the checks run in).
    if (rejections.length) return { status: 400, body: { error: rejections[0]!.reason } };
    // An empty patch (`edit --json '{}'`) is a VALID no-op (feedback #3), not an
    // error: report `nothing to change` with the allowed-key list rather than a bare
    // usage 400. (`show` existing is the real cure; this makes the seam legible.)
    if (Object.keys(update).length === 0) {
      return {
        status: 200,
        body: {
          ok: true,
          id: loop.id,
          name: loop.name ?? loop.id,
          applied: [],
          nothingToChange: true,
          text: renderEditNoopText(loop.id, loop.name ?? loop.id),
        },
      };
    }

    const updated = await store.updateLoop(id, update);
    if (!updated) return { status: 404, body: { error: "loop not found" } };
    // updateLoop committed every lifecycle/cadence fact synchronously. The
    // scheduler only mirrors that row into an in-memory latency hint.
    if (updated.enabled) this.scheduler.addLoop(updated);
    else this.scheduler.removeLoop(updated.id);
    this.invalidateWatch(machineId); // taskFile may have moved the watched folder
    log.info({ machineId, loopId: id, fields: Object.keys(update) }, "editLoop: applied");
    const applied = Object.keys(update);
    return {
      status: 200,
      body: {
        ok: true,
        id: updated.id,
        name: updated.name ?? updated.id,
        applied,
        text: renderEditAppliedText(updated.id, updated.name ?? updated.id, applied),
      },
    };
  }

  /**
   * Validate + normalize an editLoop patch against the current loop, WITHOUT
   * persisting. Returns the `update` to feed `store.updateLoop`, a per-key
   * `changes` (before→after) preview, and any `rejections` (invalid values).
   * Assumes unknown keys were already filtered by the caller. Field order mirrors
   * the old inline checks so the real path's first-rejection message is stable.
   */
  private async buildEditUpdate(
    loop: Loop,
    p: Record<string, unknown>,
  ): Promise<{ update: Partial<NewLoop>; changes: Array<{ key: string; from: unknown; to: unknown }>; rejections: Array<{ key: string; reason: string }> }> {
    const update: Partial<NewLoop> = {};
    const changes: Array<{ key: string; from: unknown; to: unknown }> = [];
    const rejections: Array<{ key: string; reason: string }> = [];
    // A `set` whose new value equals the current one is a NO-OP for the CHANGES
    // preview: the write still flows to `update` (an all-no-op patch is a harmless
    // idempotent re-apply, not a "nothing to change" 400), but it is not RECORDED as a
    // change. This is what makes read/write identity real — feeding a `show --json`
    // envelope back to `edit --dry-run` reports zero changes (the roundtrip pin).
    // Values compare structurally (stateSchema is an array); null and undefined are
    // equal (an absent field re-fed as null is unchanged).
    const set = (key: string, to: unknown, from: unknown): void => {
      (update as Record<string, unknown>)[key] = to;
      if (!sameLoopValue(to, from)) changes.push({ key, from: clipPreview(from), to: clipPreview(to) });
    };

    // Timezone before cron: the cadence probe runs in the loop's EFFECTIVE
    // timezone (the patched one when the patch carries it, else the stored one).
    if (p.timezone !== undefined) {
      const tz = str(p.timezone);
      if (tz && !validTimezone(tz)) rejections.push({ key: "timezone", reason: invalidTimezoneError(tz) });
      else set("timezone", tz, loop.timezone);
    }
    if (p.cron !== undefined) {
      const cron = str(p.cron);
      if (!cron) rejections.push({ key: "cron", reason: "cron cannot be empty" });
      else {
        const c = validCadence(cron, p.timezone !== undefined ? update.timezone : loop.timezone);
        if (!c.ok) rejections.push({ key: "cron", reason: `invalid cron: ${c.detail}` });
        else set("cron", cron, loop.cron);
      }
    }
    if (p.scheduleMode !== undefined) {
      if (p.scheduleMode !== "cron" && p.scheduleMode !== "continuous") {
        rejections.push({ key: "scheduleMode", reason: "scheduleMode must be cron|continuous" });
      } else set("scheduleMode", p.scheduleMode, loop.scheduleMode);
    }
    if (p.continuousDelayMinutes !== undefined) {
      const delay = Number(p.continuousDelayMinutes);
      if (!Number.isInteger(delay) || delay < 1) {
        rejections.push({ key: "continuousDelayMinutes", reason: "continuousDelayMinutes must be an integer >= 1" });
      } else set("continuousDelayMinutes", delay, loop.continuousDelayMinutes);
    }
    if (p.name !== undefined) set("name", str(p.name), loop.name);
    if (p.model !== undefined) set("model", normalizeProviderSetting(p.model), loop.model);
    if (p.reasoningEffort !== undefined) set("reasoningEffort", normalizeProviderSetting(p.reasoningEffort), loop.reasoningEffort);
    if (p.taskFile !== undefined) set("taskFile", str(p.taskFile), loop.taskFile);
    if (p.notify !== undefined) {
      const v = p.notify;
      if (v !== "always" && v !== "auto" && v !== "never") rejections.push({ key: "notify", reason: "notify must be always|auto|never" });
      else set("notify", v, loop.notify);
    }
    // Coding agent: only a known `CodingAgent` (the shared enum validator, so this
    // widens automatically as the enum grows). The next run spawns the new agent,
    // matching how model/cron edits behave.
    if (p.agent !== undefined) {
      const a = coerceCodingAgent(p.agent);
      if (!a) rejections.push({ key: "agent", reason: `agent must be one of ${CODING_AGENTS.join(", ")}` });
      else set("agent", a, loop.agent);
    }
    if (p.allowControl !== undefined) set("allowControl", !!p.allowControl, loop.allowControl);
    if (p.enabled !== undefined) set("enabled", !!p.enabled, loop.enabled);
    // Goal set (non-empty) / clear (null|blank). store.updateLoop enforces the
    // lifecycle invariant: clearing the goal also clears the completion stamps,
    // and enabling a completed loop reopens it (drops the stamps).
    if (p.goal !== undefined) set("goal", str(p.goal)?.slice(0, GOAL_CAP) ?? null, loop.goal);
    if (p.runAt !== undefined) {
      // `null`/blank clears the pinned override (symmetric with goal:null, and what
      // `show --json` re-feeds when there is no override) — a no-op when already null.
      if (p.runAt === null || p.runAt === "") set("nextRunAt", null, loop.nextRunAt);
      // Re-feeding the loop's CURRENT pin verbatim is a recorded no-op, bypassing the
      // future-time guard: a paused/completed loop keeps a stale (past) `nextRunAt` that
      // `show --json` echoes, and roundtripping it back through `edit` must not 400.
      else if (String(p.runAt) === loop.nextRunAt) set("nextRunAt", loop.nextRunAt, loop.nextRunAt);
      else {
        const when = parseWhen(String(p.runAt));
        if (!when) rejections.push({ key: "runAt", reason: "run-at must be 30m|2h|1d or a future ISO time" });
        else if (Date.parse(when) > Date.now() + MAX_NEXT_MS) rejections.push({ key: "runAt", reason: "run-at too far in the future (>30d)" });
        else set("nextRunAt", when, loop.nextRunAt);
      }
    }
    // Content fields reuse the SAME validators the run-token set-* path uses, so
    // the owner edit surface can't drift from the evolve/edit run behavior. They
    // also get the same wire clip discipline as createLoop.
    // Content fields accept `null` as an explicit clear (what `show --json` re-feeds
    // when the field is unset — a no-op when already null, so the roundtrip holds).
    if (p.ui !== undefined) {
      if (p.ui === null) set("ui", null, loop.ui);
      else if (typeof p.ui !== "string") rejections.push({ key: "ui", reason: "ui must be a string (the dashboard HTML)" });
      else set("ui", validateUi(clipText(p.ui, WIRE_TEXT_CAP)).value, loop.ui);
    }
    if (p.stateSchema !== undefined) {
      if (p.stateSchema === null) set("stateSchema", null, loop.stateSchema);
      else {
        const v = await validateSchema(loop.id, p.stateSchema);
        if (!v.ok) rejections.push({ key: "stateSchema", reason: v.detail });
        else set("stateSchema", v.value, loop.stateSchema);
      }
    }
    return { update, changes, rejections };
  }

  /** Read a New-loop claim's result (the web dialog polls this while waiting). */
  claimStatus(token: string): ClaimResult | undefined {
    return readClaim(token);
  }

  // ---- POST /machine/report ----

  private async rejectRetiredConflict(
    runToken: string,
    lease: Pick<RunLease, "runId">,
    body: MachineReportBody,
    payloadDigest: string,
  ): Promise<HttpResult> {
    const ackBody = {
      ok: true,
      accepted: false,
      terminal: true,
      reportId: body.reportId!,
      code: "REPORT_CONFLICT",
      issues: ["reportId was already committed for another run"],
      disposition: "telemetry-rejected",
      payloadDigest,
    };
    const receipt = await store.acknowledgeRetiredTerminalIncident({
      runId: lease.runId,
      leaseTokenHash: sha256(runToken),
      reportId: body.reportId!,
      payloadDigest,
      ackBody,
    });
    return receipt
      ? { status: 200, body: receipt.ackBody }
      : { status: 401, body: { error: "invalid or expired token" } };
  }

  private async retiredReport(runToken: string, body: MachineReportBody, runId: string): Promise<HttpResult> {
    const expected = receiptFor(body, runId, 410, {
      error: "execution authority retired",
      code: "RETIRED",
      reportId: body.reportId!,
    })!;
    const stored = await store.acknowledgeRetiredReport(sha256(runToken), expected);
    if (!stored) {
      const winner = await store.getReportReceipt(expected.reportId);
      if (winner && winner.runId !== runId) {
        return this.rejectRetiredConflict(runToken, { runId }, body, sha256(JSON.stringify(body)));
      }
      const replay = receiptResponse(winner, expected);
      return replay ?? { status: 401, body: { error: "invalid or expired token" } };
    }
    if (stored.runId !== runId) {
      return this.rejectRetiredConflict(runToken, { runId }, body, sha256(JSON.stringify(body)));
    }
    return receiptResponse(stored, expected)!;
  }

  private async ignoreCanceledReport(runToken: string, lease: RunLease, body: MachineReportBody): Promise<HttpResult> {
    const expected = receiptFor(body, lease.runId)!;
    const stored = await store.putReportReceiptIfAbsent(expected);
    if (!stored) return { status: 401, body: { error: "invalid or expired token" } };
    if (stored.runId !== lease.runId) {
      const payloadDigest = sha256(JSON.stringify(body));
      const ackBody = {
        ok: true,
        accepted: false,
        terminal: true,
        reportId: body.reportId!,
        code: "REPORT_CONFLICT",
        issues: ["reportId was already committed for another run"],
        disposition: "telemetry-rejected",
        payloadDigest,
      };
      const incident = await store.putTerminalReportIncidentIfAbsent({
        runId: lease.runId,
        reportId: body.reportId!,
        payloadDigest,
        disposition: "telemetry-rejected",
        ackBody,
      });
      await retireLease(runToken);
      return { status: 200, body: incident.ackBody };
    }
    const response = receiptResponse(stored, expected)!;
    if (response.status < 300) await retireLease(runToken);
    log.info({ runId: lease.runId }, "report: ignored (run was canceled)");
    return response;
  }

  /** Finish already won. Enrich only run-local report data; a losing report must
   * never write loop task state or repeat terminal side effects. */
  private async enrichFinishedReport(
    runToken: string,
    lease: RunLease,
    body: MachineReportBody,
  ): Promise<HttpResult> {
    const run = await store.getRun(lease.runId);
    const message = reportMessage(body, run);
    const patch: Partial<NewRun> = {
      ...coerceTelemetry(body),
      ...(message !== undefined ? { message } : {}),
    };
    const receipt = receiptFor(body, lease.runId);
    const payloadDigest = sha256(JSON.stringify(body));
    let enriched: Awaited<ReturnType<typeof store.enrichFinishedRun>>;
    try {
      enriched = await store.enrichFinishedRun(
        lease.loopId,
        lease.runId,
        sha256(runToken),
        patch,
        receipt,
      );
    } catch (error) {
      const raced = await committedReportEvidence(body.reportId!, payloadDigest, lease.runId);
      if (raced.response) return raced.response;
      if (raced.foreignRun) return this.rejectTerminalAttempt(runToken, lease, body, payloadDigest, "REPORT_CONFLICT", ["reportId was already committed for another run"]);
      throw error;
    }
    if (!enriched) {
      const raced = await committedReportEvidence(body.reportId!, payloadDigest, lease.runId);
      if (raced.response) return raced.response;
      if (raced.foreignRun) return this.rejectTerminalAttempt(runToken, lease, body, payloadDigest, "REPORT_CONFLICT", ["reportId was already committed for another run"]);
      const refreshed = await resolveLease(runToken);
      if (refreshed?.state === "retired") return this.retiredReport(runToken, body, lease.runId);
      return { status: 409, body: { error: "terminal report was not finalized", code: "REPORT_NOT_FINALIZED", reportId: body.reportId } };
    }
    if (enriched && (await store.getLoop(lease.loopId))?.deleteRequestedAt) {
      await store.tryDeleteLoop(lease.loopId);
    }
    log.info({ runId: lease.runId, enriched: !!enriched }, "report: finished-run enrichment consumed");
    return { status: 200, body: receipt!.ackBody };
  }

  /** Reconcile one swept run. The store consumes the terminal-grace lease in the
   * same loop-lock transaction as the error→done/error patch and loop state, so
   * concurrent late reports cannot both win (including error→error). */
  private async reconcileReclaimedReport(
    runToken: string,
    lease: RunLease,
    run: Run,
    body: MachineReportBody,
  ): Promise<HttpResult> {
    const ok = body.result ? body.result === "success" : !!body.ok;
    const canceled = body.result === "canceled";
    const message = reportMessage(body, run);
    const claimedOutcome = RUN_OUTCOMES.has(body.outcome as string) ? body.outcome : undefined;
    const loopPatch: Partial<NewLoop> = {
      ...(typeof body.taskFileContent === "string"
        ? {
            taskFileContent: clipText(body.taskFileContent, WIRE_TEXT_CAP),
            taskFileSyncedAt: nowIso(),
          }
        : {}),
    };
    const receipt = receiptFor(body, lease.runId)!;
    const payloadDigest = sha256(JSON.stringify(body));
    let reconciled: Awaited<ReturnType<typeof store.reconcileReclaimedRun>>;
    try {
      reconciled = await store.reconcileReclaimedRun(
        lease.loopId,
        lease.runId,
        sha256(runToken),
      {
        phase: canceled ? "canceled" : ok ? "done" : "error",
        outcome: canceled ? "skipped" : ok ? claimedOutcome ?? (lease.role === "evolve" ? "evolve" : "exec") : "error",
        ...coerceTelemetry(body),
        ...(message !== undefined ? { message } : {}),
        ...(canceled
          ? { error: "stopped by user" }
          : ok
            ? { error: null }
            : { error: typeof body.error === "string" ? clipText(body.error, MESSAGE_CAP) : run.error }),
        ts: nowIso(),
      },
        loopPatch,
        AUTOPAUSE_STREAK,
        receipt,
      );
    } catch (error) {
      const raced = await committedReportEvidence(receipt.reportId, payloadDigest, lease.runId);
      if (raced.response) return raced.response;
      if (raced.foreignRun) return this.rejectTerminalAttempt(runToken, lease, body, payloadDigest, "REPORT_CONFLICT", ["reportId was already committed for another run"]);
      throw error;
    }
    if (!reconciled) {
      // Another terminal actor consumed the lease/phase. Handle the observed
      // winner once, without recursive report() retries.
      const raced = await committedReportEvidence(receipt.reportId, payloadDigest, lease.runId);
      if (raced.response) return raced.response;
      if (raced.foreignRun) return this.rejectTerminalAttempt(runToken, lease, body, payloadDigest, "REPORT_CONFLICT", ["reportId was already committed for another run"]);
      const fresh = await store.getRun(lease.runId);
      if (fresh?.phase === "canceled") return this.ignoreCanceledReport(runToken, lease, body);
      if (fresh?.phase === "done") return this.enrichFinishedReport(runToken, lease, body);
      const refreshed = await resolveLease(runToken);
      if (refreshed?.state === "retired") return this.retiredReport(runToken, body, lease.runId);
      log.info({ runId: lease.runId, phase: fresh?.phase }, "report: late reconcile lost terminal race");
      return { status: 409, body: { error: "terminal report was not finalized", code: "REPORT_NOT_FINALIZED", reportId: body.reportId } };
    }

    const deleting = reconciled.loop.deleteRequestedAt != null;
    if (!deleting) try {
      await store.putRunSnapshot(lease.runId, lease.loopId, await store.buildLoopManifest(lease.loopId));
      await store.pruneRunSnapshots(lease.loopId, snapshotRetention());
    } catch (err) {
      log.warn({ runId: lease.runId, err: err instanceof Error ? err.message : String(err) }, "snapshot capture failed");
    }
    const finalized = reconciled.run;
    if (!deleting && ok && lease.role !== "evolve" && lease.role !== "edit") {
      const loop = await store.getLoop(lease.loopId);
      if (finalized.message && loop && shouldNotify(loop.notify, finalized.status ?? null)) {
        this.pushNotify(loop, finalized.message);
      }
    }
    this.scheduler.addLoop(reconciled.loop);
    if (!deleting && !ok && !canceled && lease.role === "exec") {
      // The provisional reclaim already sent the failure alert, but the real
      // failure must still be allowed to trip the circuit breaker.
      await this.notifyRunFailure(lease.loopId, lease.role, finalized.error ?? null, reconciled, { alert: false });
    }
    if (deleting) await store.tryDeleteLoop(lease.loopId);
    log.info(
      { runId: lease.runId, ok, reclaimed: true },
      canceled
        ? "report: reconciled a reclaimed run to canceled"
        : ok
          ? "report: reconciled a reclaimed run to done (machine woke)"
          : "report: recorded a reclaimed run's real error",
    );
    return { status: 200, body: body.reportId ? { ok: true, reportId: body.reportId } : { ok: true, reconciled: true } };
  }

  private async rejectTerminalAttempt(
    runToken: string,
    lease: RunLease,
    body: MachineReportBody,
    payloadDigest: string,
    code: ReportIncidentCode,
    issues: string[],
  ): Promise<HttpResult> {
    const reportId = body.reportId!;
    const run = await store.getRun(lease.runId);
    const telemetryOnly = lease.state === "terminal-grace" && (run?.phase === "done" || run?.phase === "error" || run?.phase === "canceled");
    const disposition = telemetryOnly ? "telemetry-rejected" as const : "run-error" as const;
    const incident = incidentDiagnosis(code, issues, reportId, payloadDigest);
    const ackBody = {
      ok: true,
      accepted: false,
      terminal: true,
      reportId,
      code,
      issues,
      disposition,
      payloadDigest,
    };
    if (lease.state === "retired") return this.retiredReport(runToken, body, lease.runId);
    const rejected = await store.rejectTerminalReport({
      loopId: lease.loopId,
      runId: lease.runId,
      leaseTokenHash: sha256(runToken),
      leaseState: lease.state,
      reportId,
      payloadDigest,
      disposition,
      incident,
      ackBody,
      failureAutopauseStreak: AUTOPAUSE_STREAK,
    });
    if (rejected.state === "normal-replay") {
      return { status: rejected.receipt.ackStatus, body: rejected.receipt.ackBody };
    }
    if (rejected.state === "incident-replay") {
      return { status: 200, body: rejected.receipt.ackBody };
    }
    if (rejected.state === "run-error" || rejected.state === "telemetry-rejected") {
      this.scheduler.addLoop(rejected.loop);
      if (rejected.state === "run-error" && lease.role === "exec") {
        await this.notifyRunFailure(lease.loopId, lease.role, incident.reason, rejected);
      }
      if (rejected.loop.deleteRequestedAt) await store.tryDeleteLoop(lease.loopId);
      log.warn({ runId: lease.runId, reportId, code, disposition }, "report: rejected terminal attempt durably handled");
      return { status: 200, body: rejected.receipt.ackBody };
    }
    const evidence = await committedReportEvidence(reportId, payloadDigest, body.runId);
    if (evidence.response) return evidence.response;
    const refreshed = await resolveLease(runToken);
    if (refreshed?.state === "retired") return this.retiredReport(runToken, body, lease.runId);
    return { status: 401, body: { error: "invalid or expired token" } };
  }

  async report(runToken: string, body: MachineReportBody): Promise<HttpResult> {
    // An uncorrelatable id can never be acknowledged by the daemon's durable
    // outbox. Authenticate it, but keep it safely nonterminal and mutation-free.
    if (!correlatableReportId(body.reportId)) {
      if (!(await resolveLease(runToken))) return { status: 401, body: { error: "invalid or expired token" } };
      return { status: 400, body: { error: "reportId must be a non-empty NUL-free string of at most 200 characters", code: "VALIDATION_ERROR" } };
    }
    const reportId = body.reportId;
    // The daemon hashes its exact JSON.stringify payload bytes. The machine route
    // parses that JSON once, and stringify preserves insertion order, giving both
    // sides the same digest without conflating it with canonical normal receipts.
    const payloadDigest = sha256(JSON.stringify(body));
    const lease = await resolveLease(runToken);
    if (!lease) {
      // A consumed lease cannot authenticate a replay. Exact incident evidence or
      // an authoritative normal receipt for the claimed run is the durable proof.
      const replay = await committedReportEvidence(reportId, payloadDigest, body.runId, true);
      return replay.response ?? { status: 401, body: { error: "invalid or expired token" } };
    }
    // With live authority, the lease's run is authoritative; never let an
    // attacker-controlled body.runId replay another run's ACK and strand this one.
    const evidence = await committedReportEvidence(reportId, payloadDigest, lease.runId);
    if (evidence.response) return evidence.response;
    if (lease.state === "retired") {
      if (evidence.foreignRun) return this.rejectRetiredConflict(runToken, lease, body, payloadDigest);
      return this.retiredReport(runToken, body, lease.runId);
    }

    const issues: string[] = [];
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reportId)) {
      issues.push("reportId must be a valid UUID");
    }
    if (typeof body.runId !== "string" || !body.runId) issues.push("runId is required");
    else if (body.runId !== lease.runId) issues.push("runId does not match this run lease");
    issues.push(...validateTerminalReport(body));
    if (evidence.foreignRun) {
      return this.rejectTerminalAttempt(runToken, lease, body, payloadDigest, "REPORT_CONFLICT", ["reportId was already committed for another run"]);
    }
    if (issues.length) {
      return this.rejectTerminalAttempt(runToken, lease, body, payloadDigest, "REPORT_INVALID", issues);
    }

    const expected = receiptFor(body, lease.runId)!;
    const ok = body.result !== undefined ? body.result === "success" : body.ok === true;
    const canceled = body.result === "canceled";

    const run = await store.getRun(lease.runId);
    if (run?.phase === "canceled") return this.ignoreCanceledReport(runToken, lease, body);
    if (run?.phase === "done") return this.enrichFinishedReport(runToken, lease, body);
    if (run?.phase === "error" && lease.state === "terminal-grace") {
      return this.reconcileReclaimedReport(runToken, lease, run, body);
    }

    // Held until the running→terminal CAS wins. Cancel/reclaim/report losers can
    // never reach these loop-level writes.
    const loopPatch: Partial<NewLoop> = {
      ...(typeof body.taskFileContent === "string"
        ? {
            taskFileContent: clipText(body.taskFileContent, WIRE_TEXT_CAP),
            taskFileSyncedAt: nowIso(),
          }
        : {}),
    };

    // An agent may already have persisted a message through `pievo report`.
    // Provider final text is only fallback.
    const message = reportMessage(body, run);

    // Whitelist the claimed outcome (untrusted wire input) — anything outside the
    // known enum falls back to the role default rather than landing in the column.
    const claimedOutcome = RUN_OUTCOMES.has(body.outcome as string) ? body.outcome : undefined;
    let terminal: Awaited<ReturnType<typeof store.finalizeRunningRun>>;
    try {
      terminal = await store.finalizeRunningRun(
        lease.loopId,
        lease.runId,
        {
        phase: canceled ? "canceled" : ok ? "done" : "error",
        outcome: canceled ? "skipped" : ok ? claimedOutcome ?? (lease.role === "evolve" ? "evolve" : "exec") : "error",
        ...coerceTelemetry(body),
        ...(message !== undefined ? { message } : {}),
        ...(canceled
          ? { error: "stopped by user" }
          : ok ? {} : { error: typeof body.error === "string" ? clipText(body.error, MESSAGE_CAP) : "run failed on machine" }),
        ts: nowIso(),
      },
        loopPatch,
        sha256(runToken),
        AUTOPAUSE_STREAK,
        expected,
      );
    } catch (error) {
      // A different loop may win the reportId unique race while this transaction
      // waits. Its insert rolls this finalization back; convert the collision to a
      // replay/conflict only after observing the durable winning receipt.
      const raced = await committedReportEvidence(reportId, payloadDigest, lease.runId);
      if (raced.response) return raced.response;
      if (raced.foreignRun) {
        return this.rejectTerminalAttempt(runToken, lease, body, payloadDigest, "REPORT_CONFLICT", ["reportId was already committed for another run"]);
      }
      throw error;
    }
    if (!terminal) {
      // A concurrent report may have passed the pre-lock receipt read. Re-read
      // after the loop-lock winner commits before considering legacy loser paths.
      const raced = await committedReportEvidence(reportId, payloadDigest, lease.runId);
      if (raced.response) return raced.response;
      if (raced.foreignRun) {
        return this.rejectTerminalAttempt(runToken, lease, body, payloadDigest, "REPORT_CONFLICT", ["reportId was already committed for another run"]);
      }
      const fresh = await store.getRun(lease.runId);
      if (fresh?.phase === "canceled") return this.ignoreCanceledReport(runToken, lease, body);
      if (fresh?.phase === "done") return this.enrichFinishedReport(runToken, lease, body);
      const refreshedLease = await resolveLease(runToken);
      if (refreshedLease?.state === "retired") return this.retiredReport(runToken, body, lease.runId);
      if (fresh?.phase === "error" && refreshedLease?.state === "terminal-grace") {
        return this.reconcileReclaimedReport(runToken, refreshedLease, fresh, body);
      }
      log.info({ runId: lease.runId, phase: fresh?.phase }, "report: lost terminal race");
      return { status: 409, body: { error: "terminal report was not finalized", code: "REPORT_NOT_FINALIZED", reportId } };
    }
    const finalized = terminal.run;

    // A delete-requested loop needs only the atomic receipt/finalization; deletion
    // follows in a second transaction and maintenance can repair a crash gap.
    const deleting = terminal.loop.deleteRequestedAt != null;
    if (!deleting) try {
      await store.putRunSnapshot(lease.runId, lease.loopId, await store.buildLoopManifest(lease.loopId));
      // Bound the snapshot history right away (cheap, keeps the table from growing
      // unbounded between maintenance passes). The blobs this unpins are reclaimed
      // by the periodic GC, not here — the grace window means a just-unreferenced
      // blob isn't collectable yet anyway, and report() must stay lean + zero-exec.
      await store.pruneRunSnapshots(lease.loopId, snapshotRetention());
    } catch (err) {
      log.warn({ runId: lease.runId, err: err instanceof Error ? err.message : String(err) }, "snapshot capture failed");
    }

    // Terminal cadence + auto-evolve were committed with the run transition.
    // This only refreshes the best-effort timer.
    this.scheduler.addLoop(terminal.loop);

    // Notify (the loop's chosen channel), best-effort. Edit/evolve runs are
    // internal (owner config change / self-shaping) — never user-facing, success
    // OR failure. `updateRun` already returned the finalized row.
    if (!deleting && lease.role === "exec") {
      if (ok) {
        // Success: gate on the loop's notify policy + the run's content status.
        const loop = await store.getLoop(lease.loopId);
        if (finalized?.message && loop && shouldNotify(loop.notify, finalized.status ?? null)) {
          this.pushNotify(loop, finalized.message);
        }
      } else if (!canceled) {
        // The breaker may pause the loop, clearing its cadence fact and canceling
        // pending system work in the same store transaction.
        await this.notifyRunFailure(lease.loopId, lease.role, finalized?.error ?? null, terminal);
      }
    }
    log.info({ runId: lease.runId, ok }, "report: finalized");
    if (deleting) await store.tryDeleteLoop(lease.loopId);
    return { status: 200, body: reportId ? { ok: true, reportId } : { ok: true } };
  }

  /**
   * The `pievo finish` verb's effect (closed-loop self-termination): record THIS
   * run as an ordinary success (phase=done, outcome=exec, status=resolved) with the
   * run's summary/metrics, then stamp the loop terminal (completedAt=now,
   * completionReason, enabled=false), remove it from the scheduler, capture the end-
   * state snapshot, and fire a completion notification unless notify=never. Gated
   * upstream by lease.canFinish (exec-on-closed-loop only).
   *
   * TOCTOU guard: canFinish was minted at poll; the owner may have CLEARED the goal
   * since (editLoop {goal:null}) — completing then would violate the invariant
   * "completedAt != null implies goal != null". So re-read the loop and refuse with
   * a clear error when it's no longer a closed loop. Nothing is stamped.
   *
   * The store atomically moves the lease to a fixed 10-minute terminal-grace:
   * mutation authority ends with the Run, while exactly one daemon report may add
   * precise duration/session telemetry. Grace expiry becomes durable retired
   * evidence and unblocks the machine; a later report receives 410. The completedAt
   * guard keeps finish single-shot, and enrichment never re-stamps or re-notifies.
   *
   * Public (not private): `CliGateway`'s `finish`/`complete` dispatch case is the
   * second consumer - the verb routing moved to `gateway/cli.ts`, the core
   * loop-lifecycle write stays here.
   */
  async finishLoop(
    lease: RunLease,
    leaseTokenHash: string,
    { message, reason, state }: { message?: string; reason: string | null; state?: Record<string, number | string> },
  ): Promise<Applied> {
    const ts = nowIso();
    // The store serializes this whole transition with poll claims on the loop row:
    // run done + completed/paused + pending exec/evolve cancellation have no gap.
    const currentRun = await store.getRun(lease.runId);
    const durationMs = currentRun ? Date.now() - Date.parse(currentRun.ts) : NaN;
    const finished = await store.finishLoopRun(lease.loopId, lease.runId, leaseTokenHash, {
      ts,
      reason,
      ...(message !== undefined ? { message } : {}),
      ...(state !== undefined ? { state } : {}),
      ...(Number.isFinite(durationMs) && durationMs >= 0 ? { durationMs } : {}),
    });
    if (finished.state === "goal-cleared" || finished.state === "missing") {
      return { ok: false, detail: "this loop no longer has a goal to finish — its goal was cleared since this run started" };
    }
    if (finished.state === "already-finished") {
      return { ok: false, detail: "this loop is already finished", code: "CONFLICT" };
    }
    if (finished.state === "forbidden") {
      return { ok: false, detail: "this run may not finish this loop", code: "FORBIDDEN", status: 403 };
    }
    if (finished.state !== "finished") {
      return { ok: false, detail: "this run is no longer running", code: "CONFLICT", status: 409 };
    }
    const loop = finished.loop;
    this.scheduler.removeLoop(lease.loopId);
    // Snapshot the loop's end-state (Phase 3 diff baseline), best-effort like report().
    try {
      await store.putRunSnapshot(lease.runId, lease.loopId, await store.buildLoopManifest(lease.loopId));
      await store.pruneRunSnapshots(lease.loopId, snapshotRetention());
    } catch (err) {
      log.warn({ runId: lease.runId, err: err instanceof Error ? err.message : String(err) }, "finish: snapshot capture failed");
    }
    // Completion is a distinct terminal event — notify unless the user opted out
    // of all pushes (notify: "never"). Best-effort (void), like the report path.
    if (loop && loop.notify !== "never") {
      this.pushNotify(loop, completionMessage(reason, message));
    }
    log.info({ runId: lease.runId, loopId: lease.loopId }, "finish: loop completed");
    return { ok: true, detail: "loop finished — goal met, loop completed" };
  }
}

// ---- helpers (ported from control.ts) ----

/** The `{ ok, detail }` result shape shared by `finishLoop`/`validCadence` here and
 *  the `applyMutation`/`applySet*` verb bodies in `cli.ts`. */
export interface Applied {
  ok: boolean;
  detail?: string;
  /** An explicit axi error slug for a rejection (else the caller derives it from the
   *  HTTP status). Used to mark a second-`finish` as CONFLICT rather than a generic
   *  VALIDATION_ERROR. */
  code?: string;
  /** Optional HTTP status for atomic authorization/conflict rejections. */
  status?: number;
}

// ---- TOON render helpers (batch 1: the axi-conformance spine) ----------------
// Each builds the `text` a CLI verb carries; the CLI-only renders live with their
// verbs in `cli.ts` (whose `finalizeCli` strips the superset fields at the
// `/api/machine/cli` boundary - the legacy endpoints keep them). Pure — no I/O,
// no clock — so they're exercised both here (via the verb tests) and directly in
// `toon.test.ts`. The time formatters + outcome/metric tokens are exported for
// `cli.ts` so both files render cells identically.

/** Compact a stored ISO timestamp to `YYYY-MM-DD HH:MM` (UTC, as stored) for a TOON
 *  cell — a date the agent reads at a glance without the `T`/seconds/zone noise. */
export function fmtTime(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

/** Format an instant in a loop's OWN timezone with a short zone name
 *  (`2026-07-08 05:00 GMT+8`), so cadence previews read in the schedule the owner set
 *  rather than raw UTC (F9). `seconds` adds `:SS` for the single `show` nextFire; the
 *  multi-item `nextRuns` list stays minute-granular. Falls back to the bare `fmtTime`
 *  slice if the tz is invalid/absent. */
export function fmtTimeZoned(iso: string, timezone: string | null, opts: { seconds?: boolean } = {}): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone ?? undefined,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      ...(opts.seconds ? { second: "2-digit" } : {}),
      hour12: false,
      timeZoneName: "short",
    }).formatToParts(new Date(iso));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const sec = opts.seconds ? `:${get("second")}` : "";
    return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}${sec} ${get("timeZoneName")}`;
  } catch {
    return fmtTime(iso);
  }
}

/** `pievo loops` default columns (P2 — minimal): identity + the two things an
 *  agent scans for (schedule + when it next fires). */
const LIST_DEFAULT_FIELDS: string[] = ["id", "name", "cron", "enabled", "nextFire"];
/** The optional columns `--fields` may add (the "available" set an unknown field is
 *  measured against, §4.2). `runs`/`lastOutcome` are derived per loop. */
const LIST_OPTIONAL_FIELDS: string[] = ["timezone", "notify", "model", "reasoningEffort", "goal", "taskFile", "runs", "lastOutcome"];

/** A loop's row for `pievo loops`: every renderable cell precomputed once (so the
 *  `--fields` selection is a pure column pick). The structured `loops` body carries the
 *  whole record — a RETAINED data channel the daemon reads to resolve cwd→loop
 *  client-side (id/name/workdir/taskFile), not for rendering. */
interface LoopListRecord {
  id: string;
  name: string;
  cron: string;
  scheduleMode: "cron" | "continuous";
  continuousDelayMinutes: number;
  timezone: string | null;
  enabled: boolean;
  notify: string;
  model: string | null;
  reasoningEffort: string | null;
  goal: string | null;
  taskFile: string | null;
  nextRunAt: string | null;
  workdir: string | null;
  /** Derived: the next cron fire in the loop's tz (ISO), or null when paused. */
  nextFire: string | null;
  /** Derived: total run count. */
  runs: number;
  /** Derived: the most recent run's outcome token, or null (no runs yet). */
  lastOutcome: string | null;
}

/** One `loops` cell for a named column (scalar-rendered by `listBlock`). */
function loopCell(rec: LoopListRecord, field: string): Scalar {
  switch (field) {
    case "id": return rec.id;
    case "name": return rec.name;
    case "cron": return rec.scheduleMode === "continuous" ? `continuous +${rec.continuousDelayMinutes}m` : rec.cron;
    case "enabled": return rec.enabled ? "on" : "paused";
    case "nextFire": return rec.nextFire ? fmtTime(rec.nextFire) : null;
    case "timezone": return rec.timezone;
    case "notify": return rec.notify;
    case "model": return rec.model;
    case "reasoningEffort": return rec.reasoningEffort;
    case "goal": return rec.goal;
    case "taskFile": return rec.taskFile;
    case "runs": return rec.runs;
    case "lastOutcome": return rec.lastOutcome;
    default: return null;
  }
}

/** `pievo loops` — the typed loop list (P2/P4/P5/P9). Columns = the default set
 *  plus any `--fields` extras (validated + resolved by `listLoops`). */
function renderLoopsText(loops: LoopListRecord[], fields: string[]): string {
  if (!loops.length) {
    return doc(
      countLine(0),
      emptyList("loops"),
      helpBlock([
        "Run `pievo new --json '{\"cron\":\"0 8 * * *\",\"taskFile\":\"<path>\"}'` to create your first loop",
        "Run `pievo daemon start` if this machine isn't connected yet",
      ]),
    );
  }
  return doc(
    countLine(loops.length),
    listBlock(
      "loops",
      fields,
      loops.map((l) => fields.map((f) => loopCell(l, f))),
    ),
    helpBlock(["Run `pievo show <id>` to see a loop's full config", "Run `pievo log <id>` to see a loop's recent runs"]),
  );
}

/** One run's `outcome` cell: an evolve pass reads `evolve`; otherwise `ok`/`failed`
 *  (from the phase) suffixed with the content status (`ok/nothing-new`). */
export function runOutcomeToken(r: { phase: string; outcome: string | null; status: string | null }): string {
  if (r.outcome === "evolve") return "evolve";
  if (r.outcome === "skipped") return "skipped";
  const base = r.phase === "error" ? "failed" : r.phase === "done" ? "ok" : r.phase;
  return r.status ? `${base}/${r.status}` : base;
}

/** A run's reported metrics as `k=v,k=v` (or null → the em-dash), for the log cell. */
export function runMetricsToken(state: Record<string, unknown> | null | undefined): string | null {
  if (!state || typeof state !== "object") return null;
  const parts = Object.entries(state).map(([k, v]) => `${k}=${v}`);
  return parts.length ? parts.join(",") : null;
}

/** How many chars of a run message the log cell inlines before the size hint. */
export const LOG_MESSAGE_CELL_CAP = 100;

interface LogRun {
  ts: string;
  role: string;
  phase: string;
  outcome: string | null;
  status: string | null;
  sessionId: string | null;
  state: Record<string, unknown> | null;
  message: string | null;
}

/** `pievo log` — the TOON run survey (F2: the in-run callback prints this `text`,
 *  so in-run `pievo log` starts working the day Batch 1 deploys). */
function renderLogText(name: string, loopId: string, runs: LogRun[], total: number): string {
  const head = `loop: ${scalar(name)} (${loopId})`;
  if (!runs.length) {
    return doc(
      head,
      countLine(0, { total }),
      emptyList("runs"),
      helpBlock([`Run \`pievo show ${loopId}\` to see the loop config`]),
    );
  }
  const rows: (string | number | null)[][] = runs.map((r) => [
    fmtTime(r.ts),
    r.role,
    runOutcomeToken(r),
    runMetricsToken(r.state),
    r.sessionId,
    r.message ? truncate(r.message, LOG_MESSAGE_CELL_CAP, "use --json").value : null,
  ]);
  const ok = runs.filter((r) => r.phase === "done").length;
  const failed = runs.filter((r) => r.phase === "error").length;
  const lastExec = runs.find((r) => r.role === "exec");
  const summary = [
    `showing ${runs.length} of ${total}`,
    `${ok} ok`,
    ...(failed ? [`${failed} failed`] : []),
    ...(lastExec ? [`last exec ${runOutcomeToken(lastExec)} ${fmtTime(lastExec.ts)}`] : []),
  ].join(" · ");
  return doc(
    head,
    countLine(runs.length, { total }),
    listBlock("runs", ["ts", "role", "outcome", "metrics", "session", "message"], rows),
    `summary: ${summary}`,
    helpBlock(["Run `pievo log --json` for normalized run fields and token usage"]),
  );
}

/** `pievo new` (real create) — the created-loop confirmation (P4/P9). */
function renderCreatedText(
  name: string,
  loopId: string,
  cron: string,
  scheduleMode: "cron" | "continuous",
  continuousDelayMinutes: number,
  timezone: string | null,
  goal: string | null,
  uiApplied: boolean,
  warning: string | undefined,
): string {
  // Continuous has no speculative wall-clock fire until an exec terminates.
  const nextRuns = scheduleMode === "cron" ? nextFires(cron, timezone, 3).map((iso) => fmtTimeZoned(iso, timezone)) : [];
  return doc(
    `created: ${scalar(name)} (${loopId})`,
    `classification: ${goal != null ? "closed — self-finishes when the goal is met" : "open — runs until paused"}`,
    `dashboard: ${uiApplied ? "applied" : "not applied"}`,
    `schedule: ${scheduleMode === "continuous" ? `continuous — ${continuousDelayMinutes}m after each exec terminal` : `cron — ${cron}`}`,
    nextRuns.length ? inlineArray("nextRuns", nextRuns, " · ") : null,
    warning ? kvLine("warning", warning) : null,
    helpBlock([
      `Run \`pievo show ${loopId}\` to see the full config`,
      `Run \`pievo log ${loopId}\` after the first run to see how it went`,
    ]),
  );
}

/** `pievo new` idempotent REPLAY (§4.5, F8) — the existing loop returned, never a
 *  twin. Terser than a fresh create (no dashboard/nextRuns lines): the loop already
 *  exists, so the agent just needs to know which one and how to inspect it. */
function renderReplayText(name: string, loopId: string, goal: string | null): string {
  return doc(
    `created: ${scalar(name)} (${loopId}) [idempotent replay — existing loop returned]`,
    `classification: ${goal != null ? "closed — self-finishes when the goal is met" : "open — runs until paused"}`,
    helpBlock([`Run \`pievo show ${loopId}\` to see the full config`]),
  );
}

/** `pievo new --dry-run` — the normalized config + fire preview (no persistence). */
function renderCreateDryRunText(
  config: { name: string | null; cron: string; scheduleMode: "cron" | "continuous"; continuousDelayMinutes: number; timezone: string | null; taskFile: string | null; model: string | null; reasoningEffort: string | null; ui: boolean; goal: string | null; notify: string },
  nextRuns: string[],
  warning: string | undefined,
): string {
  return doc(
    detailBlock("dry-run", [
      ["name", config.name],
      ["cron", config.cron],
      ["scheduleMode", config.scheduleMode],
      ["continuousDelayMinutes", config.continuousDelayMinutes],
      ["timezone", config.timezone],
      ["taskFile", config.taskFile],
      ["model", config.model ?? { raw: "default" }],
      ["reasoningEffort", config.reasoningEffort ?? { raw: "default" }],
      ["ui", config.ui ? "present" : "absent"],
      ["goal", config.goal],
      ["notify", config.notify],
    ]),
    nextRuns.length ? inlineArray("nextRuns", nextRuns.map((iso) => fmtTimeZoned(iso, config.timezone)), " · ") : null,
    `classification: ${config.goal != null ? "closed — self-finishes when the goal is met" : "open — runs until paused"}`,
    warning ? kvLine("warning", warning) : null,
    helpBlock(["Run `pievo new --json '{...}'` (drop --dry-run) to create the loop"]),
  );
}

/** `pievo edit` (real apply) — the updated-loop confirmation. */
function renderEditAppliedText(loopId: string, name: string, applied: string[]): string {
  return doc(
    `updated: ${scalar(name)} (${loopId})`,
    inlineArray("applied", applied),
    helpBlock([`Run \`pievo show ${loopId}\` to confirm the new config`]),
  );
}

/** `pievo edit --json '{}'` — the empty-patch no-op (feedback #3). Reports plainly
 *  that nothing changed and lists the keys an edit MAY touch, so the agent's next
 *  attempt is well-formed without having to fail to discover the envelope. */
function renderEditNoopText(loopId: string, name: string): string {
  return doc(
    `nothing to change: ${scalar(name)} (${loopId})`,
    inlineArray("editable", [...EDITABLE_LOOP_FIELDS]),
    helpBlock([`Run \`pievo show ${loopId}\` to see the current config`]),
  );
}

/** `pievo edit --dry-run` — the per-key before→after preview + rejections. */
function renderEditDryRunText(
  loopId: string,
  name: string,
  changes: Array<{ key: string; from: unknown; to: unknown }>,
  rejections: Array<{ key: string; reason: string }>,
): string {
  const header = rejections.length
    ? `dry-run: ${scalar(name)} — ${changes.length} change${changes.length === 1 ? "" : "s"} valid, ${rejections.length} rejected`
    : `dry-run: ${scalar(name)} — nothing changed`;
  return doc(
    header,
    changes.length
      ? listBlock("changes", ["key", "from", "to"], changes.map((c) => [c.key, c.from as Scalar, c.to as Scalar]))
      : "changes: none",
    rejections.length
      ? listBlock("rejections", ["key", "reason"], rejections.map((r) => [r.key, r.reason]))
      : "rejections: none",
    helpBlock([`Run \`pievo edit ${loopId} --json '{...}'\` (drop --dry-run) to apply`]),
  );
}

/** Trim a value to a non-empty string, or null (NUL stripped). Shared by
 *  createLoop/editLoop. */
function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = stripNul(v).trim();
  return t ? t : null;
}

/** Structural equality for an editLoop before→after comparison: null and undefined
 *  are equal (an absent field re-fed as null is unchanged); objects/arrays compare by
 *  their CANONICAL JSON serialization (stateSchema is a small array; object keys are
 *  sorted so the comparison is order-INSENSITIVE — a value re-read from a pg `jsonb`
 *  column comes back with its keys normalized, which must not read as a change against
 *  a freshly-coerced value); everything else by `===`. Powers the no-op filter that
 *  makes the `show --json` → `edit` roundtrip a no-op. */
function sameLoopValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (typeof a === "object" || typeof b === "object") return canonicalJson(a) === canonicalJson(b);
  return false;
}

/** Stable JSON with recursively sorted object keys — so two structurally-equal values
 *  serialize identically regardless of key ordering (pg `jsonb` normalizes key order). */
function canonicalJson(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
      : val,
  );
}

/** Bound a value for the dry-run before→after preview: a long content string
 *  (dashboard HTML) is clipped so the response stays small; other scalars/arrays
 *  pass through as-is (they're already small). */
function clipPreview(v: unknown): unknown {
  const CAP = 200;
  if (typeof v === "string" && v.length > CAP) return v.slice(0, CAP) + `… (+${v.length - CAP} chars)`;
  return v;
}

/** Exported for `cli.ts` (`set-tz`), so every write path shares one tz check. */
export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The one user-facing message for a rejected timezone, shared by every write path. */
export function invalidTimezoneError(tz: string): string {
  return `invalid timezone: ${tz} (use an IANA name e.g. "Asia/Shanghai")`;
}

/** Probe the cadence IN the loop's timezone (fire times shift with it) — the tz,
 *  when given, must already be validated (validTimezone) so a croner throw here
 *  always means a bad expression, not a bad zone. Exported for `cli.ts` (`set-cron`). */
export function validCadence(cron: string, timezone?: string | null): Applied {
  try {
    const c = new Cron(cron, { paused: true, ...(timezone ? { timezone } : {}) });
    const a = c.nextRun();
    const b = a ? c.nextRun(a) : null;
    c.stop();
    if (!a || !b) return { ok: false, detail: "cron never fires twice" };
    if (b.getTime() - a.getTime() < MIN_INTERVAL_MS) return { ok: false, detail: "interval too dense (min 1/min)" };
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** The next N fire times of a cron, probed IN the loop's timezone (fire times shift
 *  with it — matching how the scheduler arms the loop), as ISO strings. Empty when
 *  the expression is invalid (the caller has already run validCadence). Powers the
 *  `--dry-run` fire preview. */
export function nextFires(cron: string, timezone: string | null | undefined, n: number): string[] {
  try {
    const c = new Cron(cron, { paused: true, ...(timezone ? { timezone } : {}) });
    const out: string[] = [];
    let prev: Date | undefined;
    for (let i = 0; i < n; i++) {
      const next = prev ? c.nextRun(prev) : c.nextRun();
      if (!next) break;
      out.push(next.toISOString());
      prev = next;
    }
    c.stop();
    return out;
  } catch {
    return [];
  }
}

/** Parse `--next` into an ISO string: relative `30m`/`2h`/`1d` or an absolute ISO. */
export function parseWhen(s: string): string | undefined {
  const rel = s.match(/^(\d+)\s*(m|h|d)$/i);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]!.toLowerCase();
    const ms = n * (unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000);
    return new Date(Date.now() + ms).toISOString();
  }
  const t = Date.parse(s);
  if (!Number.isNaN(t) && t > Date.now()) return new Date(t).toISOString();
  return undefined;
}

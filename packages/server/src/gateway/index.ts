/**
 * Machine gateway: the run-lifecycle core the daemon talks to. Methods return
 * transport-free `{ status, body }` results for the thin route shells:
 *
 *   POST /api/machine/poll   (device token) claim and deliver runs
 *   POST /machine/report     (run token)    finalize a run, including its memory
 *
 * Idle polls may be held open (long-poll) until the scheduler's dispatcher wakes
 * them. `sweep()` marks stale machines offline and reclaims silent runs. CLI verbs
 * live in `cli.ts`; loop config validation lives in `loopConfig.ts`.
 */
import { Cron } from "croner";

import { logger } from "../logger.js";
import * as store from "../db/store.js";
import type { Loop, NewLoop, NewRun, Run, RunUsage } from "../db/schema.js";
import type { ReportIncident, ReportIncidentCode, ReportIncidentFaultDomain } from "../types.js";
import type { Scheduler } from "../scheduler/index.js";
import { buildDelivery } from "./delivery.js";
import { parseFinalStatus } from "./prompt.js";
import { MEMORY_CHAR_CAP, memoryIssue } from "./memory.js";
import { isValidSemver } from "../lib/semver.js";
import {
  connectKeyValid,
  TERMINAL_GRACE_MS,
  resolveLease,
  retireLease,
  pruneExpiredLeases,
  readNewIdempotency,
  recordNewIdempotency,
  sha256,
  type RunLease,
} from "./tokens.js";
import { authenticateDeviceToken } from "./deviceAuth.js";
import {
  countLine,
  doc,
  emptyList,
  helpBlock,
  listBlock,
  type Scalar,
} from "./toon.js";
import { canonicalLoopEnvelope, LOOP_EDIT_FIELDS, scheduleFromLoop, validateLoopCreate, validateLoopEdit } from "./loopConfig.js";
import { DAEMON_PROTOCOL_VERSION, MIN_DAEMON_VERSION, daemonNeedsUpdate, daemonUpgradeCommand } from "./protocol.js";
import { clipText, nowIso, POLL_VERSION_CAP, WIRE_TEXT_CAP, type HttpResult } from "./http.js";
import {
  POLL_V4_REQUEST_FIELDS,
  validPollCurrentRun,
  validPollInfo,
  validPollWireId,
  type PollV4Request,
} from "./pollValidation.js";

const log = logger.child({ mod: "gateway" });
type Delivery = Awaited<ReturnType<typeof buildDelivery>>;

export const ONLINE_TTL_MS = 30_000;
/** Auto-pause after this many consecutive errors. Canceled rows are transparent;
 *  zero disables the breaker. */
const AUTOPAUSE_STREAK = Math.max(0, Number(process.env.PIEVO_FAILURE_AUTOPAUSE_STREAK ?? 3));

const DEFERRED_MAX_MS = 7 * 86_400_000;
/** A claimed run that never reports within this window is reclaimed as timed out. */
const configuredRunTimeoutMs = Number(process.env.PIEVO_RUN_TIMEOUT_MS || 20 * 60_000);
const RUN_TIMEOUT_MS = Number.isFinite(configuredRunTimeoutMs) && configuredRunTimeoutMs > 0
  ? configuredRunTimeoutMs
  : 20 * 60_000;
/** The ONLY keys an owner `editLoop` patch may touch. A key outside this set is
 *  rejected (400) rather than silently ignored, so a `--json` typo fails loudly
 *  and identity columns (id/machineId/timestamps) can never be
 *  patched over the device-token edit surface. Exported for `cli.ts`
 *  (the `new`/`edit` verb help lists these keys). */
export const EDITABLE_LOOP_FIELDS = LOOP_EDIT_FIELDS;
/** Run summary (the final response minus its STATUS line) and run errors share
 *  this cap; the full final response is stored separately as finalText. */
export const MESSAGE_CAP = 2000;
/** A run's own memory rejection plus a few spare; bounds the prompt echo. */
const REPORT_NOTICES_MAX = 4;
/** One short sentence; 500 chars keeps the next prompt small. */
const NOTICE_CAP = 500;
/** Provider session IDs are opaque short tokens; this rejects malformed payloads
 *  without constraining known provider formats. */
const SESSION_ID_CAP = 200;
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

export interface MachineReportBody {
  reportId?: string;
  runId?: string;
  result?: "success" | "failure" | "canceled" | "timeout";
  exitCode?: number | null;
  durationMs?: number;
  sessionId?: string;
  usage?: unknown;
  error?: string;
  finalText?: string;
  memory?: ReportedMemory;
  notices?: string[];
}

/** The MEMORY.md a run left behind and the SHA-256 hash of the memory it started from. */
export interface ReportedMemory {
  baseHash: string;
  text: string;
}

export const MACHINE_REPORT_FIELDS = [
  "reportId", "runId", "result", "exitCode", "durationMs",
  "sessionId", "usage", "error", "finalText", "memory", "notices",
] as const;
const REPORT_MEMORY_FIELDS = "baseHash,text";
const MEMORY_HASH_RE = /^[0-9a-f]{64}$/;
const MACHINE_REPORT_FIELD_SET = new Set<string>(MACHINE_REPORT_FIELDS);
const MACHINE_REPORT_USAGE_FIELDS = new Set<string>([
  "inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens",
]);
/** How long an idle poll is held open for work before returning empty.
 *  Bounded under the daemon's 30s fetch timeout AND under ONLINE_TTL_MS
 *  (with the end-of-wait re-stamp) so a parked long-poll never looks offline. */
const LONG_POLL_WAIT_MS = 20_000;
export const LOG_RUNS_DEFAULT = 8;
const USAGE_MAX = 1e12;
const REPORT_ID_CAP = 200;

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
    : issues.some((issue) => issue.includes("runId does not match")) ? "daemon" : "protocol";
  const reason = code === "REPORT_CONFLICT"
    ? "Terminal report rejected because its reportId was already committed for another run."
    : `Terminal report rejected: ${issues.join("; ")}.`;
  const recommendedAction = faultDomain === "internal"
    ? "Inspect pievo show and pievo log; retry only after confirming the daemon and server agree on the active run."
    : "Upgrade Pievo to the latest version and restart the daemon, then inspect pievo show and pievo log.";
  return { at: nowIso(), code, reason, issues, reportId, payloadDigest, faultDomain, recommendedAction };
}

const MISSING_STATUS_ERROR = 'run protocol incomplete: the final response has no "STATUS: ok|block" line';

/** The run outcome a terminal report establishes. Only a successful provider
 * exit is read for a status; a successful exit without one is a protocol error. */
function reportOutcome(body: MachineReportBody): {
  ok: boolean;
  canceled: boolean;
  patch: Partial<Pick<NewRun, "status" | "message" | "attention" | "error">>;
} {
  const canceled = body.result === "canceled";
  if (canceled) return { ok: false, canceled, patch: { error: "stopped by user" } };
  if (body.result !== "success") {
    return { ok: false, canceled, patch: { error: typeof body.error === "string" ? clipText(body.error, MESSAGE_CAP) : "run failed on machine" } };
  }
  const parsed = parseFinalStatus(body.finalText);
  if (!parsed) return { ok: false, canceled, patch: { error: MISSING_STATUS_ERROR } };
  return { ok: true, canceled, patch: { status: parsed.status, message: clipText(parsed.message, MESSAGE_CAP) || null, attention: parsed.status === "ok" ? parsed.attention : null, error: null } };
}

function validateTerminalReport(body: MachineReportBody): string[] {
  const issues: string[] = [];
  const has = (key: keyof MachineReportBody): boolean => Object.prototype.hasOwnProperty.call(body, key);
  const unknown = Object.keys(body).filter((key) => !MACHINE_REPORT_FIELD_SET.has(key)).sort();
  if (unknown.length) issues.push(`unknown fields: ${unknown.join(", ")}`);
  if (!["success", "failure", "canceled", "timeout"].includes(body.result as string)) {
    issues.push("result must be success, failure, canceled, or timeout");
  }
  if (has("durationMs") && (typeof body.durationMs !== "number" || !Number.isInteger(body.durationMs) || body.durationMs < 0 || body.durationMs > 2_147_483_647)) {
    issues.push("durationMs must be a non-negative 32-bit integer");
  }
  if (has("exitCode") && body.exitCode !== null && (typeof body.exitCode !== "number" || !Number.isInteger(body.exitCode) || body.exitCode < 0 || body.exitCode > 2_147_483_647)) {
    issues.push("exitCode must be a non-negative 32-bit integer or null");
  }
  for (const key of ["sessionId", "error", "finalText"] as const) {
    if (has(key) && typeof body[key] !== "string") issues.push(`${key} must be a string`);
  }
  if (has("memory")) {
    const memory = body.memory as unknown as Record<string, unknown> | null;
    // Over-cap text is a daemon contract break (it checks the cap first); the
    // 4-bytes-per-character bound only rejects absurd payloads here.
    const valid = memory !== null && typeof memory === "object" && !Array.isArray(memory)
      && Object.keys(memory).sort().join(",") === REPORT_MEMORY_FIELDS
      && typeof memory.baseHash === "string" && MEMORY_HASH_RE.test(memory.baseHash)
      && typeof memory.text === "string" && memory.text.length <= MEMORY_CHAR_CAP * 4;
    if (!valid) issues.push("memory must be exactly {baseHash, text} with a lowercase SHA-256 baseHash");
  }
  if (has("notices")) {
    const notices = body.notices as unknown;
    if (!Array.isArray(notices) || notices.length > REPORT_NOTICES_MAX || notices.some((notice) => typeof notice !== "string" || notice.length > NOTICE_CAP)) {
      issues.push(`notices must be an array of at most ${REPORT_NOTICES_MAX} strings of at most ${NOTICE_CAP} characters`);
    }
  }
  if (has("usage")) {
    if (body.usage === null || typeof body.usage !== "object" || Array.isArray(body.usage)) {
      issues.push("usage must be an object");
    } else {
      const usage = body.usage as Record<string, unknown>;
      const unknownUsage = Object.keys(usage).filter((key) => !MACHINE_REPORT_USAGE_FIELDS.has(key)).sort();
      if (unknownUsage.length) issues.push(`unknown usage fields: ${unknownUsage.join(", ")}`);
      for (const key of MACHINE_REPORT_USAGE_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(usage, key)) continue;
        const value = usage[key];
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > USAGE_MAX) {
          issues.push(`usage.${key} must be a non-negative integer no greater than ${USAGE_MAX}`);
        }
      }
    }
  }
  return issues;
}

function coerceTelemetry(body: MachineReportBody): Partial<Pick<NewRun, "durationMs" | "exitCode" | "sessionId" | "finalText" | "usage">> {
  const whole = (v: unknown, max: number): number | undefined =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max ? v : undefined;
  const usageRaw = body.usage && typeof body.usage === "object" && !Array.isArray(body.usage) ? body.usage as Record<string, unknown> : {};
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

export class MachineGateway {
  constructor(readonly scheduler: Scheduler) {}

  private applyAutopauseTimer(loopId: string, terminal: { failureStreak: number; autoPaused: boolean }): void {
    if (!terminal.autoPaused) return;
    this.scheduler.removeLoop(loopId);
    log.warn({ loopId, streak: terminal.failureStreak }, "loop auto-paused after block or consecutive errors");
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

  private wakeMachine(machineId: string): void {
    this.pollWaiters.get(machineId)?.(true);
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
   * an OFFLINE machine is NOT failed — it remains in the durable queue, bounded
   * by DEFERRED_MAX_MS while offline.
   * Online pending rows never synthesize an execution error.
   */
  async sweep(): Promise<void> {
    const now = Date.now();
    for (const m of await store.listMachines()) {
      if (m.online && (!m.lastSeen || now - Date.parse(m.lastSeen) > ONLINE_TTL_MS)) {
        await store.updateMachine(m.id, { online: false });
      }
    }
    for (const run of await store.openRuns()) {
      const pendingLifetime = now - Date.parse(run.createdAt);
      if (run.phase === "pending") {
        const machine = await store.getMachine(run.machineId);
        if (machine?.online) {
          // Pending is the durable inbox. An online daemon may be busy, rolling
          // versions, or retrying another report; only a claimed run has a
          // heartbeat contract. Never turn queued work into a synthetic error.
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
          // Keep the durable pending row for the daemon's next poll. Later system
          // triggers coalesce into the same loop-scoped queue slot.
        }
      } else if (run.phase === "running") {
        // INACTIVITY-based timeout. `heartbeatAt` is refreshed only when the daemon
        // explicitly lists this run in `currentRuns`; claim time is the fallback
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

  /** Reclaim one silent running run as an error, but terminalize its lease instead
   *  of retiring it. The usual cause is a laptop that fell asleep mid-run; on wake
   *  the daemon delivers the real (often successful) result, and a retired lease
   *  would 401 it and leave a false failure. During TERMINAL_GRACE_MS exactly one
   *  late report may reconcile the run (see `report()`); CLI mutations stay refused.
   *  Pending rows are durable queue entries and never reach this path. */
  private async reclaimRun(run: Run, reason: string): Promise<void> {
    if (run.phase !== "running") return;
    const at = nowIso();
    const reclaimed = await store.reclaimRun(run.id, "running", reason, at, TERMINAL_GRACE_MS);
    // A claim/report/cancel won after sweep read openRuns(). The phase guard is
    // the side-effect gate: never mutate stale work.
    if (!reclaimed) return;
    // A running timeout remains provisional during terminal grace: a late
    // success can correct it. Alert normally, but do not permanently trip the
    // breaker on that provisional third failure.
    this.applyAutopauseTimer(run.loopId, reclaimed);
    if (reclaimed.loop.enabled) this.scheduler.addLoop(reclaimed.loop);
    else this.scheduler.removeLoop(reclaimed.loop.id);
  }

  private async pollCore(
    deviceToken: string,
    info?: { host?: string; platform?: string; arch?: string; version?: string },
    currentRunIds?: string[],
    claimWork = true,
    recoveryComplete = false,
  ): Promise<HttpResult> {
    const auth = await authenticateDeviceToken(deviceToken, { allowUnknown: true });
    if (!auth.ok) return auth.response;
    const { machineId } = auth;
    let machine = auth.machine;
    if (!machine) {
      // First contact requires a live connect-key binding. Machine deletion
      // revokes it, so a still-running daemon cannot recreate a deleted machine.
      if (!(await connectKeyValid(deviceToken))) {
        return { status: 401, body: { error: "unknown device token — connect this machine first" } };
      }
      machine = await store.createMachine({
        id: machineId,
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
      const version = typeof info.version === "string" && info.version.length <= POLL_VERSION_CAP && isValidSemver(info.version)
        ? info.version
        : undefined;
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
    if (Array.isArray(currentRunIds)) {
      const ids = new Set<string>();
      for (const value of currentRunIds) {
        if (typeof value === "string") ids.add(value);
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

    // A completed daemon recovery snapshot separates execution exclusion from
    // late-report retention. Anything absent can no longer execute locally, so
    // it keeps report-only authority but stops fencing queued work.
    if (recoveryComplete) await store.releaseAbsentReconciliations(machineId, currentRunIds ?? []);

    let delivery: Delivery | null = null;
    if (claimWork) {
      // Each poll adds at most one run. Repeated active polls have no configured
      // concurrency ceiling, while a transport failure can strand only one claim.
      await this.scheduler.advanceDueSchedules(machineId);
      const claimed = await store.claimReadyRunForMachine(machineId, undefined, currentRunIds ?? []);
      if (claimed) delivery = await buildDelivery(claimed.loop, claimed.run, claimed.runToken, claimed.contextToken, machine.roots ?? []);
    }

    if (delivery) log.info({ machineId, runId: delivery.runId }, "poll: delivered");
    return { status: 200, body: { delivery } };
  }

  async pollV4(deviceToken: string, request: PollV4Request): Promise<HttpResult> {
    const rawRequest = request as unknown as Record<string, unknown>;
    if (request === null || typeof request !== "object" || Array.isArray(request)
      || Object.keys(rawRequest).some((key) => !POLL_V4_REQUEST_FIELDS.has(key))
      || !validPollInfo(rawRequest?.info)
      || (rawRequest.protocolVersion !== undefined && (typeof rawRequest.protocolVersion !== "number" || !Number.isInteger(rawRequest.protocolVersion)))
      || (rawRequest.currentRuns !== undefined && (!Array.isArray(rawRequest.currentRuns) || rawRequest.currentRuns.some((run) => !validPollCurrentRun(run))))
      || (rawRequest.daemonInstanceId !== undefined && !validPollWireId(rawRequest.daemonInstanceId))
      || (rawRequest.recoveryComplete !== undefined && typeof rawRequest.recoveryComplete !== "boolean")) {
      return { status: 400, body: { error: "invalid poll request", code: "VALIDATION_ERROR" } };
    }
    if (request.protocolVersion !== DAEMON_PROTOCOL_VERSION) {
      const auth = await authenticateDeviceToken(deviceToken, { allowUnknown: true });
      if (!auth.ok && auth.reason === "mismatch") return auth.response;
      if (auth.ok && auth.machine) {
        const reported = typeof request.protocolVersion === "number" && Number.isInteger(request.protocolVersion)
          ? request.protocolVersion
          : null;
        await store.updateMachine(auth.machineId, { daemonProtocol: reported });
      }
      return { status: 426, body: { error: "daemon upgrade required; run `npm install -g @kky42/pievo@latest`, then `pievo daemon restart`", code: "UPGRADE_REQUIRED", requiredProtocol: DAEMON_PROTOCOL_VERSION } };
    }
    if (!Array.isArray(request.currentRuns) || request.currentRuns.some((run) => !validPollCurrentRun(run))) {
      return { status: 400, body: { error: "invalid currentRuns", code: "VALIDATION_ERROR" } };
    }
    if (request.recoveryComplete !== true) {
      return { status: 400, body: { error: "recoveryComplete must be true", code: "VALIDATION_ERROR" } };
    }
    if (!validPollWireId(request.daemonInstanceId)) {
      return { status: 400, body: { error: "a valid daemonInstanceId is required", code: "VALIDATION_ERROR" } };
    }
    const currentIds = [...new Set(request.currentRuns.map((run) => run.runId))];
    const priorAuth = await authenticateDeviceToken(deviceToken, { allowUnknown: true });
    const machineId = priorAuth.ok ? priorAuth.machineId : "";
    // The dispatch gate must inspect the exact wire value. Never sanitize an
    // invalid version into a valid one.
    const reportedVersion = typeof request.info?.version === "string" ? request.info.version : undefined;
    const needsUpdate = daemonNeedsUpdate(reportedVersion);
    const base = await this.pollCore(deviceToken, request.info, currentIds, !needsUpdate, true);
    if (base.status !== 200) return base;
    const machine = await store.getMachine(machineId);
    if (machine?.daemonProtocol !== DAEMON_PROTOCOL_VERSION) await store.updateMachine(machineId, { daemonProtocol: DAEMON_PROTOCOL_VERSION });
    const running = await store.runningRunsForMachine(machineId);
    const currentSet = new Set(currentIds);
    const body = base.body as { delivery: Delivery | null };
    return {
      status: 200,
      body: {
        delivery: body.delivery,
        cancelRunIds: running.filter((run) => currentSet.has(run.id) && run.cancelRequestedAt).map((run) => run.id),
        ...(needsUpdate ? { needsUpdate: { current: reportedVersion ?? null, required: MIN_DAEMON_VERSION, command: daemonUpgradeCommand() } } : {}),
      },
    };
  }

  async pollV4Wait(deviceToken: string, request: Parameters<MachineGateway["pollV4"]>[1], waitMs = LONG_POLL_WAIT_MS): Promise<HttpResult> {
    if (request.currentRuns?.length || request.protocolVersion !== DAEMON_PROTOCOL_VERSION) return this.pollV4(deviceToken, request);
    const auth = await authenticateDeviceToken(deviceToken, { allowUnknown: true });
    if (!auth.ok) return auth.response;
    const machineId = auth.machineId;
    const waiter = this.armPollWaiter(machineId, Math.min(Math.max(waitMs, 0), LONG_POLL_WAIT_MS));
    try {
      const first = await this.pollV4(deviceToken, request);
      if (first.status !== 200) return first;
      if ((first.body as { delivery?: Delivery | null }).delivery) return first;
      const woken = await waiter.promise;
      if (!woken) {
        await store.setMachineOnline(machineId, true);
        return first;
      }
      return this.pollV4(deviceToken, request);
    } finally {
      waiter.cancel();
    }
  }

  /** Whether this machine has a live daemon. `online` is fresh-checked against the
   *  poll TTL, not just the stored flag. */
  async status(deviceToken: string): Promise<HttpResult> {
    const auth = await authenticateDeviceToken(deviceToken, { allowUnknown: true });
    if (!auth.ok) return auth.response;
    const { machineId, machine } = auth;
    // Unknown or deleted identity: keep the response enumeration-safe while
    // telling the local CLI that its saved identity must be replaced explicitly.
    if (!machine) {
      const claimValid = await connectKeyValid(deviceToken);
      return { status: 200, body: { registered: false, claimValid, online: false, name: null, lastSeen: null, daemonProtocol: null } };
    }
    const fresh = !!machine.lastSeen && Date.now() - Date.parse(machine.lastSeen) < ONLINE_TTL_MS;
    const online = !!machine.online && fresh;
    const running = await store.runningRunsForMachine(machineId);
    const currentRuns = running.map((run) => ({ runId: run.id, stage: "executing" as const, cancelPending: run.cancelRequestedAt != null }));
    return {
      status: 200,
      body: {
        registered: true,
        online,
        name: machine.name || null,
        lastSeen: machine.lastSeen ?? null,
        daemonProtocol: machine.daemonProtocol ?? null,
        currentRuns: online ? currentRuns : [],
      },
    };
  }

  async createLoop(
    deviceToken: string,
    body: {
      name?: unknown;
      tags?: unknown;
      schedule?: unknown;
      prompt?: unknown;
      enabled?: unknown;
      model?: unknown;
      reasoningEffort?: unknown;
      workdir?: unknown;
      agent?: unknown;
      /** Validate-only (`pievo new --dry-run`): run every check, persist NOTHING,
       *  and return the normalized config + fire preview. Zero-exec preserved. */
      dryRun?: unknown;
      /** Required content-hash idempotency key the daemon derives (sha256 over
       * machine id + canonical transport/config envelope). */
      idempotencyKey?: unknown;
    },
  ): Promise<HttpResult> {
    const auth = await authenticateDeviceToken(deviceToken);
    if (!auth.ok) return auth.response;
    const { machineId } = auth;

    // Envelope fields are transport concerns; loopConfig.ts validates every
    // configuration field together. Unknown config keys fail loudly.
    {
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        return { status: 400, body: { error: "create body must be an object" } };
      }
      const rawBody = body as Record<string, unknown>;
      const { dryRun, idempotencyKey, ...rawConfig } = rawBody;
      if (dryRun !== undefined && typeof dryRun !== "boolean") {
        return { status: 400, body: { error: "dryRun must be boolean when provided" } };
      }
      if (typeof idempotencyKey !== "string" || !/^[0-9a-f]{64}$/.test(idempotencyKey)) {
        return { status: 400, body: { error: "idempotencyKey is required and must be exactly 64 lowercase hex characters" } };
      }

      const validated = validateLoopCreate(rawConfig);
      if (!validated.ok) return { status: 400, body: { error: validated.detail } };
      const { config, row } = validated.value;
      if (dryRun === true) {
        return { status: 200, body: { ok: true, dryRun: true, config, text: JSON.stringify(config, null, 2) } };
      }
      const existingId = readNewIdempotency(idempotencyKey, machineId);
      const existing = existingId ? await store.getLoop(existingId) : undefined;
      if (existing?.machineId === machineId) {
        return { status: 200, body: { ok: true, id: existing.id, name: existing.name, idempotent: true, text: `loop: ${existing.name}\nid: ${existing.id}\nreplayed: true` } };
      }
      const loop = await store.createLoop({
        machineId,
        ...row,
      });
      this.scheduler.addLoop(loop);
      recordNewIdempotency(idempotencyKey, machineId, loop.id);
      log.info({ machineId, loopId: loop.id, agent: loop.agent }, "createLoop: canonical prompt runner created");
      return { status: 200, body: { ok: true, id: loop.id, name: loop.name, text: `loop: ${loop.name}\nid: ${loop.id}` } };
    }

  }

  async listLoops(deviceToken: string, fieldsFlag?: string, json?: boolean): Promise<HttpResult> {
    const auth = await authenticateDeviceToken(deviceToken);
    if (!auth.ok) return auth.response;
    const { machineId } = auth;

    const extras: string[] = [];
    if (fieldsFlag !== undefined) {
      const requested = String(fieldsFlag).split(",").map((s) => s.trim()).filter(Boolean);
      const unknown = requested.filter((f) => !LIST_OPTIONAL_FIELDS.includes(f));
      if (unknown.length) {
        return { status: 400, body: { error: `unknown field(s): ${unknown.join(", ")} — available: ${LIST_OPTIONAL_FIELDS.join(", ")}` } };
      }
      for (const f of requested) if (!extras.includes(f)) extras.push(f);
    }
    const fields = [...LIST_DEFAULT_FIELDS, ...extras];
    // Derived cells cost an extra query per loop, so compute them only when their
    // TOON columns are selected. JSON uses the canonical show/edit envelope.
    const wantRuns = fields.includes("runs");
    const wantLastResult = fields.includes("lastResult");
    const loopRows = await store.loopsForMachine(machineId);

    const loops: LoopListRecord[] = await Promise.all(
      loopRows.map(async (l) => {
        const schedule = scheduleFromLoop(l);
        const nextFire = l.enabled && schedule.mode === "cron" ? (nextFires(schedule.cron, schedule.timezone, 1)[0] ?? null) : null;
        const last = wantLastResult ? await store.lastRun(l.id) : undefined;
        return {
          id: l.id,
          name: l.name,
          schedule,
          enabled: l.enabled,
          model: l.model ?? null,
          reasoningEffort: l.reasoningEffort ?? null,
          // Folder hint lets a workdir-scoped owner CLI map cwd to a loop.
          workdir: l.workdir,
          nextFire,
          runs: wantRuns ? await store.countRuns(l.id) : 0,
          lastResult: last ? runResultToken(last) : null,
        };
      }),
    );
    // `--json` escape hatch: emit the full records as real JSON in `text` (the daemon
    // prints it verbatim), the exact counterpart to `show --json`. TOON is the default.
    const envelopes = loopRows.map(canonicalLoopEnvelope);
    const text = json ? JSON.stringify(envelopes, null, 2) : renderLoopsText(loops, fields);
    // `loops` is a retained data channel: the daemon resolves cwd→loop client-side
    // for `log`/`show`/`home`. `ok` is render-only and stripped at the CLI boundary.
    return { status: 200, body: { ok: true, loops: envelopes, text } };
  }

  async editLoop(
    deviceToken: string,
    id: unknown,
    patch: {
      name?: unknown;
      tags?: unknown;
      schedule?: unknown;
      prompt?: unknown;
      workdir?: unknown;
      model?: unknown;
      reasoningEffort?: unknown;
      enabled?: unknown;
      agent?: unknown;
    },
    /** Validate-only (`pievo edit --dry-run`): compute the per-key before→after
     *  preview + rejections, persist NOTHING. */
    dryRun = false,
  ): Promise<HttpResult> {
    const auth = await authenticateDeviceToken(deviceToken);
    if (!auth.ok) return auth.response;
    const { machineId } = auth;
    if (typeof id !== "string" || !id) return { status: 400, body: { error: "loop id required" } };
    const loop = await store.getLoop(id);
    if (!loop || loop.machineId !== machineId) return { status: 404, body: { error: "no such loop on this machine" } };

    {
      const validated = validateLoopEdit(loop, patch);
      if (!validated.ok) return { status: 400, body: { error: validated.detail } };
      const update = validated.value;
      const applied = Object.keys(patch ?? {});
      if (dryRun) {
        const before = canonicalLoopEnvelope(loop);
        const after = canonicalLoopEnvelope({ ...loop, ...update } as Loop);
        const { id: _readOnlyId, ...config } = after;
        const preview = { id: loop.id, applied, before, after };
        return { status: 200, body: { ok: true, dryRun: true, ...preview, config, text: JSON.stringify(preview, null, 2) } };
      }
      if (Object.keys(update).length === 0) {
        return { status: 200, body: { ok: true, id: loop.id, name: loop.name, applied: [], nothingToChange: true, text: `loop: ${loop.name}\nid: ${loop.id}\napplied[0]:` } };
      }
      const updated = await store.updateLoop(loop.id, update);
      if (!updated) return { status: 404, body: { error: "loop not found" } };
      if (updated.enabled) this.scheduler.addLoop(updated);
      else this.scheduler.removeLoop(updated.id);
      return { status: 200, body: { ok: true, id: updated.id, name: updated.name, applied, text: `loop: ${updated.name}\nid: ${updated.id}\napplied: ${applied.join(",")}` } };
    }

  }

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

  private async reportRaceResponse(
    runToken: string,
    lease: RunLease,
    body: MachineReportBody,
    payloadDigest: string,
  ): Promise<HttpResult | undefined> {
    const raced = await committedReportEvidence(body.reportId!, payloadDigest, lease.runId);
    if (raced.response) return raced.response;
    if (raced.foreignRun) {
      return this.rejectTerminalAttempt(runToken, lease, body, payloadDigest, "REPORT_CONFLICT", ["reportId was already committed for another run"]);
    }
    return undefined;
  }

  private async resolveLostTerminalRace(
    runToken: string,
    lease: RunLease,
    body: MachineReportBody,
    payloadDigest: string,
    retryReconcile: boolean,
    logMessage: string,
  ): Promise<HttpResult> {
    const raced = await this.reportRaceResponse(runToken, lease, body, payloadDigest);
    if (raced) return raced;
    const fresh = await store.getRun(lease.runId);
    if (fresh?.phase === "canceled") return this.ignoreCanceledReport(runToken, lease, body);
    if (fresh?.phase === "done") return { status: 409, body: { error: "run already finalized", code: "REPORT_NOT_FINALIZED", reportId: body.reportId } };
    const refreshedLease = await resolveLease(runToken);
    if (refreshedLease?.state === "retired") return this.retiredReport(runToken, body, lease.runId);
    if (retryReconcile && fresh?.phase === "error" && refreshedLease?.state === "terminal-grace") {
      return this.reconcileReclaimedReport(runToken, refreshedLease, fresh, body);
    }
    log.info({ runId: lease.runId, phase: fresh?.phase }, logMessage);
    return { status: 409, body: { error: "terminal report was not finalized", code: "REPORT_NOT_FINALIZED", reportId: body.reportId } };
  }

  /** The run's memory and notices to apply. A canceled or timed-out run was
   * killed mid-edit, so its memory is not applied (the daemon also withholds it). */
  private terminalMemory(body: MachineReportBody): { update?: store.MemoryUpdate; notices: string[] } {
    const notices = (body.notices ?? []).map((notice) => clipText(notice, NOTICE_CAP));
    if (!body.memory || body.result === "canceled" || body.result === "timeout") return { notices };
    const issue = memoryIssue(body.memory.text);
    if (issue) return { notices: [...notices, `${issue}; the previous version was kept`] };
    return { update: body.memory, notices };
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
    const { ok, canceled, patch } = reportOutcome(body);
    const memory = this.terminalMemory(body);
    const loopPatch: Partial<NewLoop> = {};
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
        ...coerceTelemetry(body),
        ...patch,
        notices: memory.notices,
        ts: nowIso(),
      },
        loopPatch,
        AUTOPAUSE_STREAK,
        receipt,
        memory.update,
      );
    } catch (error) {
      const raced = await this.reportRaceResponse(runToken, lease, body, payloadDigest);
      if (raced) return raced;
      throw error;
    }
    if (!reconciled) {
      // Another terminal actor consumed the lease/phase. Handle the observed
      // winner once, without recursive report() retries.
      return this.resolveLostTerminalRace(runToken, lease, body, payloadDigest, false, "report: late reconcile lost terminal race");
    }

    const deleting = reconciled.loop.deleteRequestedAt != null;
    const reportOnly = reconciled.reportOnly === true;
    if (!reportOnly) this.scheduler.addLoop(reconciled.loop);
    if (!reportOnly) this.applyAutopauseTimer(lease.loopId, reconciled);
    if (deleting) await store.tryDeleteLoop(lease.loopId);
    log.info(
      { runId: lease.runId, ok, reclaimed: true },
      canceled
        ? "report: reconciled a reclaimed run to canceled"
        : ok
          ? "report: reconciled a reclaimed run to done (machine woke)"
          : "report: recorded a reclaimed run's real error",
    );
    return { status: 200, body: { ok: true, reportId: body.reportId! } };
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
    const telemetryOnly = lease.state !== "active" && (run?.phase === "done" || run?.phase === "error" || run?.phase === "canceled");
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
      if (rejected.state === "run-error") this.applyAutopauseTimer(lease.loopId, rejected);
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

    const run = await store.getRun(lease.runId);
    if (run?.phase === "canceled") return this.ignoreCanceledReport(runToken, lease, body);
    if (run?.phase === "done") return { status: 409, body: { error: "run already finalized", code: "REPORT_NOT_FINALIZED", reportId } };
    if (run?.phase === "error" && (lease.state === "terminal-grace" || lease.state === "reconciliation-only")) {
      return this.reconcileReclaimedReport(runToken, lease, run, body);
    }

    const { ok: effectiveOk, canceled, patch } = reportOutcome(body);
    const memory = this.terminalMemory(body);

    // Held until the running→terminal CAS wins. Cancel/reclaim/report losers can
    // never reach loop-level writes.
    const loopPatch: Partial<NewLoop> = {};

    let terminal: Awaited<ReturnType<typeof store.finalizeRunningRun>>;
    try {
      terminal = await store.finalizeRunningRun(
        lease.loopId,
        lease.runId,
        {
        phase: canceled ? "canceled" : effectiveOk ? "done" : "error",
        ...coerceTelemetry(body),
        ...patch,
        notices: memory.notices,
        ts: nowIso(),
      },
        loopPatch,
        sha256(runToken),
        AUTOPAUSE_STREAK,
        expected,
        memory.update,
      );
    } catch (error) {
      // A different loop may win the reportId unique race while this transaction
      // waits. Its insert rolls this finalization back; convert the collision to a
      // replay/conflict only after observing the durable winning receipt.
      const raced = await this.reportRaceResponse(runToken, lease, body, payloadDigest);
      if (raced) return raced;
      throw error;
    }
    if (!terminal) {
      // A concurrent report may have passed the pre-lock receipt read. Re-read
      // after the loop-lock winner commits before handling the losing path.
      return this.resolveLostTerminalRace(runToken, lease, body, payloadDigest, true, "report: lost terminal race");
    }
    // A delete-requested loop needs only the atomic receipt/finalization; deletion
    // follows in a second transaction and maintenance can repair a crash gap.
    const deleting = terminal.loop.deleteRequestedAt != null;

    // Terminal cadence was committed with the run transition. This only
    // refreshes the best-effort timer.
    this.scheduler.addLoop(terminal.loop);

    // The terminal transaction owns block/error auto-pause; this only refreshes
    // or removes the latency hint.
    this.applyAutopauseTimer(lease.loopId, terminal);
    log.info({ runId: lease.runId, ok: effectiveOk }, "report: finalized");
    if (deleting) await store.tryDeleteLoop(lease.loopId);
    return { status: 200, body: { ok: true, reportId } };
  }

}

export interface Applied {
  ok: boolean;
  detail?: string;
  code?: string;
  status?: number;
}

// Pure, clock-free TOON renderers shared by CLI verbs. CLI-only renders live with
// their verbs in `cli.ts`, whose `finalizeCli` strips non-transport fields.

/** Compact a stored ISO timestamp to `YYYY-MM-DD HH:MM` (UTC, as stored) for a TOON
 *  cell — a date the agent reads at a glance without the `T`/seconds/zone noise. */
export function fmtTime(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

/** Format an instant in a loop's OWN timezone with a short zone name
 *  (`2026-07-08 05:00 GMT+8`), so cadence previews read in the schedule the owner set
 *  rather than raw UTC. `seconds` optionally adds `:SS`. Falls back to the bare
 *  `fmtTime` slice only if the stored timezone is invalid. */
export function fmtTimeZoned(iso: string, timezone: string, opts: { seconds?: boolean } = {}): string {
  if (!timezone) throw new Error("invariant: cron schedule has no timezone");
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
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

const LIST_DEFAULT_FIELDS: string[] = ["id", "name", "cron", "enabled", "nextFire"];
const LIST_OPTIONAL_FIELDS: string[] = ["timezone", "model", "reasoningEffort", "runs", "lastResult"];

/** A loop's row for `pievo loops`: every renderable cell precomputed once (so the
 *  `--fields` selection is a pure column pick). The structured `loops` body carries the
 *  whole record — a RETAINED data channel the daemon reads to resolve cwd→loop
 *  client-side (id/name/workdir), not for rendering. */
interface LoopListRecord {
  id: string;
  name: string;
  schedule: ReturnType<typeof scheduleFromLoop>;
  enabled: boolean;
  model: string | null;
  reasoningEffort: string | null;
  workdir: string | null;
  nextFire: string | null;
  runs: number;
  lastResult: string | null;
}

function loopCell(rec: LoopListRecord, field: string): Scalar {
  switch (field) {
    case "id": return rec.id;
    case "name": return rec.name;
    case "cron": return rec.schedule.mode === "continuous" ? `continuous +${rec.schedule.delayMinutes}m` : rec.schedule.cron;
    case "enabled": return rec.enabled ? "on" : "paused";
    case "nextFire": return rec.nextFire ? fmtTime(rec.nextFire) : null;
    case "timezone": return rec.schedule.mode === "cron" ? rec.schedule.timezone : null;
    case "model": return rec.model;
    case "reasoningEffort": return rec.reasoningEffort;
    case "runs": return rec.runs;
    case "lastResult": return rec.lastResult;
    default: return null;
  }
}

function renderLoopsText(loops: LoopListRecord[], fields: string[]): string {
  if (!loops.length) {
    return doc(
      countLine(0),
      emptyList("loops"),
      helpBlock([
        "Run `pievo new --json '{...}'` to create your first loop",
        "Run `pievo daemon connect` if this machine isn't connected yet",
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

export function runResultToken(r: { phase: string; status: string | null }): string {
  if (r.phase === "error") return "failed";
  return r.status ?? r.phase;
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

/** The next N fire times of a cron, probed IN the loop's timezone (fire times shift
 *  with it — matching how the scheduler arms the loop), as ISO strings. Empty when
 *  the expression is invalid (the caller has already run validCadence). Powers the
 *  `--dry-run` fire preview. */
export function nextFires(cron: string, timezone: string, n: number): string[] {
  if (!timezone) throw new Error("invariant: cron schedule has no timezone");
  try {
    const c = new Cron(cron, { paused: true, timezone });
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

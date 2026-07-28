/**
 * Data-access layer over Drizzle — replaces c0's file-per-loop store. The API is
 * function-style; persistence is relational (loops and runs are separate tables,
 * and `owner: PeerRef` is gone → `userId` + `machineId`).
 *
 * Under Postgres (postgres-js / pglite) the drizzle session is ASYNC, so every
 * DB-touching function returns a Promise. The 5 pure, DB-free helpers stay sync.
 * Using Drizzle (not raw SQL) keeps the dialect swap a swap, not a rewrite.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Cron } from "croner";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, notInArray, or, sql } from "drizzle-orm";

import { db } from "./index.js";
import { user } from "./auth-schema.js";
import {
  loops,
  machines,
  runs,
  teams,
  teamMembers,
  teamInvites,
  blobs,
  artifactFiles,
  runSnapshots,
  runLeases,
  runReportReceipts,
  terminalReportIncidents,
  connectKeys,
  type ArtifactFile,
  type Loop,
  type Machine,
  type NewLoop,
  type NewMachine,
  type NewRun,
  type Run,
  type RunRequester,
  type RunSnapshot,
  type SnapshotManifest,
  type Team,
  type TeamMember,
  type TeamInvite,
} from "./schema.js";
import type { ReportIncident, ReportIncidentDisposition } from "../types.js";

export function newLoopId(): string {
  return `loop-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** First cron occurrence strictly after `after`, interpreted in the loop's zone. */
export function nextCronAt(cron: string, timezone: string | null, after: string): string {
  if (!timezone) throw new Error("invariant: cron schedule has no timezone");
  const probe = new Cron(cron, { paused: true, timezone });
  try {
    const next = probe.nextRun(new Date(after));
    if (!next) throw new Error(`cron expression never fires again: ${cron}`);
    return next.toISOString();
  } finally {
    probe.stop();
  }
}

function runTimes(at = nowIso()): Pick<NewRun, "ts" | "createdAt" | "updatedAt"> {
  return { ts: at, createdAt: at, updatedAt: at };
}

// ---- loops ----

export async function listLoops(teamId?: string): Promise<Loop[]> {
  const q = db.select().from(loops);
  return teamId ? await q.where(eq(loops.teamId, teamId)) : await q;
}

/** Count a team's loops without materializing their (large) rows — the
 *  delete-block guard + settings-detail badge only need the tally. */
export async function countLoopsForTeam(teamId: string): Promise<number> {
  const r = (await db.select({ n: sql<number>`count(*)` }).from(loops).where(eq(loops.teamId, teamId)))[0];
  return Number(r?.n ?? 0);
}

export async function getLoop(id: string): Promise<Loop | undefined> {
  return (await db.select().from(loops).where(eq(loops.id, id)))[0];
}

/** Loops bound to a machine — used by machine cascade authorization and UI counts. */
export async function loopsForMachine(machineId: string): Promise<Loop[]> {
  return db.select().from(loops).where(eq(loops.machineId, machineId));
}

type InternalScheduleColumns = Pick<
  NewLoop,
  "cron" | "scheduleMode" | "cronOverlap" | "continuousDelayMinutes" | "timezone"
>;

/** Persistence accepts only a fully materialized internal schedule. Owner-facing
 * callers must pass through loopConfig.ts; a lone raw cron is not a write API. */
export type CreateLoopInput = Omit<
  NewLoop,
  "id" | "createdAt" | "updatedAt" | "nextCadenceAt" | keyof InternalScheduleColumns
> & Required<InternalScheduleColumns> & { id?: string };

export async function createLoop(input: CreateLoopInput): Promise<Loop> {
  const ts = nowIso();
  const enabled = input.enabled ?? true;
  if (input.scheduleMode === "cron" && !input.timezone) {
    throw new Error("invariant: cron loop creation requires a timezone");
  }
  if (input.scheduleMode === "continuous" && input.timezone !== null) {
    throw new Error("invariant: continuous loop creation requires a null timezone");
  }
  const nextCadenceAt = !enabled
    ? null
    : input.scheduleMode === "continuous"
      ? ts
      : nextCronAt(input.cron, input.timezone, ts);
  const row: NewLoop = {
    ...input,
    enabled,
    pauseCause: input.pauseCause ?? (!enabled ? { kind: "owner", at: ts } : null),
    nextRunAt: enabled ? (input.nextRunAt ?? null) : null,
    nextCadenceAt,
    id: input.id ?? newLoopId(),
    createdAt: ts,
    updatedAt: ts,
  };
  return db.transaction(async (tx) => {
    // Fence machine deletion: a loop can only commit while its machine exists,
    // and forceDeleteMachine's UPDATE lock waits for this key-share lock.
    const machine = (await tx.select({ id: machines.id }).from(machines)
      .where(eq(machines.id, input.machineId)).for("key share"))[0];
    if (!machine) throw new Error(`machine ${input.machineId} does not exist`);
    return (await tx.insert(loops).values(row).returning())[0]!;
  });
}

type StoreTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Allocate the next 1-based history number. Every caller already holds the
 * owning loop row lock, so the counter and run transition share one commit. */
async function allocateRunIndexTx(tx: StoreTx, loopId: string): Promise<number> {
  const updated = (await tx.update(loops)
    .set({ lastRunIndex: sql`${loops.lastRunIndex} + 1` })
    .where(eq(loops.id, loopId))
    .returning({ runIndex: loops.lastRunIndex }))[0];
  if (!updated) throw new Error(`cannot allocate history index for missing loop ${loopId}`);
  return updated.runIndex;
}

async function ensureRunIndexTx(tx: StoreTx, run: Pick<Run, "loopId" | "runIndex">): Promise<number> {
  return run.runIndex ?? allocateRunIndexTx(tx, run.loopId);
}

async function cancelPendingTx(
  tx: StoreTx,
  where: ReturnType<typeof and>,
  message: string,
  at: string,
): Promise<void> {
  const pending = await tx.select({ id: runs.id, loopId: runs.loopId, runIndex: runs.runIndex })
    .from(runs).where(where).orderBy(asc(runs.createdAt), asc(runs.id)).for("update");
  for (const run of pending) {
    const runIndex = await ensureRunIndexTx(tx, run);
    await tx.update(runs)
      .set({ phase: "canceled", runIndex, message, ts: at, updatedAt: at })
      .where(and(eq(runs.id, run.id), eq(runs.phase, "pending")));
  }
}

/** Apply one loop patch while its row lock is held. This is shared by owner edits
 * and run-authorized mutations, so cadence semantics cannot drift. */
async function updateLoopTx(tx: StoreTx, current: Loop, patch: Partial<NewLoop>, at: string): Promise<Loop> {
  const extra: Partial<NewLoop> = {};
  if (patch.enabled === true) {
    extra.pauseCause = null;
  } else if (patch.enabled === false && current.enabled && patch.pauseCause === undefined) {
    extra.pauseCause = { kind: "owner", at };
  }

  const effective = { ...current, ...patch, ...extra } as Loop;
  if (current.deleteRequestedAt) extra.enabled = false;
  const pausing = !effective.enabled || current.deleteRequestedAt != null;
  const activating =
    effective.enabled &&
    ((patch.enabled === true && !current.enabled) ||
      (patch.scheduleMode !== undefined && patch.scheduleMode !== current.scheduleMode));

  if (pausing) {
    extra.nextCadenceAt = null;
    extra.nextRunAt = null;
  } else if (activating) {
    if (effective.scheduleMode === "cron") {
      extra.nextCadenceAt = nextCronAt(effective.cron, effective.timezone, at);
    } else {
      const openExec = (
        await tx
          .select({ id: runs.id })
          .from(runs)
          .where(and(eq(runs.loopId, current.id), inArray(runs.phase, ["pending", "running"])))
          .limit(1)
      )[0];
      extra.nextCadenceAt = openExec ? null : at;
    }
  } else if (
    effective.enabled && effective.scheduleMode === "cron" &&
    ((patch.cron !== undefined && patch.cron !== current.cron) ||
      (patch.timezone !== undefined && patch.timezone !== current.timezone))
  ) {
    extra.nextCadenceAt = nextCronAt(effective.cron, effective.timezone, at);
  } else if (
    effective.enabled && effective.scheduleMode === "continuous" &&
    current.nextCadenceAt && Date.parse(current.nextCadenceAt) > Date.parse(at) &&
    patch.continuousDelayMinutes !== undefined && patch.continuousDelayMinutes !== current.continuousDelayMinutes
  ) {
    // A future fact encodes terminalAt + old delay, so it can be retimed without
    // history. A due activation is work already owed and must never be deferred.
    const terminalAt = Date.parse(current.nextCadenceAt) - current.continuousDelayMinutes * 60_000;
    extra.nextCadenceAt = new Date(terminalAt + effective.continuousDelayMinutes * 60_000).toISOString();
  }

  const loop = (
    await tx
      .update(loops)
      .set({ ...patch, ...extra, updatedAt: at })
      .where(eq(loops.id, current.id))
      .returning()
  )[0]!;
  if (patch.enabled === false) {
    await cancelPendingTx(
      tx,
      and(eq(runs.loopId, current.id), eq(runs.phase, "pending"), eq(runs.requestedBy, "system")),
      "canceled - loop paused before this system run was claimed",
      at,
    );
  }
  if (patch.artifacts !== undefined) {
    const allowed = new Set(patch.artifacts ?? []);
    const live = await tx.select({ id: artifactFiles.id, path: artifactFiles.path }).from(artifactFiles)
      .where(and(eq(artifactFiles.loopId, current.id), eq(artifactFiles.deleted, false)));
    const removed = live.filter((file) => !allowed.has(file.path)).map((file) => file.id);
    if (removed.length) {
      await tx.update(artifactFiles)
        .set({ hash: null, deleted: true, updatedAt: at })
        .where(inArray(artifactFiles.id, removed));
    }
  }
  return loop;
}

/** Partial owner/system update under the loop lifecycle lock. */
export async function updateLoop(id: string, patch: Partial<NewLoop>): Promise<Loop | undefined> {
  return db.transaction(async (tx) => {
    const current = (await tx.select().from(loops).where(eq(loops.id, id)).for("update"))[0];
    return current ? updateLoopTx(tx, current, patch, nowIso()) : undefined;
  });
}

/** Delete loop-owned history/content without erasing durable late-report evidence.
 * A retired lease is non-authorizing and never blocks deletion; only the matching
 * report→410 receipt transaction may consume it. */
async function deleteLoopDataTx(tx: StoreTx, id: string): Promise<boolean> {
  const deleted = await tx.delete(loops).where(eq(loops.id, id)).returning({ id: loops.id });
  if (!deleted.length) return false;
  await tx.delete(runs).where(eq(runs.loopId, id));
  await tx.delete(runLeases).where(and(eq(runLeases.loopId, id), ne(runLeases.state, "retired")));
  await tx.delete(artifactFiles).where(eq(artifactFiles.loopId, id));
  await tx.delete(runSnapshots).where(eq(runSnapshots.loopId, id));
  return true;
}

export async function deleteLoop(id: string): Promise<boolean> {
  await requestDeleteLoop(id);
  return tryDeleteLoop(id);
}

export interface PauseLoopResult { loop: Loop; running?: Run }

/** Stable Pause plus the post-transition running fact, observed under the same loop
 * lock. Callers use this result for truthful wording without a pre-lock race. */
export async function pauseLoopState(id: string): Promise<PauseLoopResult | undefined> {
  return db.transaction(async (tx) => {
    const current = (await tx.select().from(loops).where(eq(loops.id, id)).for("update"))[0];
    if (!current) return undefined;
    const loop = await updateLoopTx(tx, current, { enabled: false }, nowIso());
    const running = (await tx.select().from(runs).where(and(eq(runs.loopId, id), eq(runs.phase, "running"))).limit(1))[0];
    return { loop, ...(running ? { running } : {}) };
  });
}

/** Pause a loop and return its updated row. */
export async function pauseLoop(id: string): Promise<Loop | undefined> {
  return (await pauseLoopState(id))?.loop;
}

/** Start a paused loop unless deletion has begun. */
export async function startLoop(id: string): Promise<Loop | undefined> {
  return db.transaction(async (tx) => {
    const current = (await tx.select().from(loops).where(eq(loops.id, id)).for("update"))[0];
    if (!current || current.deleteRequestedAt) return undefined;
    return updateLoopTx(tx, current, { enabled: true }, nowIso());
  });
}

export interface StopLoopResult { loop: Loop; running?: Run }

async function stopLoopTx(tx: StoreTx, current: Loop, at: string): Promise<StopLoopResult> {
  const loop = (await tx.update(loops).set({ enabled: false, pauseCause: { kind: "owner", at }, nextCadenceAt: null, nextRunAt: null, updatedAt: at })
    .where(eq(loops.id, current.id)).returning())[0]!;
  await cancelPendingTx(tx, and(eq(runs.loopId, current.id), eq(runs.phase, "pending")), "canceled - loop stopped before this queued run was claimed", at);
  const running = (await tx.select().from(runs).where(and(eq(runs.loopId, current.id), eq(runs.phase, "running"))).limit(1).for("update"))[0];
  if (!running) return { loop };
  const marked = running.cancelRequestedAt ? running : (await tx.update(runs).set({ cancelRequestedAt: at, updatedAt: at })
    .where(and(eq(runs.id, running.id), eq(runs.phase, "running"), isNull(runs.cancelRequestedAt))).returning())[0] ?? running;
  return { loop, running: marked };
}

/** Stop is one loop-locked write: Pause + cancel all queue + mark current run. */
export async function stopLoop(id: string): Promise<StopLoopResult | undefined> {
  return db.transaction(async (tx) => {
    const current = (await tx.select().from(loops).where(eq(loops.id, id)).for("update"))[0];
    return current ? stopLoopTx(tx, current, nowIso()) : undefined;
  });
}

/** Stop-run preserves loop lifecycle; running cancellation waits for daemon proof. */
export async function requestRunCancel(loopId: string, runId: string): Promise<Run | undefined> {
  return db.transaction(async (tx) => {
    const loop = (await tx.select({ id: loops.id }).from(loops).where(eq(loops.id, loopId)).for("update"))[0];
    if (!loop) return undefined;
    const run = (await tx.select().from(runs).where(and(eq(runs.id, runId), eq(runs.loopId, loopId))).limit(1).for("update"))[0];
    if (!run) return undefined;
    if (run.phase === "pending") {
      const at = nowIso();
      const runIndex = await ensureRunIndexTx(tx, run);
      return (await tx.update(runs).set({ phase: "canceled", runIndex, error: "stopped by user", ts: at, updatedAt: at })
        .where(and(eq(runs.id, runId), eq(runs.phase, "pending"))).returning())[0] ?? run;
    }
    if (run.phase === "running" && !run.cancelRequestedAt) {
      const at = nowIso();
      return (await tx.update(runs).set({ cancelRequestedAt: at, updatedAt: at })
        .where(and(eq(runs.id, runId), eq(runs.phase, "running"), isNull(runs.cancelRequestedAt))).returning())[0] ?? run;
    }
    return run;
  });
}

export async function requestDeleteLoop(id: string): Promise<StopLoopResult | undefined> {
  return db.transaction(async (tx) => {
    let current = (await tx.select().from(loops).where(eq(loops.id, id)).for("update"))[0];
    if (!current) return undefined;
    const at = current.deleteRequestedAt ?? nowIso();
    if (!current.deleteRequestedAt) current = (await tx.update(loops).set({ deleteRequestedAt: at, updatedAt: at }).where(eq(loops.id, id)).returning())[0]!;
    return stopLoopTx(tx, current, at);
  });
}

export async function tryDeleteLoop(id: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const loop = (await tx.select().from(loops).where(eq(loops.id, id)).for("update"))[0];
    if (!loop?.deleteRequestedAt) return false;
    const open = (await tx.select({ id: runs.id }).from(runs).where(and(eq(runs.loopId, id), inArray(runs.phase, ["pending", "running"]))).limit(1))[0];
    const authority = (await tx.select({ id: runLeases.tokenHash }).from(runLeases).where(and(eq(runLeases.loopId, id), inArray(runLeases.state, ["active", "terminal-grace"]))).limit(1))[0];
    if (open || authority) return false;
    await tx.update(runLeases).set({ state: "retired", expiresAt: null })
      .where(and(eq(runLeases.loopId, id), eq(runLeases.state, "reconciliation-only")));
    return deleteLoopDataTx(tx, id);
  });
}

async function forceDeleteLoopTx(tx: StoreTx, id: string): Promise<boolean> {
  const loop = (await tx.select().from(loops).where(eq(loops.id, id)).for("update"))[0];
  if (!loop) return false;
  // Retired is durable acknowledgement evidence, not execution authority. It
  // never blocks claims and has no wall-clock expiry.
  await tx.update(runLeases).set({ state: "retired", expiresAt: null }).where(and(eq(runLeases.loopId, id), inArray(runLeases.state, ["active", "terminal-grace", "reconciliation-only", "retired"])));
  return deleteLoopDataTx(tx, id);
}

export async function forceDeleteLoop(id: string): Promise<boolean> {
  return db.transaction((tx) => forceDeleteLoopTx(tx, id));
}

// ---- runs ----

async function enqueueRunTx(
  tx: StoreTx,
  loop: Loop,
  request: EnqueueRunRequest,
  at: string,
): Promise<EnqueueRunResult> {
  if (loop.deleteRequestedAt) {
    return { state: "rejected", reason: "loop is being deleted" };
  }
  if (request.requestedBy !== "owner" && !loop.enabled) {
    return { state: "skipped", reason: "loop is paused" };
  }

  const pending = (
    await tx
      .select()
      .from(runs)
      .where(and(eq(runs.loopId, loop.id), eq(runs.phase, "pending")))
      .limit(1)
      .for("update")
  )[0];
  if (pending) {
    const requestedBy: RunRequester = pending.requestedBy === "owner" || request.requestedBy === "owner" ? "owner" : "system";
    const updated = (
      await tx
        .update(runs)
        .set({
          requestedBy,
          ts: at,
          updatedAt: at,
        })
        .where(and(eq(runs.id, pending.id), eq(runs.phase, "pending")))
        .returning()
    )[0];
    return updated
      ? { state: "coalesced", run: updated }
      : { state: "skipped", reason: "queued run was claimed concurrently" };
  }

  const row: NewRun = {
    id: randomUUID(),
    loopId: loop.id,
    machineId: loop.machineId,
    phase: "pending",
    requestedBy: request.requestedBy,
    ...runTimes(at),
  };
  return { state: "queued", run: (await tx.insert(runs).values(row).returning())[0]! };
}

async function failureStreakTx(tx: StoreTx, loopId: string): Promise<number> {
  const lastOk = (
    await tx
      .select({ runIndex: runs.runIndex })
      .from(runs)
      .where(and(eq(runs.loopId, loopId), eq(runs.phase, "done"), isNotNull(runs.runIndex)))
      .orderBy(desc(runs.runIndex))
      .limit(1)
  )[0];
  const conds = [
    eq(runs.loopId, loopId),
    eq(runs.phase, "error"),
    isNotNull(runs.runIndex),
  ];
  if (lastOk?.runIndex != null) conds.push(gt(runs.runIndex, lastOk.runIndex));
  const row = (await tx.select({ n: sql<number>`count(*)` }).from(runs).where(and(...conds)))[0];
  return Number(row?.n ?? 0);
}

interface TerminalLifecycleResult {
  loop: Loop;
  failureStreak: number;
  autoPaused: boolean;
}

async function terminalLifecycleTx(
  tx: StoreTx,
  currentLoop: Loop,
  run: Run,
  terminalAt: string,
  loopPatch: Partial<NewLoop> = {},
  failureAutopauseStreak = 0,
): Promise<TerminalLifecycleResult> {
  const effective = { ...currentLoop, ...loopPatch } as Loop;
  const update: Partial<NewLoop> = { ...loopPatch };

  if ((run.phase === "done" || run.phase === "error") && effective.scheduleMode === "continuous") {
    const openExec = (
      await tx
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.loopId, currentLoop.id), inArray(runs.phase, ["pending", "running"])))
        .limit(1)
    )[0];
    update.nextCadenceAt = effective.enabled && !openExec
      ? new Date(Date.parse(terminalAt) + Math.max(1, effective.continuousDelayMinutes) * 60_000).toISOString()
      : null;
  }

  let loop = Object.keys(update).length
    ? (
        await tx
          .update(loops)
          .set({ ...update, updatedAt: terminalAt })
          .where(eq(loops.id, currentLoop.id))
          .returning()
      )[0]!
    : currentLoop;

  let failureStreak = 0;
  let autoPaused = false;
  if (run.phase === "done" && run.status === "block") {
    loop = (
      await tx
        .update(loops)
        .set({ enabled: false, pauseCause: { kind: "blocked", at: terminalAt, runId: run.id }, nextCadenceAt: null, nextRunAt: null, updatedAt: terminalAt })
        .where(eq(loops.id, currentLoop.id))
        .returning()
    )[0]!;
    await cancelPendingTx(
      tx,
      and(eq(runs.loopId, currentLoop.id), eq(runs.phase, "pending"), eq(runs.requestedBy, "system")),
      "canceled - loop auto-paused after a block report",
      terminalAt,
    );
    autoPaused = true;
  }

  if (run.phase === "error") {
    failureStreak = await failureStreakTx(tx, currentLoop.id);
    if (failureAutopauseStreak > 0 && failureStreak >= failureAutopauseStreak && loop.enabled) {
      loop = (
        await tx
          .update(loops)
          .set({ enabled: false, pauseCause: { kind: "failure-streak", at: terminalAt, runId: run.id, count: failureStreak }, nextCadenceAt: null, nextRunAt: null, updatedAt: terminalAt })
          .where(eq(loops.id, currentLoop.id))
          .returning()
      )[0]!;
      await cancelPendingTx(
        tx,
        and(eq(runs.loopId, currentLoop.id), eq(runs.phase, "pending"), eq(runs.requestedBy, "system")),
        "canceled - loop auto-paused after consecutive failures",
        terminalAt,
      );
      autoPaused = true;
    }
  }

  return { loop, failureStreak, autoPaused };
}

export async function addRun(
  input: Omit<NewRun, "id" | "createdAt" | "updatedAt"> & {
    id?: string;
    createdAt?: string;
    updatedAt?: string;
  },
): Promise<Run> {
  return db.transaction(async (tx) => {
    const loop = (await tx.select().from(loops).where(eq(loops.id, input.loopId)).for("update"))[0];
    if (!loop) throw new Error(`cannot add run for missing loop ${input.loopId}`);
    let runIndex = input.runIndex;
    if (runIndex != null) {
      await tx.update(loops).set({ lastRunIndex: sql`greatest(${loops.lastRunIndex}, ${runIndex})` }).where(eq(loops.id, loop.id));
    } else if (input.phase !== "pending") {
      runIndex = await allocateRunIndexTx(tx, loop.id);
    }
    const executing = input.phase === "running";
    const at = input.ts;
    const row: NewRun = {
      ...input,
      ...(runIndex != null ? { runIndex } : {}),
      ...(executing ? {
        agent: input.agent ?? loop.agent,
        model: input.model ?? loop.model,
        reasoningEffort: input.reasoningEffort ?? loop.reasoningEffort,
      } : {}),
      id: input.id ?? randomUUID(),
      createdAt: input.createdAt ?? at,
      updatedAt: input.updatedAt ?? at,
    };
    return (await tx.insert(runs).values(row).returning())[0]!;
  });
}

export async function getRun(id: string): Promise<Run | undefined> {
  return (await db.select().from(runs).where(eq(runs.id, id)))[0];
}

export async function runningRunsForMachine(machineId: string): Promise<Run[]> {
  return db.select().from(runs)
    .where(and(eq(runs.machineId, machineId), eq(runs.phase, "running")))
    .orderBy(asc(runs.createdAt), asc(runs.id));
}

export async function runningRunForLoop(loopId: string): Promise<Run | undefined> {
  return (await db.select().from(runs)
    .where(and(eq(runs.loopId, loopId), eq(runs.phase, "running"))).limit(1))[0];
}

export async function getReportReceipt(reportId: string) {
  return (await db.select().from(runReportReceipts).where(eq(runReportReceipts.reportId, reportId)))[0];
}

/** Deterministic primary key for exact rejected-payload replay evidence. */
export function terminalIncidentReceiptId(reportId: string, payloadDigest: string): string {
  return createHash("sha256").update(reportId + payloadDigest).digest("hex");
}

export async function getTerminalReportIncidents(reportId: string) {
  return db.select().from(terminalReportIncidents)
    .where(eq(terminalReportIncidents.reportId, reportId)).orderBy(asc(terminalReportIncidents.createdAt));
}

export async function getExactTerminalReportIncident(reportId: string, payloadDigest: string) {
  return (await db.select().from(terminalReportIncidents)
    .where(eq(terminalReportIncidents.id, terminalIncidentReceiptId(reportId, payloadDigest))))[0];
}

export async function putTerminalReportIncidentIfAbsent(input: {
  runId: string;
  reportId: string;
  payloadDigest: string;
  disposition: ReportIncidentDisposition;
  ackBody: Record<string, unknown>;
}) {
  return db.transaction(async (tx) => {
    await lockReportIdTx(tx, input.reportId);
    const id = terminalIncidentReceiptId(input.reportId, input.payloadDigest);
    const existing = (await tx.select().from(terminalReportIncidents).where(eq(terminalReportIncidents.id, id)).limit(1))[0];
    if (existing) return existing;
    return (await tx.insert(terminalReportIncidents).values({ id, ...input, createdAt: nowIso() }).returning())[0]!;
  });
}

export async function countTerminalReportIncidents(): Promise<number> {
  const row = (await db.select({ n: sql<number>`count(*)` }).from(terminalReportIncidents))[0];
  return Number(row?.n ?? 0);
}

/** Serialize all terminal handling for one reportId, even when the competing
 * runs belong to different loop locks or one terminal result lands in the incident table. */
async function lockReportIdTx(tx: StoreTx, reportId: string): Promise<void> {
  const unsigned = BigInt(`0x${createHash("sha256").update(reportId).digest("hex").slice(0, 16)}`);
  const key = BigInt.asIntN(64, unsigned).toString();
  await tx.execute(sql`select pg_advisory_xact_lock(${key}::bigint)`);
}

export async function insertReportReceipt(input: typeof runReportReceipts.$inferInsert): Promise<void> {
  await db.insert(runReportReceipts).values(input);
}

/** Race-safe receipt reservation for definitive non-finalization ACKs (RETIRED).
 * Returns the row that owns reportId, whether inserted here or concurrently. */
export async function putReportReceiptIfAbsent(input: typeof runReportReceipts.$inferInsert) {
  return db.transaction(async (tx) => {
    await lockReportIdTx(tx, input.reportId);
    const inserted = await tx.insert(runReportReceipts).values(input)
      .onConflictDoNothing({ target: runReportReceipts.reportId }).returning();
    return inserted[0] ?? (await tx.select().from(runReportReceipts).where(eq(runReportReceipts.reportId, input.reportId)))[0];
  });
}

export async function countReportReceipts(): Promise<number> {
  const row = (await db.select({ n: sql<number>`count(*)` }).from(runReportReceipts))[0];
  return Number(row?.n ?? 0);
}

/** Idempotent startup repair for a crash across terminalization.
 * Terminal runs can never retain active authority. */
export async function repairTerminalRunLeases(now: number = Date.now()): Promise<number> {
  const repaired = await db.update(runLeases)
    .set({ state: "terminal-grace", expiresAt: new Date(now + TERMINAL_REPORT_GRACE_MS).toISOString() })
    .where(and(
      eq(runLeases.state, "active"),
      sql`exists (select 1 from ${runs} where ${runs.id} = ${runLeases.runId} and ${runs.phase} in ('done', 'error', 'canceled'))`,
    ))
    .returning({ tokenHash: runLeases.tokenHash });
  await db.update(runLeases).set({ expiresAt: null }).where(eq(runLeases.state, "retired"));
  return repaired.length;
}

/** Atomically persist a definitive 410 and consume only the matching retired
 * tombstone. If the HTTP response is lost, the independent receipt replays it. */
export async function acknowledgeRetiredReport(
  leaseTokenHash: string,
  input: typeof runReportReceipts.$inferInsert,
) {
  return db.transaction(async (tx) => {
    await lockReportIdTx(tx, input.reportId);
    const lease = (await tx.select().from(runLeases)
      .where(and(eq(runLeases.tokenHash, leaseTokenHash), eq(runLeases.state, "retired")))
      .limit(1).for("update"))[0];
    if (!lease) return undefined;
    await tx.insert(runReportReceipts).values(input).onConflictDoNothing({ target: runReportReceipts.reportId });
    const stored = (await tx.select().from(runReportReceipts).where(eq(runReportReceipts.reportId, input.reportId)))[0];
    if (stored?.runId === input.runId && stored.payloadDigest === input.payloadDigest && stored.ackStatus === input.ackStatus) {
      await tx.delete(runLeases).where(and(eq(runLeases.tokenHash, leaseTokenHash), eq(runLeases.state, "retired")));
    }
    return stored;
  });
}

export async function updateRun(id: string, patch: Partial<NewRun>): Promise<Run | undefined> {
  await db.update(runs).set({ ...patch, updatedAt: nowIso() }).where(eq(runs.id, id));
  return getRun(id);
}

/** Refresh provider-neutral liveness in one machine-scoped UPDATE. Untrusted ids
 * cannot stamp another machine or a non-running row; fresh stamps stay untouched. */
export async function refreshRunHeartbeats(
  machineId: string,
  runIds: string[],
  at: string,
  staleBefore: string,
): Promise<number> {
  if (!runIds.length) return 0;
  const refreshed = await db
    .update(runs)
    .set({ heartbeatAt: at, updatedAt: at })
    .where(and(
      eq(runs.machineId, machineId),
      eq(runs.phase, "running"),
      inArray(runs.id, runIds),
      or(isNull(runs.heartbeatAt), lt(runs.heartbeatAt, staleBefore)),
    ))
    .returning({ id: runs.id });
  return refreshed.length;
}

type ActiveRunCheck =
  | { state: "active"; run: Run }
  | { state: "invalid-lease" | "run-not-running" };

/** Validate the report-only authority for one currently running run. */
async function activeRunForReportTx(
  tx: StoreTx,
  loopId: string,
  runId: string,
  leaseTokenHash: string,
): Promise<ActiveRunCheck> {
  const lease = (
    await tx
      .select()
      .from(runLeases)
      .where(and(
        eq(runLeases.tokenHash, leaseTokenHash),
        eq(runLeases.runId, runId),
        eq(runLeases.loopId, loopId),
        eq(runLeases.state, "active"),
      ))
      .limit(1)
      .for("update")
  )[0];
  if (!lease) return { state: "invalid-lease" };
  const run = (
    await tx
      .select()
      .from(runs)
      .where(and(
        eq(runs.id, runId),
        eq(runs.loopId, loopId),
        eq(runs.machineId, lease.machineId),
        eq(runs.phase, "running"),
      ))
      .limit(1)
      .for("update")
  )[0];
  return run ? { state: "active", run } : { state: "run-not-running" };
}

export type RecordRunReportResult =
  | { state: "applied"; run: Run }
  | { state: "already-reported" | "missing-loop" | "invalid-lease" | "run-not-running" };

/** Record the agent-authored status/message exactly once. The loop row is the
 * serialization point, so sequential and concurrent duplicate callbacks both
 * lose before any field can be overwritten. */
export async function recordRunReportOnce(input: {
  loopId: string;
  runId: string;
  leaseTokenHash: string;
  status: "keep" | "no-change" | "block";
  message: string;
}): Promise<RecordRunReportResult> {
  return db.transaction(async (tx) => {
    const loop = (await tx.select({ id: loops.id }).from(loops).where(eq(loops.id, input.loopId)).for("update"))[0];
    if (!loop) return { state: "missing-loop" as const };
    const active = await activeRunForReportTx(tx, input.loopId, input.runId, input.leaseTokenHash);
    if (active.state !== "active") return active;
    if (active.run.status != null || active.run.message != null) return { state: "already-reported" as const };
    const at = nowIso();
    const run = (await tx.update(runs)
      .set({ status: input.status, message: input.message, updatedAt: at })
      .where(and(
        eq(runs.id, input.runId),
        eq(runs.loopId, input.loopId),
        eq(runs.phase, "running"),
        isNull(runs.status),
        isNull(runs.message),
      ))
      .returning())[0];
    return run ? { state: "applied" as const, run } : { state: "already-reported" as const };
  });
}

export interface FinalizeRunningRunResult {
  run: Run;
  loop: Loop;
  failureStreak: number;
  autoPaused: boolean;
  /** The daemon had already removed execution exclusion before this report. */
  reportOnly?: boolean;
}

/** Consume a retired tombstone when its reportId is owned by another run.
 * The run/loop may already be deleted, so only the exact incident receipt and
 * lease tombstone participate in this transaction. */
export async function acknowledgeRetiredTerminalIncident(input: {
  runId: string;
  leaseTokenHash: string;
  reportId: string;
  payloadDigest: string;
  ackBody: Record<string, unknown>;
}): Promise<typeof terminalReportIncidents.$inferSelect | undefined> {
  return db.transaction(async (tx) => {
    await lockReportIdTx(tx, input.reportId);
    const id = terminalIncidentReceiptId(input.reportId, input.payloadDigest);
    const replay = (await tx.select().from(terminalReportIncidents).where(eq(terminalReportIncidents.id, id)).limit(1))[0];
    const lease = (await tx.select({ tokenHash: runLeases.tokenHash }).from(runLeases)
      .where(and(
        eq(runLeases.tokenHash, input.leaseTokenHash),
        eq(runLeases.runId, input.runId),
        eq(runLeases.state, "retired"),
      )).limit(1).for("update"))[0];
    if (!lease) return undefined;
    if (replay) {
      await tx.delete(runLeases).where(eq(runLeases.tokenHash, lease.tokenHash));
      return replay;
    }
    const receipt = (await tx.insert(terminalReportIncidents).values({
      id,
      runId: input.runId,
      reportId: input.reportId,
      payloadDigest: input.payloadDigest,
      disposition: "telemetry-rejected",
      ackBody: input.ackBody,
      createdAt: nowIso(),
    }).returning())[0]!;
    await tx.delete(runLeases).where(eq(runLeases.tokenHash, lease.tokenHash));
    return receipt;
  });
}

export type RejectTerminalReportResult =
  | ({ state: "run-error"; receipt: typeof terminalReportIncidents.$inferSelect } & FinalizeRunningRunResult)
  | { state: "telemetry-rejected"; run: Run; loop: Loop; receipt: typeof terminalReportIncidents.$inferSelect; failureStreak: 0; autoPaused: false }
  | { state: "normal-replay"; receipt: typeof runReportReceipts.$inferSelect }
  | { state: "incident-replay"; receipt: typeof terminalReportIncidents.$inferSelect }
  | { state: "invalid-lease" | "missing-loop" | "run-not-terminalizable" };

/** Reject one correlatable terminal attempt as a durable terminal fact. Authority,
 * run/loop lifecycle, incident receipt, and lease consumption share one transaction.
 * No payload-authored cursor/task/message field is accepted here. */
export async function rejectTerminalReport(input: {
  loopId: string;
  runId: string;
  leaseTokenHash: string;
  leaseState: "active" | "terminal-grace" | "reconciliation-only";
  reportId: string;
  payloadDigest: string;
  disposition: ReportIncidentDisposition;
  incident: ReportIncident;
  ackBody: Record<string, unknown>;
  failureAutopauseStreak?: number;
}): Promise<RejectTerminalReportResult> {
  return db.transaction(async (tx) => {
    await lockReportIdTx(tx, input.reportId);
    const current = (await tx.select().from(loops).where(eq(loops.id, input.loopId)).for("update"))[0];
    if (!current) return { state: "missing-loop" as const };

    // A normal finalize that won before this transaction is authoritative. The
    // gateway decides same-run replay vs cross-run conflict from this row.
    const normal = (await tx.select().from(runReportReceipts).where(eq(runReportReceipts.reportId, input.reportId)))[0];
    if (normal?.runId === input.runId) return { state: "normal-replay" as const, receipt: normal };
    const priorIncident = (await tx.select().from(terminalReportIncidents)
      .where(eq(terminalReportIncidents.id, terminalIncidentReceiptId(input.reportId, input.payloadDigest)))
      .limit(1))[0];
    if (priorIncident?.runId === input.runId) return { state: "incident-replay" as const, receipt: priorIncident };

    const now = nowIso();
    const leaseConditions = [
      eq(runLeases.tokenHash, input.leaseTokenHash),
      eq(runLeases.runId, input.runId),
      eq(runLeases.loopId, input.loopId),
      input.leaseState === "active"
        ? eq(runLeases.state, "active")
        : inArray(runLeases.state, ["terminal-grace", "reconciliation-only"]),
    ];
    if (input.leaseState !== "active") leaseConditions.push(gt(runLeases.expiresAt, now));
    const lease = (await tx.select().from(runLeases).where(and(...leaseConditions)).limit(1).for("update"))[0];
    if (!lease) return { state: "invalid-lease" as const };

    const receiptInput: typeof terminalReportIncidents.$inferInsert = {
      id: terminalIncidentReceiptId(input.reportId, input.payloadDigest),
      runId: input.runId,
      reportId: input.reportId,
      payloadDigest: input.payloadDigest,
      disposition: input.disposition,
      ackBody: input.ackBody,
      createdAt: input.incident.at,
    };

    if (lease.state !== "active") {
      const run = (await tx.update(runs)
        .set({ reportIncident: input.incident, updatedAt: input.incident.at })
        .where(and(eq(runs.id, input.runId), eq(runs.loopId, input.loopId), inArray(runs.phase, ["done", "error", "canceled"])))
        .returning())[0];
      if (!run) return { state: "run-not-terminalizable" as const };
      await tx.delete(runLeases).where(eq(runLeases.tokenHash, input.leaseTokenHash));
      const receipt = priorIncident ?? (await tx.insert(terminalReportIncidents).values(receiptInput).returning())[0]!;
      return { state: "telemetry-rejected" as const, run, loop: current, receipt, failureStreak: 0 as const, autoPaused: false as const };
    }

    const target = (await tx.select().from(runs)
      .where(and(eq(runs.id, input.runId), eq(runs.loopId, input.loopId), eq(runs.phase, "running")))
      .limit(1).for("update"))[0];
    if (!target) return { state: "run-not-terminalizable" as const };
    const runIndex = await ensureRunIndexTx(tx, target);
    const run = (await tx.update(runs)
      .set({
        phase: "error",
        runIndex,
        error: input.incident.reason,
        reportIncident: input.incident,
        ts: input.incident.at,
        updatedAt: input.incident.at,
      })
      .where(and(eq(runs.id, input.runId), eq(runs.loopId, input.loopId), eq(runs.phase, "running")))
      .returning())[0];
    if (!run) return { state: "run-not-terminalizable" as const };
    const lifecycle = await terminalLifecycleTx(
      tx,
      current,
      run,
      input.incident.at,
      {},
      input.failureAutopauseStreak ?? 0,
    );
    await tx.delete(runLeases).where(eq(runLeases.tokenHash, input.leaseTokenHash));
    const receipt = priorIncident ?? (await tx.insert(terminalReportIncidents).values(receiptInput).returning())[0]!;
    return { state: "run-error" as const, run, ...lifecycle, receipt };
  });
}

/** Atomically CAS running→terminal and apply the report's loop patch.
 * The loop patch is unreachable when cancel/reclaim/another report won. */
export async function finalizeRunningRun(
  loopId: string,
  runId: string,
  runPatch: Partial<NewRun> & { phase: "done" | "error" | "canceled" },
  loopPatch: Partial<NewLoop> = {},
  leaseTokenHash?: string,
  failureAutopauseStreak = 0,
  receipt?: typeof runReportReceipts.$inferInsert,
): Promise<FinalizeRunningRunResult | undefined> {
  return db.transaction(async (tx) => {
    if (receipt) await lockReportIdTx(tx, receipt.reportId);
    const current = (await tx.select().from(loops).where(eq(loops.id, loopId)).for("update"))[0];
    if (!current) return undefined;
    if (receipt) {
      const incident = (await tx.select({ id: terminalReportIncidents.id }).from(terminalReportIncidents)
        .where(eq(terminalReportIncidents.reportId, receipt.reportId)).limit(1))[0];
      if (incident) return undefined;
    }
    if (leaseTokenHash) {
      const active = await activeRunForReportTx(tx, loopId, runId, leaseTokenHash);
      if (active.state !== "active") return undefined;
    }
    const target = (await tx.select().from(runs)
      .where(and(eq(runs.id, runId), eq(runs.loopId, loopId), eq(runs.phase, "running")))
      .limit(1).for("update"))[0];
    if (!target) return undefined;
    const runIndex = await ensureRunIndexTx(tx, target);
    const at = typeof runPatch.ts === "string" ? runPatch.ts : nowIso();
    const run = (
      await tx
        .update(runs)
        .set({ ...runPatch, runIndex, updatedAt: at })
        .where(and(eq(runs.id, runId), eq(runs.loopId, loopId), eq(runs.phase, "running")))
        .returning()
    )[0];
    if (!run) return undefined;
    const lifecycle = await terminalLifecycleTx(tx, current, run, at, loopPatch, failureAutopauseStreak);
    if (leaseTokenHash) await tx.delete(runLeases).where(eq(runLeases.runId, runId));
    if (receipt) await tx.insert(runReportReceipts).values(receipt);
    return { run, ...lifecycle };
  });
}

/** Sweep reclaim under the same loop lock as claim/report/cancel. Running
 * reclaims terminalize their lease and write the provisional continuous cadence
 * fact atomically; pending reclaims have no lease. */
export async function reclaimRun(
  runId: string,
  expected: "pending" | "running",
  reason: string,
  at = nowIso(),
  graceMs = 24 * 60 * 60 * 1000,
  failureAutopauseStreak = 0,
): Promise<FinalizeRunningRunResult | undefined> {
  return db.transaction(async (tx) => {
    const observed = (await tx.select({ loopId: runs.loopId }).from(runs).where(eq(runs.id, runId)).limit(1))[0];
    if (!observed) return undefined;
    const loop = (await tx.select().from(loops).where(eq(loops.id, observed.loopId)).for("update"))[0];
    if (!loop) return undefined;
    const currentRun = (await tx.select().from(runs).where(eq(runs.id, runId)).limit(1).for("update"))[0];
    if (currentRun?.phase !== expected) return undefined;
    if (expected === "running") {
      await tx
        .update(runLeases)
        .set({ state: "terminal-grace", expiresAt: new Date(Date.parse(at) + graceMs).toISOString() })
        .where(and(eq(runLeases.runId, runId), eq(runLeases.state, "active")));
    }
    const runIndex = await ensureRunIndexTx(tx, currentRun);
    const reclaimed = (
      await tx
        .update(runs)
        .set({ phase: "error", runIndex, error: reason, ts: at, updatedAt: at })
        .where(and(eq(runs.id, runId), eq(runs.phase, expected)))
        .returning()
    )[0];
    if (!reclaimed) return undefined;
    const lifecycle = await terminalLifecycleTx(tx, loop, reclaimed, at, {}, failureAutopauseStreak);
    return { run: reclaimed, ...lifecycle };
  });
}

/** A daemon's completed recovery snapshot is authoritative for execution
 * exclusion. Reclaimed runs absent from that snapshot retain late-report authority
 * until their original expiry, but stop blocking queued work immediately. */
export async function releaseAbsentReconciliations(
  machineId: string,
  recoverableRunIds: string[],
  at = nowIso(),
): Promise<string[]> {
  const conditions = [
    eq(runLeases.machineId, machineId),
    eq(runLeases.state, "terminal-grace"),
    gt(runLeases.expiresAt, at),
  ];
  const ids = [...new Set(recoverableRunIds)];
  if (ids.length) conditions.push(notInArray(runLeases.runId, ids));
  const released = await db.update(runLeases)
    .set({ state: "reconciliation-only" })
    .where(and(...conditions))
    .returning({ runId: runLeases.runId });
  return released.map((row) => row.runId);
}

/** Consume one terminal reconciliation lease and reconcile its reclaimed error
 * exactly once. Keeping the lease check/delete beside the run + loop writes closes the
 * error→error double-report hole where a phase CAS alone cannot distinguish the
 * first real failure from a second concurrent one. */
export async function reconcileReclaimedRun(
  loopId: string,
  runId: string,
  leaseTokenHash: string,
  runPatch: Partial<NewRun> & { phase: "done" | "error" | "canceled" },
  loopPatch: Partial<NewLoop> = {},
  failureAutopauseStreak = 0,
  receipt?: typeof runReportReceipts.$inferInsert,
): Promise<FinalizeRunningRunResult | undefined> {
  return db.transaction(async (tx) => {
    if (receipt) await lockReportIdTx(tx, receipt.reportId);
    const current = (await tx.select().from(loops).where(eq(loops.id, loopId)).for("update"))[0];
    if (!current) return undefined;
    if (receipt) {
      const incident = (await tx.select({ id: terminalReportIncidents.id }).from(terminalReportIncidents)
        .where(eq(terminalReportIncidents.reportId, receipt.reportId)).limit(1))[0];
      if (incident) return undefined;
    }
    // Resolve expiry from a fresh clock read after acquiring the loop lock. A
    // gateway precheck may have happened before the grace window elapsed or a
    // successor claim; it is never authority for this write.
    const leaseNow = nowIso();
    const lease = (
      await tx
        .select({ tokenHash: runLeases.tokenHash, state: runLeases.state })
        .from(runLeases)
        .where(
          and(
            eq(runLeases.tokenHash, leaseTokenHash),
            eq(runLeases.runId, runId),
            eq(runLeases.loopId, loopId),
            inArray(runLeases.state, ["terminal-grace", "reconciliation-only"]),
            gt(runLeases.expiresAt, leaseNow),
          ),
        )
        .limit(1)
        .for("update")
    )[0];
    if (!lease) return undefined;
    const target = (await tx.select().from(runs)
      .where(and(eq(runs.id, runId), eq(runs.loopId, loopId), eq(runs.phase, "error")))
      .limit(1).for("update"))[0];
    if (!target) return undefined;
    const runIndex = await ensureRunIndexTx(tx, target);
    const at = typeof runPatch.ts === "string" ? runPatch.ts : nowIso();
    const run = (
      await tx
        .update(runs)
        .set({ ...runPatch, runIndex, updatedAt: at })
        .where(and(eq(runs.id, runId), eq(runs.loopId, loopId), eq(runs.phase, "error")))
        .returning()
    )[0];
    if (!run) return undefined;
    // Once the daemon has disavowed execution, a successor may already be open.
    // Preserve the old run's late result, but never let it retime or reconfigure
    // the loop, trip the breaker, or otherwise mutate the successor lifecycle.
    const lifecycle = lease.state === "reconciliation-only"
      ? { loop: current, failureStreak: 0, autoPaused: false }
      : await terminalLifecycleTx(tx, current, run, at, loopPatch, failureAutopauseStreak);
    await tx.delete(runLeases).where(eq(runLeases.runId, runId));
    if (receipt) await tx.insert(runReportReceipts).values(receipt);
    return { run, ...lifecycle, reportOnly: lease.state === "reconciliation-only" };
  });
}

export const TERMINAL_REPORT_GRACE_MS = 10 * 60 * 1000;

export interface EnqueueRunRequest {
  requestedBy: RunRequester;
}

export type EnqueueRunResult =
  | { state: "queued" | "coalesced"; run: Run }
  | { state: "skipped" | "rejected"; reason: string };

/**
 * The durable run-queue write seam. It serializes on the loop row and owns every
 * queue invariant callers would otherwise have to reproduce:
 *  - at most one ordinary pending row per loop (also backed by a partial unique index),
 *  - a running run may retain one coalesced follow-up,
 *  - owner authority promotes an existing system row and never downgrades,
 *  - paused loops accept owner Run-once work while recurring system work stays stopped.
 */
export async function enqueueRun(loopId: string, request: EnqueueRunRequest): Promise<EnqueueRunResult> {
  return db.transaction(async (tx) => {
    const loop = (await tx.select().from(loops).where(eq(loops.id, loopId)).for("update"))[0];
    if (!loop) return { state: "rejected", reason: "loop not found" };
    return enqueueRunTx(tx, loop, request, nowIso());
  });
}

export interface AdvancedSchedule {
  loop: Loop;
  run?: Run;
  state: "queued" | "coalesced" | "skipped";
}

/** Materialize every due schedule fact. Each loop is locked and rechecked in its
 * own transaction; cadence and one-shot facts may coalesce into one system exec
 * and are consumed together. */
export async function advanceDueSchedules(
  at = nowIso(),
  filter: { loopId?: string; machineId?: string } = {},
): Promise<AdvancedSchedule[]> {
  const due = or(
    and(isNotNull(loops.nextCadenceAt), sql`${loops.nextCadenceAt} <= ${at}`),
    and(isNotNull(loops.nextRunAt), sql`${loops.nextRunAt} <= ${at}`),
  );
  const candidates = await db
    .select({ id: loops.id })
    .from(loops)
    .where(and(
      eq(loops.enabled, true),
      isNull(loops.deleteRequestedAt),
      due,
      filter.loopId ? eq(loops.id, filter.loopId) : undefined,
      filter.machineId ? eq(loops.machineId, filter.machineId) : undefined,
    ));

  const advanced: AdvancedSchedule[] = [];
  for (const { id } of candidates) {
    const result = await db.transaction(async (tx) => {
      const loop = (await tx.select().from(loops).where(eq(loops.id, id)).for("update"))[0];
      if (!loop?.enabled || loop.deleteRequestedAt) return undefined;
      const cadenceDue = !!loop.nextCadenceAt && Date.parse(loop.nextCadenceAt) <= Date.parse(at);
      const oneShotDue = !!loop.nextRunAt && Date.parse(loop.nextRunAt) <= Date.parse(at);
      if (!cadenceDue && !oneShotDue) return undefined;

      // A swept process owns the loop until its one late reconcile or lease expiry;
      // do not materialize a successor behind it.
      const graceLease = (
        await tx
          .select({ tokenHash: runLeases.tokenHash })
          .from(runLeases)
          .where(and(eq(runLeases.loopId, id), eq(runLeases.state, "terminal-grace"), gt(runLeases.expiresAt, at)))
          .limit(1)
      )[0];
      if (graceLease) return undefined;

      const open = (await tx.select({ id: runs.id }).from(runs)
        .where(and(eq(runs.loopId, id), inArray(runs.phase, ["pending", "running"])))
        .limit(1))[0];
      // One-shot owner/system work is always materialized (and coalesces into the
      // single queue slot). A recurring cron occurrence honors its overlap policy;
      // continuous is intrinsically non-overlapping.
      const skipRecurring = cadenceDue && !!open && (
        loop.scheduleMode === "continuous" || loop.cronOverlap === "skip"
      );
      const shouldMaterialize = oneShotDue || !skipRecurring;
      const queued = shouldMaterialize
        ? await enqueueRunTx(tx, loop, { requestedBy: "system" }, at)
        : undefined;
      if (queued && !("run" in queued)) return undefined;
      const nextCadenceAt = cadenceDue
        ? loop.scheduleMode === "cron"
          ? nextCronAt(loop.cron, loop.timezone, at)
          : null
        : loop.nextCadenceAt;
      const updatedLoop = (
        await tx
          .update(loops)
          .set({
            nextCadenceAt,
            ...(oneShotDue ? { nextRunAt: null } : {}),
            updatedAt: at,
          })
          .where(eq(loops.id, id))
          .returning()
      )[0]!;
      return queued
        ? { loop: updatedLoop, run: queued.run, state: queued.state } as AdvancedSchedule
        : { loop: updatedLoop, state: "skipped" } as AdvancedSchedule;
    });
    if (result) advanced.push(result);
  }
  return advanced;
}

/** Conservative boot initialization for pre-fact cron rows. No history lookup and
 * no missed-fire catch-up: only install the next future occurrence. */
export async function initializeCronCadence(at = nowIso()): Promise<Loop[]> {
  const candidates = await db
    .select({ id: loops.id })
    .from(loops)
    .where(and(eq(loops.enabled, true), isNull(loops.deleteRequestedAt), eq(loops.scheduleMode, "cron"), isNull(loops.nextCadenceAt)));
  const initialized: Loop[] = [];
  for (const { id } of candidates) {
    const loop = await db.transaction(async (tx) => {
      const current = (await tx.select().from(loops).where(eq(loops.id, id)).for("update"))[0];
      if (!current?.enabled || current.scheduleMode !== "cron" || current.nextCadenceAt) return undefined;
      return (
        await tx
          .update(loops)
          .set({ nextCadenceAt: nextCronAt(current.cron, current.timezone, at), updatedAt: at })
          .where(eq(loops.id, id))
          .returning()
      )[0];
    });
    if (loop) initialized.push(loop);
  }
  return initialized;
}

export interface ClaimedRun {
  run: Run;
  loop: Loop;
  runToken: string;
}

/** Claim one ready loop and mint its lease atomically. Repeated polls may add
 * unlimited cross-loop concurrency; the loop index remains the final same-loop
 * serialization invariant. Reported local runs exclude their loops even if the
 * server has already terminalized an older process. */
export async function claimReadyRunForMachine(
  machineId: string,
  at = nowIso(),
  excludeRunIds: string[] = [],
): Promise<ClaimedRun | undefined> {
  return db.transaction(async (tx) => {
    const machine = (await tx.select({ id: machines.id }).from(machines).where(eq(machines.id, machineId)).for("update"))[0];
    if (!machine) return undefined;

    const excludedLoops = new Set<string>();
    if (excludeRunIds.length) {
      const rows = await tx.select({ loopId: runs.loopId }).from(runs).where(and(
        eq(runs.machineId, machineId),
        inArray(runs.id, [...new Set(excludeRunIds)]),
      ));
      for (const row of rows) excludedLoops.add(row.loopId);
    }

    const next = (await tx
      .select({ run: runs, loop: loops })
      .from(runs)
      .innerJoin(loops, eq(loops.id, runs.loopId))
      .where(and(
        eq(runs.machineId, machineId), eq(runs.phase, "pending"), isNull(runs.cancelRequestedAt),
        or(eq(loops.enabled, true), eq(runs.requestedBy, "owner")),
        isNull(loops.deleteRequestedAt),
        excludedLoops.size ? notInArray(loops.id, [...excludedLoops]) : undefined,
        sql`not exists (select 1 from runs occupied where occupied.loop_id = ${loops.id} and occupied.phase = 'running')`,
        sql`not exists (select 1 from run_leases authority where authority.loop_id = ${loops.id} and (authority.state = 'active' or (authority.state = 'terminal-grace' and authority.expires_at > ${at})))`,
      ))
      .orderBy(asc(runs.createdAt), asc(runs.id))
      .limit(1))[0];
    if (!next) return undefined;

    let loop = (await tx.select().from(loops).where(eq(loops.id, next.loop.id)).for("update"))[0];
    const candidate = (await tx.select().from(runs).where(eq(runs.id, next.run.id)).limit(1).for("update"))[0];
    if (!loop || !candidate || candidate.phase !== "pending" || candidate.cancelRequestedAt || loop.deleteRequestedAt || (!loop.enabled && candidate.requestedBy !== "owner")) return undefined;
    const occupied = (await tx.select({ id: runs.id }).from(runs)
      .where(and(eq(runs.loopId, loop.id), eq(runs.phase, "running"))).limit(1))[0];
    const authority = (await tx.select({ tokenHash: runLeases.tokenHash }).from(runLeases).where(and(
      eq(runLeases.loopId, loop.id),
      inArray(runLeases.state, ["active", "terminal-grace"]),
      or(eq(runLeases.state, "active"), gt(runLeases.expiresAt, at)),
    )).limit(1))[0];
    if (occupied || authority) return undefined;

    const runIndex = await ensureRunIndexTx(tx, candidate);
    const run = (await tx.update(runs).set({
      phase: "running", runIndex, agent: loop.agent, model: loop.model,
      reasoningEffort: loop.reasoningEffort, heartbeatAt: null, ts: at, updatedAt: at,
    }).where(and(eq(runs.id, candidate.id), eq(runs.phase, "pending"), isNull(runs.cancelRequestedAt))).returning())[0];
    if (!run) return undefined;
    if (loop.scheduleMode === "continuous" && loop.nextCadenceAt != null) {
      loop = (await tx.update(loops).set({ nextCadenceAt: null, updatedAt: at }).where(eq(loops.id, loop.id)).returning())[0]!;
    }
    const runToken = `rk_${randomBytes(16).toString("hex")}`;
    const tokenHash = createHash("sha256").update(runToken).digest("hex");
    await tx.insert(runLeases).values({
      tokenHash,
      runId: run.id,
      loopId: loop.id,
      machineId,
      createdAt: at,
    });
    return { run, loop, runToken };
  });
}


/** Newest-last run history for a loop (chronological), capped. */
export async function listRuns(loopId: string, limit = 30): Promise<Run[]> {
  const rows = await db
    .select()
    .from(runs)
    .where(eq(runs.loopId, loopId))
    .orderBy(desc(runs.ts))
    .limit(limit);
  return rows.reverse();
}

/** Live reconciliation projection for dashboard/run-detail reads. */
export async function reconciliationStatesForRuns(
  loopId: string,
  runIds: string[],
  at = nowIso(),
): Promise<Map<string, "blocking" | "report-only">> {
  if (!runIds.length) return new Map();
  const rows = await db.select({ runId: runLeases.runId, state: runLeases.state })
    .from(runLeases)
    .where(and(
      eq(runLeases.loopId, loopId),
      inArray(runLeases.runId, [...new Set(runIds)]),
      inArray(runLeases.state, ["terminal-grace", "reconciliation-only"]),
      gt(runLeases.expiresAt, at),
    ));
  return new Map(rows.map((row) => [row.runId, row.state === "terminal-grace" ? "blocking" as const : "report-only" as const]));
}

/** One older page: runs strictly before `beforeTs`, newest-first then capped,
 *  returned chronological (oldest-first) to match listRuns. Cursor-based (by ts,
 *  not offset) so it's stable while new runs land at the head. */
export async function listRunsBefore(loopId: string, beforeTs: string, limit = 16): Promise<Run[]> {
  const rows = await db
    .select()
    .from(runs)
    .where(and(eq(runs.loopId, loopId), lt(runs.ts, beforeTs)))
    .orderBy(desc(runs.ts))
    .limit(limit);
  return rows.reverse();
}

export async function lastRun(loopId: string): Promise<Run | undefined> {
  return (await db.select().from(runs).where(eq(runs.loopId, loopId)).orderBy(desc(runs.ts)).limit(1))[0];
}

export async function countRuns(loopId: string): Promise<number> {
  const r = (await db.select({ n: sql<number>`count(*)` }).from(runs).where(eq(runs.loopId, loopId)))[0];
  return Number(r?.n ?? 0);
}

/** Run count and reported input + output tokens in a bounded recent window. */
export async function recentLoopUsage(loopId: string, since: string): Promise<{ runCount: number; tokenCount: number }> {
  const row = (await db
    .select({
      runCount: sql<number>`count(*)`,
      tokenCount: sql<number>`coalesce(sum(
        coalesce((${runs.usage} ->> 'inputTokens')::bigint, 0) +
        coalesce((${runs.usage} ->> 'outputTokens')::bigint, 0)
      ), 0)`,
    })
    .from(runs)
    .where(and(eq(runs.loopId, loopId), sql`${runs.ts} >= ${since}`)))[0];
  return {
    runCount: Number(row?.runCount ?? 0),
    tokenCount: Number(row?.tokenCount ?? 0),
  };
}

/** Open runs (pending/running) — used by the timeout-reclaim sweep. */
export async function openRuns(): Promise<Run[]> {
  return db.select().from(runs).where(inArray(runs.phase, ["pending", "running"]));
}

export async function hasRunningRun(loopId: string): Promise<boolean> {
  const r = (
    await db.select({ id: runs.id }).from(runs).where(and(eq(runs.loopId, loopId), eq(runs.phase, "running"))).limit(1)
  )[0];
  return !!r;
}

export async function hasPendingRun(loopId: string): Promise<boolean> {
  const r = (
    await db.select({ id: runs.id }).from(runs).where(and(eq(runs.loopId, loopId), eq(runs.phase, "pending"))).limit(1)
  )[0];
  return !!r;
}

/** Is a run for this loop still open (drives the "skip overlapping tick" guard)? */
export async function openRunsForLoop(loopId: string): Promise<Run[]> {
  return db.select().from(runs).where(and(eq(runs.loopId, loopId), inArray(runs.phase, ["pending", "running"])));
}

/** Expire one offline system row only if the sweep snapshot is still exact and
 * its immutable lifetime remains over the cap under the loop lock. */
export async function expirePendingRun(
  runId: string,
  expected: Pick<Run, "requestedBy" | "updatedAt">,
  at: string,
  maxLifetimeMs: number,
  message: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const observed = (await tx.select({ loopId: runs.loopId }).from(runs).where(eq(runs.id, runId)).limit(1))[0];
    if (!observed) return false;
    const loop = (await tx.select({ id: loops.id }).from(loops).where(eq(loops.id, observed.loopId)).for("update"))[0];
    if (!loop) return false;
    const current = (
      await tx
        .select()
        .from(runs)
        .where(and(
          eq(runs.id, runId),
          eq(runs.loopId, loop.id),
          eq(runs.phase, "pending"),
          eq(runs.requestedBy, "system"),
          eq(runs.requestedBy, expected.requestedBy),
          eq(runs.updatedAt, expected.updatedAt),
        ))
        .limit(1)
        .for("update")
    )[0];
    if (!current || Date.parse(at) - Date.parse(current.createdAt) <= maxLifetimeMs) return false;
    const machine = (await tx.select({ online: machines.online }).from(machines).where(eq(machines.id, current.machineId)).limit(1))[0];
    if (machine?.online) return false;
    const runIndex = await ensureRunIndexTx(tx, current);
    const canceled = await tx
      .update(runs)
      .set({ phase: "canceled", runIndex, message, ts: at, updatedAt: at })
      .where(and(
        eq(runs.id, runId),
        eq(runs.phase, "pending"),
        eq(runs.requestedBy, "system"),
        eq(runs.updatedAt, expected.updatedAt),
      ))
      .returning({ id: runs.id });
    return canceled.length > 0;
  });
}

// ---- machines ----

export async function listMachines(teamId?: string): Promise<Machine[]> {
  const q = db.select().from(machines);
  return teamId ? await q.where(eq(machines.teamId, teamId)) : await q;
}

/**
 * Machines usable/visible in a team, MEMBERSHIP-scoped: every machine whose owner
 * belongs to the team (join `machines.userId` → a `team_members` row for this
 * team). One machine therefore appears in every team its owner belongs to.
 * A user has at most one membership row per team, so no machine is duplicated.
 */
export async function listMachinesForTeam(teamId: string): Promise<Machine[]> {
  const rows = await db
    .select({ m: machines })
    .from(machines)
    .innerJoin(teamMembers, eq(machines.userId, teamMembers.userId))
    .where(eq(teamMembers.teamId, teamId));
  return rows.map((r) => r.m);
}

export async function getMachine(id: string): Promise<Machine | undefined> {
  return (await db.select().from(machines).where(eq(machines.id, id)))[0];
}

export async function createMachine(input: Omit<NewMachine, "createdAt"> & { id: string }): Promise<Machine> {
  return (await db.insert(machines).values({ ...input, createdAt: nowIso() }).returning())[0]!;
}

export async function updateMachine(id: string, patch: Partial<NewMachine>): Promise<Machine | undefined> {
  await db.update(machines).set(patch).where(eq(machines.id, id));
  return getMachine(id);
}

export async function deleteMachine(id: string): Promise<boolean> {
  const deleted = await db.delete(machines).where(eq(machines.id, id)).returning({ id: machines.id });
  return deleted.length > 0;
}

export type ForceDeleteMachineResult =
  | { state: "deleted"; loopIds: string[] }
  | { state: "not-found" }
  | { state: "forbidden" };

/** Atomically retire all loop authority, remove server-owned machine data, revoke
 * enrollment, and delete the machine. `allowedTeamIds` is supplied by the
 * authenticated owner flow; a concurrent loop from another team aborts safely. */
export async function forceDeleteMachine(id: string, allowedTeamIds?: readonly string[]): Promise<ForceDeleteMachineResult> {
  return db.transaction(async (tx) => {
    const machine = (await tx.select({ id: machines.id }).from(machines).where(eq(machines.id, id)).for("update"))[0];
    if (!machine) return { state: "not-found" };
    const ownedLoops = await tx.select().from(loops).where(eq(loops.machineId, id)).for("update");
    if (allowedTeamIds) {
      const allowed = new Set(allowedTeamIds);
      if (ownedLoops.some((loop) => !allowed.has(loop.teamId))) return { state: "forbidden" };
    }
    for (const loop of ownedLoops) {
      if (!(await forceDeleteLoopTx(tx, loop.id))) throw new Error(`failed to delete loop ${loop.id}`);
    }
    await tx.delete(connectKeys).where(eq(connectKeys.machineId, id));
    await tx.delete(machines).where(eq(machines.id, id));
    return { state: "deleted", loopIds: ownedLoops.map((loop) => loop.id) };
  });
}

export async function setMachineOnline(id: string, online: boolean): Promise<void> {
  await db.update(machines).set({ online, lastSeen: nowIso() }).where(eq(machines.id, id));
}

// ---- teams ----

/** Deterministic personal-team id for a user (open mode ⇒ the shared "team-shared"). */
export function teamIdForUser(userId: string | null | undefined): string {
  return `team-${userId ?? "shared"}`;
}

// Per-process memo so the hot path (every requestScope) doesn't re-issue an
// INSERT OR IGNORE once a team is known to exist.
const ensuredTeams = new Set<string>();

/** Idempotently create a team (+ owner membership) if absent. The email-derived
 *  `name` seeds only a new personal team, so later owner renames persist.
 *  Memoized ⇒ at most one reconcile per team per process. The team insert +
 *  membership insert are one atomic transaction. */
export async function ensureTeam(id: string, name: string, ownerUserId: string | null): Promise<void> {
  if (ensuredTeams.has(id)) return;
  const ts = nowIso();
  await db.transaction(async (tx) => {
    await tx.insert(teams).values({ id, name, ownerUserId, createdAt: ts }).onConflictDoNothing();
    if (ownerUserId) {
      await tx
        .insert(teamMembers)
        .values({ id: `${id}:${ownerUserId}`, teamId: id, userId: ownerUserId, role: "owner", createdAt: ts })
        .onConflictDoNothing();
    }
  });
  ensuredTeams.add(id);
}

/** A fresh non-personal team id. Random (never `team-<userId>`, which is reserved
 *  for the personal team the requestScope fallback depends on). */
export function newTeamId(): string {
  return `team-${randomUUID().slice(0, 12)}`;
}

/** Whether this is the user's renamable but undeletable personal team. */
export function isPersonalTeam(team: Team): boolean {
  return !!team.ownerUserId && team.id === teamIdForUser(team.ownerUserId);
}

/** Create a non-personal team owned by `ownerUserId` (creator = owner in both
 *  `teams.ownerUserId` and a `team_members` owner row), transactionally. */
export async function createTeam(name: string, ownerUserId: string): Promise<Team> {
  const ts = nowIso();
  const id = newTeamId();
  return db.transaction(async (tx) => {
    const [team] = await tx.insert(teams).values({ id, name, ownerUserId, createdAt: ts }).returning();
    await tx
      .insert(teamMembers)
      .values({ id: `${id}:${ownerUserId}`, teamId: id, userId: ownerUserId, role: "owner", createdAt: ts });
    return team!;
  });
}

/** Rename a team (no name-sync fights this — see ensureTeam). */
export async function renameTeam(teamId: string, name: string): Promise<void> {
  await db.update(teams).set({ name }).where(eq(teams.id, teamId));
}

/** A user's membership row in a team (undefined ⇒ not a member). */
export async function getTeamMember(teamId: string, userId: string): Promise<TeamMember | undefined> {
  return (
    await db
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
  )[0];
}

/** Owner-role member count for a team (drives the last-owner invariant). */
export async function countTeamOwners(teamId: string): Promise<number> {
  const r = (
    await db
      .select({ n: sql<number>`count(*)` })
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.role, "owner")))
  )[0];
  return Number(r?.n ?? 0);
}

export interface TeamMemberWithUser extends TeamMember {
  email: string | null;
  displayName: string | null;
}

/** A team's members joined with their user email/name (owners first, then by
 *  join order). The member-list surface in the team settings UI. */
export async function listTeamMembers(teamId: string): Promise<TeamMemberWithUser[]> {
  const rows = await db
    .select({
      id: teamMembers.id,
      teamId: teamMembers.teamId,
      userId: teamMembers.userId,
      role: teamMembers.role,
      createdAt: teamMembers.createdAt,
      email: user.email,
      displayName: user.name,
    })
    .from(teamMembers)
    .leftJoin(user, eq(teamMembers.userId, user.id))
    .where(eq(teamMembers.teamId, teamId));
  // Owners first, then oldest-first — a stable, readable order.
  return rows
    .map((r) => ({ ...r, email: r.email ?? null, displayName: r.displayName ?? null }))
    .sort((a, b) => (a.role === b.role ? (a.createdAt < b.createdAt ? -1 : 1) : a.role === "owner" ? -1 : 1));
}

/** Resolve a user by email for direct membership; undefined means no account yet. */
export async function userByEmail(email: string): Promise<{ id: string; email: string } | undefined> {
  const r = (
    await db
      .select({ id: user.id, email: user.email })
      .from(user)
      .where(sql`lower(${user.email}) = lower(${email})`)
  )[0];
  return r ? { id: r.id, email: r.email } : undefined;
}

/** Add a member (idempotent — a re-add is a no-op, not a duplicate row). */
export async function addTeamMember(teamId: string, userId: string, role: "owner" | "member"): Promise<void> {
  await db
    .insert(teamMembers)
    .values({ id: `${teamId}:${userId}`, teamId, userId, role, createdAt: nowIso() })
    .onConflictDoNothing();
}

/**
 * Remove a member, but REFUSE if they are the team's LAST owner (the ≥1-owner
 * invariant, checked in the SAME transaction as the delete so two concurrent
 * self-removals can't both win and strand a memberless team). Returns:
 *  - `not-member` — no membership row;
 *  - `last-owner` — refused (they are the sole owner; transfer/promote first);
 *  - `ok` — removed.
 */
export async function removeTeamMemberGuarded(
  teamId: string,
  userId: string,
): Promise<"ok" | "last-owner" | "not-member"> {
  return db.transaction(async (tx) => {
    const m = (
      await tx.select().from(teamMembers).where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    )[0];
    if (!m) return "not-member";
    if (m.role === "owner") {
      // Lock the team's owner rows so two concurrent owner removals serialize:
      // the second txn blocks here until the first commits, then sees the reduced
      // set and is refused — the plain count(*) alone would let both win.
      const owners = (
        await tx
          .select({ id: teamMembers.id })
          .from(teamMembers)
          .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.role, "owner")))
          .for("update")
      ).length;
      if (owners <= 1) return "last-owner";
    }
    await tx.delete(teamMembers).where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
    return "ok";
  });
}

/**
 * Change a member's role, guarding the last-owner invariant transactionally: a
 * demote owner→member that would zero the owner set is refused. Returns
 * `not-member` / `last-owner` / `ok`. A no-op (same role) is `ok`.
 */
export async function setTeamMemberRoleGuarded(
  teamId: string,
  userId: string,
  role: "owner" | "member",
): Promise<"ok" | "last-owner" | "not-member"> {
  return db.transaction(async (tx) => {
    const m = (
      await tx.select().from(teamMembers).where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    )[0];
    if (!m) return "not-member";
    if (m.role === "owner" && role === "member") {
      // Lock the owner rows so a concurrent demote/removal serializes (see
      // removeTeamMemberGuarded) — a bare count(*) would let both zero the set.
      const owners = (
        await tx
          .select({ id: teamMembers.id })
          .from(teamMembers)
          .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.role, "owner")))
          .for("update")
      ).length;
      if (owners <= 1) return "last-owner";
    }
    await tx
      .update(teamMembers)
      .set({ role })
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
    return "ok";
  });
}

/**
 * Delete a team and its dependents, transactionally. The CALLER enforces the
 * policy guards first (personal-team undeletable; blocked while the team owns loops).
 * The transaction rechecks the loop count and aborts (`has-loops`) if one exists,
 * closing the check-then-cascade gap where a loop created between the caller's
 * guard and here would be orphaned at a now-deleted team. On success we cascade
 * the team's own resources: pending invites, memberships, and reassign
 * every machine whose cosmetic home-team was this team back to its owner's
 * personal team (machines are user-owned; the team pointer is only a home hint).
 */
export async function deleteTeamCascade(teamId: string): Promise<"ok" | "has-loops"> {
  const outcome = await db.transaction(async (tx) => {
    const loopCount = Number(
      (await tx.select({ n: sql<number>`count(*)` }).from(loops).where(eq(loops.teamId, teamId)))[0]?.n ?? 0,
    );
    if (loopCount > 0) return "has-loops" as const;
    // Reassign machine home-team pointers (cosmetic) to each machine owner's
    // personal team, so no row dangles at a deleted team.
    const homed = await tx.select().from(machines).where(eq(machines.teamId, teamId));
    for (const m of homed) {
      await tx.update(machines).set({ teamId: teamIdForUser(m.userId) }).where(eq(machines.id, m.id));
    }
    await tx.delete(teamInvites).where(eq(teamInvites.teamId, teamId));
    await tx.delete(teamMembers).where(eq(teamMembers.teamId, teamId));
    await tx.delete(teams).where(eq(teams.id, teamId));
    return "ok" as const;
  });
  if (outcome === "ok") ensuredTeams.delete(teamId);
  return outcome;
}

// ---- team invites (short-lived, single-use membership links) ----

/** Mint an invite for a team. `token` is the caller-supplied wire token. */
export async function createInvite(input: {
  token: string;
  teamId: string;
  role: "owner" | "member";
  invitedByUserId: string;
  expiresAt: string;
}): Promise<TeamInvite> {
  return (await db.insert(teamInvites).values({ ...input, createdAt: nowIso() }).returning())[0]!;
}

export async function getInvite(token: string): Promise<TeamInvite | undefined> {
  return (await db.select().from(teamInvites).where(eq(teamInvites.token, token)))[0];
}

/** A team's still-live invites (unredeemed, unexpired), newest first. */
export async function listPendingInvites(teamId: string): Promise<TeamInvite[]> {
  const now = nowIso();
  return db
    .select()
    .from(teamInvites)
    .where(and(eq(teamInvites.teamId, teamId), isNull(teamInvites.redeemedAt), gt(teamInvites.expiresAt, now)))
    .orderBy(desc(teamInvites.createdAt));
}

/**
 * Atomically redeem a single-use invite: in ONE transaction, stamp
 * `redeemedAt`/`redeemedByUserId` ONLY if the invite is still unredeemed and,
 * when this call won the stamp, grant the membership in the SAME transaction so
 * the two commit together (a crash between them can't burn the link without
 * granting membership). The `redeemed_at IS NULL` guard makes the stamp the
 * single-use chokepoint, so two concurrent redeems can't both add a member.
 * Pass `grant: null` for an already-member redeem (still burns the link, no
 * double-add / no role change). Returns false when the invite was already spent
 * (a losing race, or a stale re-redeem).
 */
export async function redeemInviteAtomic(
  token: string,
  userId: string,
  grant: { teamId: string; role: "owner" | "member" } | null,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const won = await tx
      .update(teamInvites)
      .set({ redeemedAt: nowIso(), redeemedByUserId: userId })
      .where(and(eq(teamInvites.token, token), isNull(teamInvites.redeemedAt)))
      .returning({ token: teamInvites.token });
    if (won.length === 0) return false;
    if (grant) {
      await tx
        .insert(teamMembers)
        .values({
          id: `${grant.teamId}:${userId}`,
          teamId: grant.teamId,
          userId,
          role: grant.role,
          createdAt: nowIso(),
        })
        .onConflictDoNothing();
    }
    return true;
  });
}

/** Revoke a pending invite (owner action). */
export async function deleteInvite(token: string): Promise<void> {
  await db.delete(teamInvites).where(eq(teamInvites.token, token));
}

export async function getTeam(id: string): Promise<Team | undefined> {
  return (await db.select().from(teams).where(eq(teams.id, id)))[0];
}

/** Teams the user belongs to (membership join), newest first. Drives the team
 *  switcher — a regular user has just their personal team (no dropdown). */
export async function listTeamsForUser(userId: string): Promise<Team[]> {
  const rows = await db
    .select({ t: teams })
    .from(teamMembers)
    .innerJoin(teams, eq(teamMembers.teamId, teams.id))
    .where(eq(teamMembers.userId, userId))
    .orderBy(desc(teams.createdAt));
  return rows.map((r) => r.t);
}

/** Whether the user is a member of the team (authorizes a team-switch request). */
export async function isTeamMember(teamId: string, userId: string): Promise<boolean> {
  return !!(
    await db
      .select({ id: teamMembers.id })
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
  )[0];
}

// ---- blobs (content-addressed metadata; bytes live in the configured BlobStore) ----

/** Does the server already have metadata for this blob hash? (drives needHashes). */
export async function blobExists(hash: string): Promise<boolean> {
  return !!(await db.select({ hash: blobs.hash }).from(blobs).where(eq(blobs.hash, hash)))[0];
}

/** Verified byte lengths recorded at blob ingress, used to budget reads before
 * touching the byte store. Missing metadata is intentionally not estimated. */
export async function blobSizes(hashes: string[]): Promise<Map<string, number>> {
  if (!hashes.length) return new Map();
  const rows = await db.select({ hash: blobs.hash, size: blobs.size }).from(blobs).where(inArray(blobs.hash, [...new Set(hashes)]));
  return new Map(rows.map((row) => [row.hash, row.size]));
}

/** Record verified blob metadata idempotently. */
export async function recordBlob(hash: string, size: number): Promise<void> {
  await db.insert(blobs).values({ hash, size, createdAt: nowIso() }).onConflictDoNothing();
}

/** Does any LIVE artifact_files row on a loop bound to `machineId` point at `hash`?
 *  Gates putBlob: a device may only upload bytes the sync handshake actually asked
 *  it for (a row a prior sync wrote for one of ITS loops), never arbitrary
 *  self-hashed blobs — otherwise any device token is an uncapped blob write channel. */
export async function machineReferencesBlob(machineId: string, hash: string): Promise<boolean> {
  return !!(
    await db
      .select({ id: artifactFiles.id })
      .from(artifactFiles)
      .innerJoin(loops, eq(artifactFiles.loopId, loops.id))
      .where(and(
        eq(loops.machineId, machineId),
        eq(artifactFiles.hash, hash),
        eq(artifactFiles.deleted, false),
        sql`${loops.artifacts} @> jsonb_build_array(${artifactFiles.path})`,
      ))
      .limit(1)
  )[0];
}

// ---- artifact_files (the current file set of each loop) ----

export interface ArtifactFileInput {
  loopId: string;
  path: string;
  hash: string | null;
  size: number | null;
  binary: boolean;
  oversize: boolean;
}

async function writeConfiguredArtifactTx(tx: StoreTx, input: ArtifactFileInput, ts: string): Promise<void> {
  await tx
    .insert(artifactFiles)
    .values({
      id: randomUUID(),
      loopId: input.loopId,
      path: input.path,
      hash: input.hash,
      size: input.size,
      binary: input.binary,
      oversize: input.oversize,
      deleted: false,
      updatedAt: ts,
    })
    .onConflictDoUpdate({
      target: [artifactFiles.loopId, artifactFiles.path],
      set: {
        hash: input.hash,
        size: input.size,
        binary: input.binary,
        oversize: input.oversize,
        deleted: false,
        updatedAt: ts,
      },
    });
}

/** Upsert only while the exact literal path remains configured, serialized with
 * owner edits by the loop row lock. */
export async function upsertConfiguredArtifactFile(input: ArtifactFileInput): Promise<boolean> {
  return db.transaction(async (tx) => {
    const loop = (await tx.select({ artifacts: loops.artifacts }).from(loops)
      .where(eq(loops.id, input.loopId)).for("update"))[0];
    if (!loop || !loop.artifacts.includes(input.path)) return false;
    await writeConfiguredArtifactTx(tx, input, nowIso());
    return true;
  });
}

/** Reconcile deletions against both the request's starting allowlist and the
 * current locked loop config. Newly-added paths are never tombstoned by an older
 * in-flight manifest; removed paths can never remain live. */
export async function reconcileConfiguredArtifacts(
  loopId: string,
  configuredAtStart: string[],
  keepPaths: string[],
): Promise<number> {
  return db.transaction(async (tx) => {
    const loop = (await tx.select({ artifacts: loops.artifacts }).from(loops)
      .where(eq(loops.id, loopId)).for("update"))[0];
    if (!loop) return 0;
    const current = new Set(loop.artifacts);
    const started = new Set(configuredAtStart);
    const keep = new Set(keepPaths);
    const live = await tx.select().from(artifactFiles)
      .where(and(eq(artifactFiles.loopId, loopId), eq(artifactFiles.deleted, false)));
    const stale = live.filter((file) => !current.has(file.path) || (started.has(file.path) && !keep.has(file.path)));
    if (!stale.length) return 0;
    const at = nowIso();
    await tx.update(artifactFiles)
      .set({ hash: null, deleted: true, updatedAt: at })
      .where(inArray(artifactFiles.id, stale.map((file) => file.id)));
    return stale.length;
  });
}

/** The loop's current (non-deleted) file set, path-sorted. */
export async function listArtifacts(loopId: string): Promise<ArtifactFile[]> {
  return db
    .select()
    .from(artifactFiles)
    .where(and(eq(artifactFiles.loopId, loopId), eq(artifactFiles.deleted, false)))
    .orderBy(artifactFiles.path);
}

/** Every artifact row for a loop, including tombstones. */
export async function listAllArtifactFiles(loopId: string): Promise<ArtifactFile[]> {
  return db.select().from(artifactFiles).where(eq(artifactFiles.loopId, loopId)).orderBy(artifactFiles.path);
}

/** One file row by loop + path (live or tombstoned). */
export async function getArtifactFile(loopId: string, path: string): Promise<ArtifactFile | undefined> {
  return (
    await db
      .select()
      .from(artifactFiles)
      .where(and(eq(artifactFiles.loopId, loopId), eq(artifactFiles.path, path)))
  )[0];
}

/** The loop's CURRENT live file set as a snapshot manifest (path → metadata) —
 *  what report() captures as the terminal run's artifact state. */
export async function buildLoopManifest(loopId: string): Promise<SnapshotManifest> {
  const manifest: SnapshotManifest = {};
  for (const f of await listArtifacts(loopId)) {
    manifest[f.path] = { hash: f.hash, size: f.size, binary: f.binary, oversize: f.oversize };
  }
  return manifest;
}

// ---- exact-artifact snapshots captured at run boundaries ----

/** Write/overwrite a run's snapshot (path → file metadata). Idempotent on runId
 *  so a re-report of the same run just refreshes the captured artifact state. */
export async function putRunSnapshot(runId: string, loopId: string, manifest: SnapshotManifest): Promise<void> {
  await db
    .insert(runSnapshots)
    .values({ runId, loopId, manifest, createdAt: nowIso() })
    .onConflictDoUpdate({ target: runSnapshots.runId, set: { loopId, manifest, createdAt: nowIso() } });
}

/** A run's captured snapshot, or undefined when the run predates the feature. */
export async function getRunSnapshot(runId: string): Promise<RunSnapshot | undefined> {
  return (await db.select().from(runSnapshots).where(eq(runSnapshots.runId, runId)))[0];
}

/** The most recent indexed snapshot before one run. History order, not a
 * timestamp tie, is the diff baseline. */
export async function prevRunSnapshot(loopId: string, beforeRunIndex: number): Promise<RunSnapshot | undefined> {
  const row = (
    await db
      .select({ snap: runSnapshots })
      .from(runSnapshots)
      .innerJoin(runs, eq(runSnapshots.runId, runs.id))
      .where(and(eq(runSnapshots.loopId, loopId), isNotNull(runs.runIndex), lt(runs.runIndex, beforeRunIndex)))
      .orderBy(desc(runs.runIndex))
      .limit(1)
  )[0];
  return row?.snap;
}

// ---- retention / GC accounting (see gateway/retention.ts) ----

/**
 * Prune a loop's run snapshots down to the `keep` most recent (by createdAt),
 * deleting the rest. Returns the number deleted. This is what makes an old
 * snapshot's now-unreferenced blobs collectable by the blob GC. `keep <= 0`
 * means "keep none" (still bounded). Safe to call repeatedly (idempotent once
 * at/under the window).
 */
export async function pruneRunSnapshots(loopId: string, keep: number): Promise<number> {
  const survivors = keep > 0
    ? (
        await db
          .select({ runId: runSnapshots.runId })
          .from(runSnapshots)
          .where(eq(runSnapshots.loopId, loopId))
          .orderBy(desc(runSnapshots.createdAt), desc(runSnapshots.runId))
          .limit(keep)
      ).map((r) => r.runId)
    : [];
  // Delete by the loop + NOT-IN-survivors predicate directly, NOT by an inArray of
  // every victim runId: survivors is bounded by `keep` (≤20), so this binds a small,
  // fixed number of variables even when a large backlog leaves thousands of
  // snapshots to prune in one pass — no "too many SQL variables" on the first prune.
  const pred = survivors.length
    ? and(eq(runSnapshots.loopId, loopId), notInArray(runSnapshots.runId, survivors))
    : eq(runSnapshots.loopId, loopId);
  const deleted = await db.delete(runSnapshots).where(pred).returning({ id: runSnapshots.runId });
  return deleted.length;
}

/** Distinct loop ids that currently have at least one run snapshot. */
export async function loopIdsWithSnapshots(): Promise<string[]> {
  return (
    await db.selectDistinct({ loopId: runSnapshots.loopId }).from(runSnapshots)
  ).map((r) => r.loopId);
}

/**
 * The full set of blob hashes still referenced by a LIVE row — the GC's keep
 * set. A hash is live if ANY artifact_files row points at it (deleted tombstones
 * carry hash=null, so they don't pin a blob) OR ANY retained run_snapshot's
 * manifest references it. Computed in one pass so the GC never deletes a blob a
 * snapshot still needs for its diff.
 */
export async function liveBlobRefs(): Promise<Set<string>> {
  const refs = new Set<string>();
  for (const r of await db
    .selectDistinct({ hash: artifactFiles.hash })
    .from(artifactFiles)
    .where(isNotNull(artifactFiles.hash))) {
    if (r.hash) refs.add(r.hash);
  }
  for (const r of await db.select({ manifest: runSnapshots.manifest }).from(runSnapshots)) {
    for (const entry of Object.values(r.manifest)) {
      if (entry?.hash) refs.add(entry.hash);
    }
  }
  return refs;
}

/** Blob hashes whose metadata row predates `cutoffIso` (GC candidates — the grace
 *  window excludes freshly-written blobs a concurrent sync may be referencing). */
export async function blobHashesOlderThan(cutoffIso: string): Promise<string[]> {
  return (
    await db
      .select({ hash: blobs.hash })
      .from(blobs)
      .where(lt(blobs.createdAt, cutoffIso))
  ).map((r) => r.hash);
}

/** Delete a blob's metadata row (the bytes are reclaimed separately via the
 *  BlobStore). Idempotent. */
export async function deleteBlob(hash: string): Promise<void> {
  await db.delete(blobs).where(eq(blobs.hash, hash));
}

/** Indexed point check: does any LIVE artifact_files row still point at this hash?
 *  The GC's cheap, always-fresh per-candidate guard (the common re-reference path) —
 *  uses the artifact_files_hash index, so it stays O(1) even as candidates pile up. */
export async function artifactFileReferencesHash(hash: string): Promise<boolean> {
  return !!(await db.select({ id: artifactFiles.id }).from(artifactFiles).where(eq(artifactFiles.hash, hash)))[0];
}

/** Every blob hash referenced by ANY retained run_snapshot's manifest — the full
 *  snapshot scan deserialized ONCE into a Set so the GC can answer per-candidate
 *  snapshot membership in O(1) instead of re-scanning the whole table per garbage
 *  hash. The GC rebuilds this only when the snapshot row count changes (a report()
 *  raced the pass), so a snapshot that comes to reference a hash mid-pass is still
 *  caught — closing the GC-check-time gap where a snapshot references a hash no live
 *  file row does — without paying O(garbage × snapshots). */
export async function snapshotBlobRefs(): Promise<Set<string>> {
  const refs = new Set<string>();
  for (const r of await db.select({ manifest: runSnapshots.manifest }).from(runSnapshots)) {
    for (const entry of Object.values(r.manifest)) {
      if (entry?.hash) refs.add(entry.hash);
    }
  }
  return refs;
}

/** Count of retained run_snapshot rows — the GC's cheap change-detector for deciding
 *  whether to rebuild its precomputed snapshotBlobRefs() set mid-pass. */
export async function countRunSnapshots(): Promise<number> {
  const r = (await db.select({ n: sql<number>`count(*)` }).from(runSnapshots))[0];
  return Number(r?.n ?? 0);
}

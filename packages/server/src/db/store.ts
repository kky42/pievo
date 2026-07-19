/**
 * Data-access layer over Drizzle — replaces c0's file-per-job store. The API is
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
  notificationChannels,
  blobs,
  artifactFiles,
  runSnapshots,
  runLeases,
  type ArtifactFile,
  type ArtifactMeta,
  type ControlAction,
  type Loop,
  type Machine,
  type NewLoop,
  type NewMachine,
  type NewRun,
  type NotificationChannel,
  type NewNotificationChannel,
  type Run,
  type RunRole,
  type RunRequester,
  type RunSnapshot,
  type SnapshotManifest,
  type StateField,
  type Team,
  type TeamMember,
  type TeamInvite,
} from "./schema.js";

// ---- coercion helpers (carried from c0 store.ts) ----

/** Coerce an untrusted value into clean StateField[]; undefined if empty. */
export function coerceStateSchema(raw: unknown): StateField[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: StateField[] = [];
  for (const f of raw) {
    if (f && typeof f.key === "string" && f.key.trim()) {
      out.push({
        key: f.key.trim(),
        ...(typeof f.label === "string" && f.label.trim() ? { label: f.label.trim() } : {}),
        ...(typeof f.unit === "string" && f.unit.trim() ? { unit: f.unit.trim() } : {}),
      });
    }
  }
  return out.length ? out : undefined;
}

const UI_MAX_LEN = 20_000;

/** Trim + length-bound a `ui` template (storage guard; render-time sanitizes XSS). */
export function coerceUi(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim().slice(0, UI_MAX_LEN);
  return s ? s : undefined;
}

/** Any loop can evolve: the evolve pass bootstraps schema/ui/workflow from run
 *  data, so a plain task loop is a prime candidate (turn repeated work into a
 *  gate, add a dashboard). The terminal lifecycle applies the run-count/time
 *  throttle; owner-requested evolve remains unrestricted. */
export function canEvolve(_loop: Loop): boolean {
  return true;
}

export function newLoopId(): string {
  return `loop-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

const EVOLVE_EVERY = Number(process.env.PIEVO_EVOLVE_EVERY || 3);
const EVOLVE_MIN_INTERVAL_MS = Number(process.env.PIEVO_EVOLVE_MIN_INTERVAL_MS || 24 * 3_600_000);

/** First cron occurrence strictly after `after`, interpreted in the loop's zone. */
export function nextCronAt(cron: string, timezone: string | null, after: string): string {
  const probe = new Cron(cron, { paused: true, ...(timezone ? { timezone } : {}) });
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

/** Loops bound to a machine — gates machine deletion (must be empty first). */
export async function loopsForMachine(machineId: string): Promise<Loop[]> {
  return db.select().from(loops).where(eq(loops.machineId, machineId));
}

export async function createLoop(input: Omit<NewLoop, "id" | "createdAt" | "updatedAt" | "nextCadenceAt"> & { id?: string }): Promise<Loop> {
  const ts = nowIso();
  const enabled = input.completedAt ? false : (input.enabled ?? true);
  const scheduleMode = input.scheduleMode ?? "cron";
  const nextCadenceAt = !enabled || input.completedAt
    ? null
    : scheduleMode === "continuous"
      ? ts
      : nextCronAt(input.cron, input.timezone ?? null, ts);
  const row: NewLoop = {
    ...input,
    enabled,
    nextRunAt: enabled ? (input.nextRunAt ?? null) : null,
    nextCadenceAt,
    id: input.id ?? newLoopId(),
    createdAt: ts,
    updatedAt: ts,
  };
  return (await db.insert(loops).values(row).returning())[0]!;
}

type StoreTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function cancelPendingTx(
  tx: StoreTx,
  where: ReturnType<typeof and>,
  message: string,
  at: string,
): Promise<void> {
  await tx
    .update(runs)
    .set({ phase: "canceled", outcome: "skipped", message, progress: null, ts: at, updatedAt: at })
    .where(where);
}

/** The one completion lifecycle implementation. Callers must already hold the
 * loop row lock; the completion stamp, pause/facts, and queue cleanup commit as
 * one transition. */
async function completeLoopTx(
  tx: StoreTx,
  current: Loop,
  patch: Partial<NewLoop>,
  at: string,
): Promise<Loop> {
  const loop = (
    await tx
      .update(loops)
      .set({ ...patch, enabled: false, nextCadenceAt: null, nextRunAt: null, updatedAt: at })
      .where(eq(loops.id, current.id))
      .returning()
  )[0]!;
  await cancelPendingTx(
    tx,
    and(
      eq(runs.loopId, current.id),
      eq(runs.phase, "pending"),
      or(inArray(runs.role, ["exec", "evolve"]), and(eq(runs.role, "edit"), eq(runs.requestedBy, "system"))),
    ),
    "canceled - loop completed before this queued run was claimed",
    at,
  );
  return loop;
}

/** Apply one loop patch while its row lock is held. This is shared by owner edits
 * and run-authorized mutations, so cadence and completion semantics cannot drift. */
async function updateLoopTx(tx: StoreTx, current: Loop, patch: Partial<NewLoop>, at: string): Promise<Loop> {
  const extra: Partial<NewLoop> = {};
  if (patch.goal === null) {
    extra.completedAt = null;
    extra.completionReason = null;
  }
  if (patch.enabled === true && patch.completedAt === undefined && current.completedAt) {
    extra.completedAt = null;
    extra.completionReason = null;
  }

  const completing = patch.completedAt != null;
  if (completing) extra.enabled = false;
  const effective = { ...current, ...patch, ...extra } as Loop;
  const pausing = !effective.enabled || effective.completedAt != null;
  const activating =
    effective.enabled && effective.completedAt == null &&
    ((patch.enabled === true && (!current.enabled || current.completedAt != null)) ||
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
          .where(and(eq(runs.loopId, current.id), eq(runs.role, "exec"), inArray(runs.phase, ["pending", "running"])))
          .limit(1)
      )[0];
      extra.nextCadenceAt = openExec ? null : at;
    }
  } else if (
    effective.enabled && effective.completedAt == null && effective.scheduleMode === "cron" &&
    ((patch.cron !== undefined && patch.cron !== current.cron) ||
      (patch.timezone !== undefined && patch.timezone !== current.timezone))
  ) {
    extra.nextCadenceAt = nextCronAt(effective.cron, effective.timezone, at);
  } else if (
    effective.enabled && effective.completedAt == null && effective.scheduleMode === "continuous" &&
    current.nextCadenceAt && Date.parse(current.nextCadenceAt) > Date.parse(at) &&
    patch.continuousDelayMinutes !== undefined && patch.continuousDelayMinutes !== current.continuousDelayMinutes
  ) {
    // A future fact encodes terminalAt + old delay, so it can be retimed without
    // history. A due activation is work already owed and must never be deferred.
    const terminalAt = Date.parse(current.nextCadenceAt) - current.continuousDelayMinutes * 60_000;
    extra.nextCadenceAt = new Date(terminalAt + effective.continuousDelayMinutes * 60_000).toISOString();
  }

  if (completing) return completeLoopTx(tx, current, { ...patch, ...extra }, at);
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
  return loop;
}

/** Partial owner/system update under the loop lifecycle lock. */
export async function updateLoop(id: string, patch: Partial<NewLoop>): Promise<Loop | undefined> {
  return db.transaction(async (tx) => {
    const current = (await tx.select().from(loops).where(eq(loops.id, id)).for("update"))[0];
    return current ? updateLoopTx(tx, current, patch, nowIso()) : undefined;
  });
}

export async function deleteLoop(id: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const deleted = await tx.delete(loops).where(eq(loops.id, id)).returning({ id: loops.id });
    if (deleted.length > 0) {
      // Cascade the loop's execution + artifact metadata. Leaving these rows behind
      // would pin their blob hashes in the GC keep-set FOREVER (liveBlobRefs unions
      // every artifact_files hash + every retained snapshot manifest), so a deleted
      // loop's R2 bytes would never be reclaimed. The bytes themselves fall out on
      // the next periodic GC pass once nothing references them.
      await tx.delete(runs).where(eq(runs.loopId, id));
      // A live lease for a deleted loop would otherwise linger forever (active
      // leases have no expiry, so the prune never collects them).
      await tx.delete(runLeases).where(eq(runLeases.loopId, id));
      await tx.delete(artifactFiles).where(eq(artifactFiles.loopId, id));
      await tx.delete(runSnapshots).where(eq(runSnapshots.loopId, id));
    }
    return deleted.length > 0;
  });
}

// ---- runs ----

async function enqueueRunTx(
  tx: StoreTx,
  loop: Loop,
  request: EnqueueRunRequest,
  at: string,
): Promise<EnqueueRunResult> {
  if (request.requestedBy === "owner") {
    if (loop.completedAt && request.role !== "edit") {
      return { state: "rejected", reason: "loop is completed - only an owner edit may be queued" };
    }
  } else if (loop.completedAt || !loop.enabled) {
    return { state: "skipped", reason: loop.completedAt ? "loop is completed" : "loop is paused" };
  }

  const pending = (
    await tx
      .select()
      .from(runs)
      .where(and(eq(runs.loopId, loop.id), eq(runs.role, request.role), eq(runs.phase, "pending")))
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
          ...(request.requestedBy === "owner" && request.role === "edit"
            ? { requestText: request.requestText ?? null }
            : {}),
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
    userId: loop.userId,
    machineId: loop.machineId,
    phase: "pending",
    role: request.role,
    requestedBy: request.requestedBy,
    requestText: request.role === "edit" ? request.requestText ?? null : null,
    ...runTimes(at),
  };
  return { state: "queued", run: (await tx.insert(runs).values(row).returning())[0]! };
}

async function execFailureStreakTx(tx: StoreTx, loopId: string): Promise<number> {
  const lastOk = (
    await tx
      .select({ ts: runs.ts })
      .from(runs)
      .where(and(eq(runs.loopId, loopId), eq(runs.role, "exec"), eq(runs.phase, "done")))
      .orderBy(desc(runs.ts))
      .limit(1)
  )[0];
  const conds = [eq(runs.loopId, loopId), eq(runs.role, "exec"), eq(runs.phase, "error")];
  if (lastOk) conds.push(gt(runs.ts, lastOk.ts));
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
  autoEvolve = true,
  failureAutopauseStreak = 0,
): Promise<TerminalLifecycleResult> {
  const effective = { ...currentLoop, ...loopPatch } as Loop;
  const update: Partial<NewLoop> = { ...loopPatch };

  if (run.role === "exec" && effective.scheduleMode === "continuous") {
    const openExec = (
      await tx
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.loopId, currentLoop.id), eq(runs.role, "exec"), inArray(runs.phase, ["pending", "running"])))
        .limit(1)
    )[0];
    update.nextCadenceAt = effective.enabled && !effective.completedAt && !openExec
      ? new Date(Date.parse(terminalAt) + Math.max(1, effective.continuousDelayMinutes) * 60_000).toISOString()
      : null;
  }

  if (run.role === "evolve") {
    const counted = (
      await tx
        .select({ n: sql<number>`count(*)` })
        .from(runs)
        .where(and(eq(runs.loopId, currentLoop.id), eq(runs.role, "exec"), inArray(runs.phase, ["done", "error"])))
    )[0];
    update.evolvedRunCount = Number(counted?.n ?? 0);
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
  if (run.role === "exec" && run.phase === "error") {
    failureStreak = await execFailureStreakTx(tx, currentLoop.id);
    if (failureAutopauseStreak > 0 && failureStreak >= failureAutopauseStreak && loop.enabled && !loop.completedAt) {
      loop = (
        await tx
          .update(loops)
          .set({ enabled: false, nextCadenceAt: null, nextRunAt: null, updatedAt: terminalAt })
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

  if (autoEvolve && run.role === "exec" && run.phase === "done" && loop.enabled && !loop.completedAt && canEvolve(loop)) {
    const counted = (
      await tx
        .select({ n: sql<number>`count(*)` })
        .from(runs)
        .where(and(eq(runs.loopId, loop.id), eq(runs.role, "exec"), inArray(runs.phase, ["done", "error"])))
    )[0];
    const execCount = Number(counted?.n ?? 0);
    const last = (
      await tx
        .select({ ts: runs.ts })
        .from(runs)
        .where(and(eq(runs.loopId, loop.id), eq(runs.role, "evolve"), inArray(runs.phase, ["done", "error"])))
        .orderBy(desc(runs.ts))
        .limit(1)
    )[0];
    const evolved = loop.evolvedRunCount ?? 0;
    const due = execCount >= 1 && (!last || (execCount - evolved >= EVOLVE_EVERY && Date.parse(terminalAt) - Date.parse(last.ts) >= EVOLVE_MIN_INTERVAL_MS));
    if (due) await enqueueRunTx(tx, loop, { role: "evolve", requestedBy: "system" }, terminalAt);
  }

  return { loop, failureStreak, autoPaused };
}

export async function addRun(
  input: Omit<NewRun, "id" | "createdAt" | "updatedAt"> & { id?: string; createdAt?: string; updatedAt?: string },
): Promise<Run> {
  const at = input.ts;
  const row: NewRun = {
    ...input,
    id: input.id ?? randomUUID(),
    createdAt: input.createdAt ?? at,
    updatedAt: input.updatedAt ?? at,
  };
  return (await db.insert(runs).values(row).returning())[0]!;
}

export async function getRun(id: string): Promise<Run | undefined> {
  return (await db.select().from(runs).where(eq(runs.id, id)))[0];
}

export async function updateRun(id: string, patch: Partial<NewRun>): Promise<Run | undefined> {
  await db.update(runs).set({ ...patch, updatedAt: nowIso() }).where(eq(runs.id, id));
  return getRun(id);
}

type RunMutationCapability = "always" | "control" | "set-ui" | "set-schema" | "set-workflow" | "finish";
type ActiveRunCheck =
  | { state: "active"; run: Run }
  | { state: "invalid-lease" | "run-not-running" | "forbidden" };

async function activeRunForMutationTx(
  tx: StoreTx,
  loopId: string,
  runId: string,
  leaseTokenHash: string,
  capability: RunMutationCapability,
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
  const permitted = capability === "always" ||
    (capability === "control" && lease.allowControl) ||
    (capability === "set-ui" && lease.canSetUi) ||
    (capability === "set-schema" && lease.canSetSchema) ||
    (capability === "set-workflow" && lease.canSetWorkflow) ||
    (capability === "finish" && lease.canFinish);
  if (!permitted) return { state: "forbidden" };
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

export type RunAuthorizedMutationResult =
  | { state: "applied"; loop: Loop; run: Run }
  | { state: "constraint-failed"; reason: string }
  | { state: "missing-loop" | "invalid-lease" | "run-not-running" | "forbidden" };

/** Deep run-token mutation seam: authority, run liveness, loop lifecycle writes,
 * run-local writes, and audit append share the loop lock and one transaction. */
export async function mutateForActiveRun(input: {
  loopId: string;
  runId: string;
  leaseTokenHash: string;
  capability: RunMutationCapability;
  loopPatch?: Partial<NewLoop>;
  runPatch?: Partial<NewRun>;
  /** Run self-schedule floors evaluated against the effective locked loop state. */
  constraints?: {
    minCadenceMinutes?: number;
    minCronMinutes?: number;
    minNextRunLeadMinutes?: number;
    maxNextRunLeadMs?: number;
  };
  audit?: ControlAction;
}): Promise<RunAuthorizedMutationResult> {
  return db.transaction(async (tx) => {
    let loop = (await tx.select().from(loops).where(eq(loops.id, input.loopId)).for("update"))[0];
    if (!loop) return { state: "missing-loop" as const };
    const active = await activeRunForMutationTx(tx, input.loopId, input.runId, input.leaseTokenHash, input.capability);
    if (active.state !== "active") return active;
    const effective = { ...loop, ...(input.loopPatch ?? {}) } as Loop;
    const checkedAt = nowIso();
    const minCadence = input.constraints?.minCadenceMinutes;
    if (minCadence !== undefined) {
      if (effective.scheduleMode === "continuous") {
        if (effective.continuousDelayMinutes < minCadence) {
          return { state: "constraint-failed", reason: `a run can't schedule more often than every ${minCadence} min (continuous delay is ${effective.continuousDelayMinutes} min) - the owner can set any cadence via edit` };
        }
      } else {
        const first = nextCronAt(effective.cron, effective.timezone, checkedAt);
        const second = nextCronAt(effective.cron, effective.timezone, first);
        const intervalMinutes = (Date.parse(second) - Date.parse(first)) / 60_000;
        if (intervalMinutes < minCadence) {
          return { state: "constraint-failed", reason: `a run can't schedule more often than every ${minCadence} min (that cron fires every ~${Math.round(intervalMinutes)} min) - the owner can set any cadence via edit` };
        }
      }
    }
    const minCron = input.constraints?.minCronMinutes;
    if (minCron !== undefined) {
      const first = nextCronAt(effective.cron, effective.timezone, checkedAt);
      const second = nextCronAt(effective.cron, effective.timezone, first);
      const intervalMinutes = (Date.parse(second) - Date.parse(first)) / 60_000;
      if (intervalMinutes < minCron) {
        return { state: "constraint-failed", reason: `a run can't schedule more often than every ${minCron} min (that cron fires every ~${Math.round(intervalMinutes)} min) - the owner can set any cadence via edit` };
      }
    }
    if (input.loopPatch?.nextRunAt) {
      const leadMs = Date.parse(input.loopPatch.nextRunAt) - Date.parse(checkedAt);
      const minLead = input.constraints?.minNextRunLeadMinutes;
      if (minLead !== undefined && leadMs < minLead * 60_000) {
        return { state: "constraint-failed", reason: `a run can't reschedule sooner than ${minLead} min out - the owner can set any time via edit` };
      }
      const maxLead = input.constraints?.maxNextRunLeadMs;
      if (maxLead !== undefined && leadMs > maxLead) {
        return { state: "constraint-failed", reason: "too far in the future (>30d)" };
      }
    }
    if (input.loopPatch && Object.keys(input.loopPatch).length) {
      loop = await updateLoopTx(tx, loop, input.loopPatch, input.audit?.ts ?? nowIso());
    }
    const patch: Partial<NewRun> = { ...(input.runPatch ?? {}) };
    if (input.audit) {
      patch.control = [
        ...((active.run.control as ControlAction[] | null | undefined) ?? []),
        input.audit,
      ];
    }
    const run = Object.keys(patch).length
      ? (
          await tx
            .update(runs)
            .set({ ...patch, updatedAt: input.audit?.ts ?? nowIso() })
            .where(and(eq(runs.id, input.runId), eq(runs.loopId, input.loopId), eq(runs.phase, "running")))
            .returning()
        )[0]
      : active.run;
    return run ? { state: "applied" as const, loop, run } : { state: "run-not-running" as const };
  });
}

/** Phase-guarded run transition under the owning loop lock. Sweep reclaim
 * therefore competes at the same linearization point as claim/report/cancel. */
export async function transitionRunPhase(
  id: string,
  expected: "pending" | "running",
  patch: Partial<NewRun>,
): Promise<Run | undefined> {
  return db.transaction(async (tx) => {
    const observed = (await tx.select({ loopId: runs.loopId }).from(runs).where(eq(runs.id, id)).limit(1))[0];
    if (!observed) return undefined;
    const loop = (await tx.select({ id: loops.id }).from(loops).where(eq(loops.id, observed.loopId)).for("update"))[0];
    if (!loop) return undefined;
    const at = typeof patch.ts === "string" ? patch.ts : nowIso();
    const run = (
      await tx
        .update(runs)
        .set({ ...patch, updatedAt: at })
        .where(and(eq(runs.id, id), eq(runs.loopId, observed.loopId), eq(runs.phase, expected)))
        .returning()
    )[0];
    if (run && (patch.phase === "done" || patch.phase === "error")) {
      await terminalLifecycleTx(tx, (await tx.select().from(loops).where(eq(loops.id, observed.loopId)))[0]!, run, at);
    }
    return run;
  });
}

export interface FinalizeRunningRunResult {
  run: Run;
  loop: Loop;
  failureStreak: number;
  autoPaused: boolean;
}

/** Atomically CAS running→terminal and apply the report's loop cursor/task patch.
 * The loop patch is unreachable when cancel/reclaim/another report won. */
export async function finalizeRunningRun(
  loopId: string,
  runId: string,
  runPatch: Partial<NewRun> & { phase: "done" | "error" },
  loopPatch: Partial<NewLoop> = {},
  leaseTokenHash?: string,
  failureAutopauseStreak = 0,
): Promise<FinalizeRunningRunResult | undefined> {
  return db.transaction(async (tx) => {
    const current = (await tx.select().from(loops).where(eq(loops.id, loopId)).for("update"))[0];
    if (!current) return undefined;
    if (leaseTokenHash) {
      const active = await activeRunForMutationTx(tx, loopId, runId, leaseTokenHash, "always");
      if (active.state !== "active") return undefined;
    }
    const at = typeof runPatch.ts === "string" ? runPatch.ts : nowIso();
    const run = (
      await tx
        .update(runs)
        .set({ ...runPatch, updatedAt: at })
        .where(and(eq(runs.id, runId), eq(runs.loopId, loopId), eq(runs.phase, "running")))
        .returning()
    )[0];
    if (!run) return undefined;
    const lifecycle = await terminalLifecycleTx(tx, current, run, at, loopPatch, true, failureAutopauseStreak);
    if (leaseTokenHash) await tx.delete(runLeases).where(eq(runLeases.runId, runId));
    return { run, ...lifecycle };
  });
}

/** Enrich a run finalized by `finish`, consuming the surviving lease in the same
 * transaction. A duplicate/concurrent report whose winner already consumed the
 * lease cannot overwrite telemetry. */
export async function enrichFinishedRun(
  loopId: string,
  runId: string,
  leaseTokenHash: string,
  patch: Partial<NewRun>,
): Promise<Run | undefined> {
  return db.transaction(async (tx) => {
    const loop = (await tx.select({ id: loops.id }).from(loops).where(eq(loops.id, loopId)).for("update"))[0];
    if (!loop) return undefined;
    const lease = (
      await tx
        .select({ tokenHash: runLeases.tokenHash })
        .from(runLeases)
        .where(
          and(
            eq(runLeases.tokenHash, leaseTokenHash),
            eq(runLeases.runId, runId),
            eq(runLeases.loopId, loopId),
            eq(runLeases.state, "active"),
          ),
        )
        .limit(1)
        .for("update")
    )[0];
    if (!lease) return undefined;
    const current = (
      await tx
        .select()
        .from(runs)
        .where(and(eq(runs.id, runId), eq(runs.loopId, loopId), eq(runs.phase, "done")))
        .limit(1)
    )[0];
    if (!current) return undefined;
    const run = Object.keys(patch).length > 0
      ? (
          await tx
            .update(runs)
            .set({ ...patch, updatedAt: nowIso() })
            .where(and(eq(runs.id, runId), eq(runs.loopId, loopId), eq(runs.phase, "done")))
            .returning()
        )[0]
      : current;
    if (!run) return undefined;
    await tx.delete(runLeases).where(eq(runLeases.runId, runId));
    return run;
  });
}

/** User cancellation competes with claim/report/reclaim under the loop lock,
 * transitions only a still-open row, and retires its lease in the same txn. */
export async function cancelRun(loopId: string, runId: string): Promise<Run | undefined> {
  return db.transaction(async (tx) => {
    const loop = (await tx.select({ id: loops.id }).from(loops).where(eq(loops.id, loopId)).for("update"))[0];
    if (!loop) return undefined;
    const at = nowIso();
    const canceled = (
      await tx
        .update(runs)
        .set({
          phase: "canceled",
          error: "stopped by user",
          progress: null,
          ts: at,
          updatedAt: at,
        })
        .where(and(eq(runs.id, runId), eq(runs.loopId, loopId), inArray(runs.phase, ["pending", "running"])))
        .returning()
    )[0];
    if (canceled) await tx.delete(runLeases).where(eq(runLeases.runId, runId));
    return canceled;
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
    const currentRun = (await tx.select({ phase: runs.phase }).from(runs).where(eq(runs.id, runId)).limit(1))[0];
    if (currentRun?.phase !== expected) return undefined;
    if (expected === "running") {
      await tx
        .update(runLeases)
        .set({ state: "terminal-grace", expiresAt: new Date(Date.parse(at) + graceMs).toISOString() })
        .where(and(eq(runLeases.runId, runId), eq(runLeases.state, "active")));
    }
    const reclaimed = (
      await tx
        .update(runs)
        .set({ phase: "error", outcome: "error", error: reason, progress: null, ts: at, updatedAt: at })
        .where(and(eq(runs.id, runId), eq(runs.phase, expected)))
        .returning()
    )[0];
    if (!reclaimed) return undefined;
    const lifecycle = await terminalLifecycleTx(tx, loop, reclaimed, at, {}, false, failureAutopauseStreak);
    return { run: reclaimed, ...lifecycle };
  });
}

/** Consume one terminal-grace lease and reconcile its reclaimed error exactly
 * once. Keeping the lease check/delete beside the run + loop writes closes the
 * error→error double-report hole where a phase CAS alone cannot distinguish the
 * first real failure from a second concurrent one. */
export async function reconcileReclaimedRun(
  loopId: string,
  runId: string,
  leaseTokenHash: string,
  runPatch: Partial<NewRun> & { phase: "done" | "error" },
  loopPatch: Partial<NewLoop> = {},
  failureAutopauseStreak = 0,
): Promise<FinalizeRunningRunResult | undefined> {
  return db.transaction(async (tx) => {
    const current = (await tx.select().from(loops).where(eq(loops.id, loopId)).for("update"))[0];
    if (!current) return undefined;
    // Resolve expiry from a fresh clock read after acquiring the loop lock. A
    // gateway precheck may have happened before the grace window elapsed or a
    // successor claim; it is never authority for this write.
    const leaseNow = nowIso();
    const lease = (
      await tx
        .select({ tokenHash: runLeases.tokenHash })
        .from(runLeases)
        .where(
          and(
            eq(runLeases.tokenHash, leaseTokenHash),
            eq(runLeases.runId, runId),
            eq(runLeases.loopId, loopId),
            eq(runLeases.state, "terminal-grace"),
            gt(runLeases.expiresAt, leaseNow),
          ),
        )
        .limit(1)
        .for("update")
    )[0];
    if (!lease) return undefined;
    const at = typeof runPatch.ts === "string" ? runPatch.ts : nowIso();
    const run = (
      await tx
        .update(runs)
        .set({ ...runPatch, updatedAt: at })
        .where(and(eq(runs.id, runId), eq(runs.loopId, loopId), eq(runs.phase, "error")))
        .returning()
    )[0];
    if (!run) return undefined;
    // The provisional reclaim fact was never materialized while terminal-grace
    // existed. Replace it with the real terminal cadence in this same commit.
    const lifecycle = await terminalLifecycleTx(tx, current, run, at, loopPatch, true, failureAutopauseStreak);
    await tx.delete(runLeases).where(eq(runLeases.runId, runId));
    return { run, ...lifecycle };
  });
}

export type FinishLoopRunResult =
  | { state: "finished"; loop: Loop; run: Run }
  | { state: "missing" | "goal-cleared" | "already-finished" | "run-not-running" | "invalid-lease" | "forbidden" };

/** Atomically finalize the finishing exec, complete/pause its loop, and cancel
 * queued exec/evolve rows under the same loop lock used by poll claims. */
export async function finishLoopRun(
  loopId: string,
  runId: string,
  leaseTokenHash: string,
  input: {
    ts: string;
    reason: string | null;
    message?: string;
    state?: Record<string, number | string>;
    durationMs?: number;
  },
): Promise<FinishLoopRunResult> {
  return db.transaction(async (tx) => {
    const current = (await tx.select().from(loops).where(eq(loops.id, loopId)).for("update"))[0];
    if (!current) return { state: "missing" as const };
    if (current.goal == null) return { state: "goal-cleared" as const };
    if (current.completedAt != null) return { state: "already-finished" as const };
    const active = await activeRunForMutationTx(tx, loopId, runId, leaseTokenHash, "finish");
    if (active.state !== "active") return active;

    const finished = (
      await tx
        .update(runs)
        .set({
          phase: "done",
          outcome: "exec",
          status: "resolved",
          ...(input.message !== undefined ? { message: input.message } : {}),
          ...(input.state !== undefined ? { state: input.state } : {}),
          ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
          progress: null,
          ts: input.ts,
          updatedAt: input.ts,
        })
        .where(and(eq(runs.id, runId), eq(runs.loopId, loopId), eq(runs.phase, "running")))
        .returning()
    )[0];
    if (!finished) return { state: "run-not-running" as const };

    const loop = await completeLoopTx(tx, current, {
      completedAt: input.ts,
      completionReason: input.reason,
    }, input.ts);
    return { state: "finished" as const, loop, run: finished };
  });
}

export interface EnqueueRunRequest {
  role: RunRole;
  requestedBy: RunRequester;
  requestText?: string | null;
}

export type EnqueueRunResult =
  | { state: "queued" | "coalesced"; run: Run }
  | { state: "skipped" | "rejected"; reason: string };

/**
 * The durable run-queue write seam. It serializes on the loop row and owns every
 * queue invariant callers would otherwise have to reproduce:
 *  - at most one pending row per loop+role (also backed by a partial unique index),
 *  - a running role may retain one pending follow-up,
 *  - pending requests coalesce in place (stable run id),
 *  - owner authority promotes an existing system row and never downgrades,
 *  - latest owner edit text wins,
 *  - paused loops accept owner work; completed loops accept owner edit only.
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
  run: Run;
  state: "queued" | "coalesced";
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
      isNull(loops.completedAt),
      due,
      filter.loopId ? eq(loops.id, filter.loopId) : undefined,
      filter.machineId ? eq(loops.machineId, filter.machineId) : undefined,
    ));

  const advanced: AdvancedSchedule[] = [];
  for (const { id } of candidates) {
    const result = await db.transaction(async (tx) => {
      const loop = (await tx.select().from(loops).where(eq(loops.id, id)).for("update"))[0];
      if (!loop?.enabled || loop.completedAt) return undefined;
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

      const queued = await enqueueRunTx(tx, loop, { role: "exec", requestedBy: "system" }, at);
      if (!("run" in queued)) return undefined;
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
      return { loop: updatedLoop, run: queued.run, state: queued.state } as AdvancedSchedule;
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
    .where(and(eq(loops.enabled, true), isNull(loops.completedAt), eq(loops.scheduleMode, "cron"), isNull(loops.nextCadenceAt)));
  const initialized: Loop[] = [];
  for (const { id } of candidates) {
    const loop = await db.transaction(async (tx) => {
      const current = (await tx.select().from(loops).where(eq(loops.id, id)).for("update"))[0];
      if (!current?.enabled || current.completedAt || current.scheduleMode !== "cron" || current.nextCadenceAt) return undefined;
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

/** Claim and lease mint are one atomic loop-lock transaction. A cancel can win
 * before this commit or delete the inserted lease afterward, but can never race
 * through the historical running-without-a-lease gap. */
export async function claimReadyRunsForMachine(machineId: string, at = nowIso()): Promise<ClaimedRun[]> {
  const candidates = await db
    .select({ loopId: runs.loopId })
    .from(runs)
    .where(and(eq(runs.machineId, machineId), eq(runs.phase, "pending")))
    .orderBy(asc(runs.createdAt));
  const loopIds = [...new Set(candidates.map((r) => r.loopId))];
  const claimed: ClaimedRun[] = [];
  for (const loopId of loopIds) {
    // Randomness is generated before opening the transaction; only its hash is
    // persisted with the claim.
    const runToken = `rk_${randomBytes(16).toString("hex")}`;
    const tokenHash = createHash("sha256").update(runToken).digest("hex");
    const result = await db.transaction(async (tx) => {
      let loop = (await tx.select().from(loops).where(eq(loops.id, loopId)).for("update"))[0];
      if (!loop) return undefined;
      const graceLease = (
        await tx
          .select({ tokenHash: runLeases.tokenHash })
          .from(runLeases)
          .where(and(eq(runLeases.loopId, loopId), eq(runLeases.state, "terminal-grace"), gt(runLeases.expiresAt, at)))
          .limit(1)
      )[0];
      if (graceLease) return undefined;
      const alreadyRunning = (
        await tx.select({ id: runs.id }).from(runs).where(and(eq(runs.loopId, loopId), eq(runs.phase, "running"))).limit(1)
      )[0];
      if (alreadyRunning) return undefined;

      const lifecycle = loop.completedAt
        ? and(eq(runs.requestedBy, "owner"), eq(runs.role, "edit"))
        : !loop.enabled
          ? eq(runs.requestedBy, "owner")
          : undefined;
      const next = (
        await tx
          .select()
          .from(runs)
          .where(and(eq(runs.loopId, loopId), eq(runs.machineId, machineId), eq(runs.phase, "pending"), lifecycle))
          .orderBy(sql`case ${runs.role} when 'edit' then 0 when 'evolve' then 1 else 2 end`, asc(runs.createdAt))
          .limit(1)
      )[0];
      if (!next) return undefined;
      const run = (
        await tx
          .update(runs)
          .set({ phase: "running", ts: at, updatedAt: at })
          .where(and(eq(runs.id, next.id), eq(runs.phase, "pending")))
          .returning()
      )[0];
      if (!run) return undefined;

      if (run.role === "exec" && loop.scheduleMode === "continuous" && loop.nextCadenceAt != null) {
        loop = (
          await tx
            .update(loops)
            .set({ nextCadenceAt: null, updatedAt: at })
            .where(eq(loops.id, loop.id))
            .returning()
        )[0]!;
      }
      const structural = run.role === "evolve" || run.role === "edit";
      await tx.insert(runLeases).values({
        tokenHash,
        runId: run.id,
        loopId: loop.id,
        machineId,
        role: run.role,
        allowControl: structural || loop.allowControl,
        canSetUi: structural,
        canSetSchema: structural,
        canSetWorkflow: structural,
        canFinish: run.role === "exec" && loop.goal != null,
        createdAt: at,
      });
      return { run, loop, runToken };
    });
    if (result) claimed.push(result);
  }
  return claimed;
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

/** Latest terminal of any role. For a pending row this is the earliest reliable
 * evidence that a same-loop blocker ended and the daemon could claim again. */
export async function lastTerminalRunAt(loopId: string): Promise<string | null> {
  const row = (
    await db
      .select({ ts: runs.ts })
      .from(runs)
      .where(and(eq(runs.loopId, loopId), inArray(runs.phase, ["done", "error", "canceled"])))
      .orderBy(desc(runs.ts))
      .limit(1)
  )[0];
  return row?.ts ?? null;
}

/** Newest scheduled (exec) run for a loop — the last-outcome anchor that a later
 *  evolve/edit must never mask. Null ⇒ no exec run yet. */
export async function lastExecRun(loopId: string): Promise<Run | undefined> {
  return (
    await db
      .select()
      .from(runs)
      .where(and(eq(runs.loopId, loopId), eq(runs.role, "exec")))
      .orderBy(desc(runs.ts))
      .limit(1)
  )[0];
}

export async function countRuns(loopId: string): Promise<number> {
  const r = (await db.select({ n: sql<number>`count(*)` }).from(runs).where(eq(runs.loopId, loopId)))[0];
  return Number(r?.n ?? 0);
}

/** Total claude-reported spend across ALL of a loop's runs (one SUM over the
 *  real cost column). Null ⇒ no run has reported a cost yet. */
export async function sumRunCost(loopId: string): Promise<number | null> {
  const r = (
    await db
      .select({ total: sql<number | null>`sum(${runs.costUsd})` })
      .from(runs)
      .where(eq(runs.loopId, loopId))
  )[0];
  // Preserve the real-null (no rows / all null) vs 0 distinction: an empty-set sum
  // is null under pg, which must NOT collapse to 0.
  const total = r?.total ?? null;
  return total == null ? null : Number(total);
}

/**
 * Count consecutive FAILED exec runs ending at the loop's most recent finalized
 * exec run. Drives the failure-alert anti-spam cadence (`shouldNotifyFailure`)
 * entirely from persisted state — no in-memory counter to reset on deploy. Only
 * `exec` runs count: evolve/edit are internal and never produce user-facing
 * failure noise. Canceled / still-open runs are ignored (neither success nor
 * failure), so a user-stopped run doesn't break or extend the streak.
 *
 * EXACT, not a capped scan: one indexed query for the newest successful (done)
 * exec run, then a COUNT of the error exec runs after it. A capped newest-N scan
 * would pin the streak at the cap once a loop failed past it, and the every-Nth
 * "still broken" reminder (streak % FAILURE_NOTIFY_EVERY) would then never fire
 * again — reminders must keep pacing however long the failure streak grows.
 */
export async function execFailureStreak(loopId: string): Promise<number> {
  const lastOk = (
    await db
      .select({ ts: runs.ts })
      .from(runs)
      .where(and(eq(runs.loopId, loopId), eq(runs.role, "exec"), eq(runs.phase, "done")))
      .orderBy(desc(runs.ts))
      .limit(1)
  )[0];
  const conds = [eq(runs.loopId, loopId), eq(runs.role, "exec"), eq(runs.phase, "error")];
  if (lastOk) conds.push(gt(runs.ts, lastOk.ts));
  const r = (await db.select({ n: sql<number>`count(*)` }).from(runs).where(and(...conds)))[0];
  return Number(r?.n ?? 0);
}

/** Atomically stamp the deferred hint from a sweep snapshot. Claim, owner
 * promotion, pause/completion, and machine reconnect all win through the guarded
 * transaction, so only a still-pending system exec on an offline machine may
 * trigger the corresponding notification. Returns the locked loop only when the
 * stamp committed; callers gate notification on that result. */
export async function markPendingRunDeferred(
  runId: string,
  expected: Pick<Run, "requestedBy" | "updatedAt">,
  at: string,
  label: string,
): Promise<Loop | undefined> {
  if (expected.requestedBy !== "system") return undefined;
  return db.transaction(async (tx) => {
    const observed = (await tx.select({ loopId: runs.loopId }).from(runs).where(eq(runs.id, runId)).limit(1))[0];
    if (!observed) return undefined;
    const loop = (await tx.select().from(loops).where(eq(loops.id, observed.loopId)).for("update"))[0];
    if (!loop) return undefined;
    const current = (
      await tx
        .select()
        .from(runs)
        .where(and(
          eq(runs.id, runId),
          eq(runs.loopId, loop.id),
          eq(runs.phase, "pending"),
          eq(runs.role, "exec"),
          eq(runs.requestedBy, "system"),
          eq(runs.updatedAt, expected.updatedAt),
        ))
        .limit(1)
        .for("update")
    )[0];
    if (!current || current.progress?.label === label) return undefined;
    const machine = (
      await tx
        .select({ online: machines.online })
        .from(machines)
        .where(eq(machines.id, current.machineId))
        .limit(1)
        .for("update")
    )[0];
    if (!machine || machine.online) return undefined;
    const stamped = (
      await tx
        .update(runs)
        .set({ progress: { step: 0, label, at }, updatedAt: at })
        .where(and(
          eq(runs.id, runId),
          eq(runs.phase, "pending"),
          eq(runs.requestedBy, "system"),
          eq(runs.updatedAt, expected.updatedAt),
        ))
        .returning({ id: runs.id })
    )[0];
    return stamped ? loop : undefined;
  });
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

/** Recheck a never-claimed pending row from its sweep snapshot under the loop
 * lock. Coalescing/promotion refreshes updatedAt, so stale sweep work loses the
 * CAS before it can turn renewed owner intent into an error. */
export async function reclaimUnclaimedPendingRun(
  runId: string,
  expected: Pick<Run, "requestedBy" | "updatedAt">,
  at: string,
  timeoutMs: number,
  reason: string,
  failureAutopauseStreak = 0,
): Promise<FinalizeRunningRunResult | undefined> {
  return db.transaction(async (tx) => {
    const observed = (await tx.select({ loopId: runs.loopId }).from(runs).where(eq(runs.id, runId)).limit(1))[0];
    if (!observed) return undefined;
    const loop = (await tx.select().from(loops).where(eq(loops.id, observed.loopId)).for("update"))[0];
    if (!loop) return undefined;
    const current = (
      await tx
        .select()
        .from(runs)
        .where(and(
          eq(runs.id, runId),
          eq(runs.loopId, loop.id),
          eq(runs.phase, "pending"),
          eq(runs.requestedBy, expected.requestedBy),
          eq(runs.updatedAt, expected.updatedAt),
        ))
        .limit(1)
        .for("update")
    )[0];
    if (!current) return undefined;
    const machine = (await tx.select({ online: machines.online }).from(machines).where(eq(machines.id, current.machineId)).limit(1))[0];
    if (!machine?.online) return undefined;
    const blocker = (
      await tx
        .select({ ts: runs.ts })
        .from(runs)
        .where(and(eq(runs.loopId, loop.id), inArray(runs.phase, ["done", "error", "canceled"])))
        .orderBy(desc(runs.ts))
        .limit(1)
    )[0];
    const running = (
      await tx.select({ id: runs.id }).from(runs).where(and(eq(runs.loopId, loop.id), eq(runs.phase, "running"))).limit(1)
    )[0];
    const eligibleAt = Math.max(Date.parse(current.updatedAt), blocker ? Date.parse(blocker.ts) || 0 : 0);
    if (running || Date.parse(at) - eligibleAt <= timeoutMs) return undefined;
    const reclaimed = (
      await tx
        .update(runs)
        .set({ phase: "error", outcome: "error", error: reason, progress: null, ts: at, updatedAt: at })
        .where(and(
          eq(runs.id, runId),
          eq(runs.phase, "pending"),
          eq(runs.requestedBy, expected.requestedBy),
          eq(runs.updatedAt, expected.updatedAt),
        ))
        .returning()
    )[0];
    if (!reclaimed) return undefined;
    const lifecycle = await terminalLifecycleTx(tx, loop, reclaimed, at, {}, false, failureAutopauseStreak);
    return { run: reclaimed, ...lifecycle };
  });
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
    const canceled = await tx
      .update(runs)
      .set({ phase: "canceled", outcome: "skipped", message, progress: null, ts: at, updatedAt: at })
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
 * team). One machine therefore appears in every team its owner is a member of —
 * the decoupling that lets a single daemon serve multiple teams (report §2.3).
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
 *  `name` is INSERT-ONLY — it seeds a brand-new personal team but is NEVER synced
 *  onto an existing row, so an owner's `renameTeam` on their personal team sticks
 *  (design decision 5 / §6: the old force-rename silently reverted manual renames).
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

/** Is this the user's undeletable personal team (`team-<ownerUserId>`)? The
 *  requestScope fallback, so it can be renamed (decision 5) but never deleted/left. */
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

/** Resolve a user by email (case-insensitive) — the direct-add-by-email fast path
 *  (design §4 option A). Undefined ⇒ no account yet (invite-link path instead). */
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
 * policy guards first (personal-team undeletable; blocked while the team still
 * owns loops — design decision 1, no cascade of loop history). We RE-CHECK the
 * loop count INSIDE the transaction and abort (`has-loops`) if any loop exists,
 * closing the check-then-cascade gap where a loop created between the caller's
 * guard and here would be orphaned at a now-deleted team. On success we cascade
 * the team's own resources: channels, pending invites, memberships, and reassign
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
    await tx.delete(notificationChannels).where(eq(notificationChannels.teamId, teamId));
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

// ---- notification channels ----

export async function listChannels(teamId: string): Promise<NotificationChannel[]> {
  return db
    .select()
    .from(notificationChannels)
    .where(eq(notificationChannels.teamId, teamId))
    .orderBy(desc(notificationChannels.createdAt));
}

export async function getChannel(id: string): Promise<NotificationChannel | undefined> {
  return (await db.select().from(notificationChannels).where(eq(notificationChannels.id, id)))[0];
}

/** The channel a new loop auto-routes to when none is picked — the team's newest
 *  (listChannels is newest-first), or null when the team has none. */
export async function defaultChannelId(teamId: string): Promise<string | null> {
  return (await listChannels(teamId))[0]?.id ?? null;
}

export async function createChannel(input: Omit<NewNotificationChannel, "id" | "createdAt"> & { id?: string }): Promise<NotificationChannel> {
  const row: NewNotificationChannel = {
    ...input,
    id: input.id ?? `ch-${randomUUID().slice(0, 12)}`,
    createdAt: nowIso(),
  };
  return (await db.insert(notificationChannels).values(row).returning())[0]!;
}

export async function deleteChannel(id: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    // Detach any loops pointing at it so they fall back to dashboard-only (no dangling ref).
    await tx.update(loops).set({ channelId: null, updatedAt: nowIso() }).where(eq(loops.channelId, id));
    const deleted = await tx
      .delete(notificationChannels)
      .where(eq(notificationChannels.id, id))
      .returning({ id: notificationChannels.id });
    return deleted.length > 0;
  });
}

// ---- blobs (content-addressed artifact bytes; metadata only — bytes live in R2) ----

/** Does the server already have metadata for this blob hash? (drives needHashes). */
export async function blobExists(hash: string): Promise<boolean> {
  return !!(await db.select({ hash: blobs.hash }).from(blobs).where(eq(blobs.hash, hash)))[0];
}

/** Record a blob's metadata (idempotent — same hash ⇒ same bytes, so a no-op on
 *  conflict). `meta` is the parsed front-matter subset for a non-binary product
 *  (null for binary / unparsed); computed once at ingress and reused on every
 *  content-addressed re-reference (the conflict no-op keeps the first-parsed meta). */
export async function recordBlob(hash: string, size: number, binary: boolean, meta: ArtifactMeta | null = null): Promise<void> {
  await db.insert(blobs).values({ hash, size, binary, meta, createdAt: nowIso() }).onConflictDoNothing();
}

/** Does any LIVE artifact_files row on a loop bound to `machineId` point at `hash`?
 *  Gates putBlob: a device may only upload bytes the sync handshake actually asked
 *  it for (a row a prior sync wrote for one of ITS loops), never arbitrary
 *  self-hashed blobs — otherwise any device token is an uncapped R2 write channel. */
export async function machineReferencesBlob(machineId: string, hash: string): Promise<boolean> {
  return !!(
    await db
      .select({ id: artifactFiles.id })
      .from(artifactFiles)
      .innerJoin(loops, eq(artifactFiles.loopId, loops.id))
      .where(and(eq(loops.machineId, machineId), eq(artifactFiles.hash, hash), eq(artifactFiles.deleted, false)))
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
  lastRunId: string | null;
}

/** Upsert one live file row (keyed by loopId+path); clears any prior tombstone. */
export async function upsertArtifactFile(input: ArtifactFileInput): Promise<void> {
  const ts = nowIso();
  await db
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
      lastRunId: input.lastRunId,
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
        lastRunId: input.lastRunId,
      },
    });
}

/** Tombstone the paths that vanished from a loop's manifest (keep != in `keepPaths`). */
export async function tombstoneMissingArtifacts(loopId: string, keepPaths: string[], lastRunId: string | null): Promise<number> {
  const keep = new Set(keepPaths);
  const live = await db
    .select()
    .from(artifactFiles)
    .where(and(eq(artifactFiles.loopId, loopId), eq(artifactFiles.deleted, false)));
  const ts = nowIso();
  let tombstoned = 0;
  for (const row of live) {
    if (keep.has(row.path)) continue;
    await db
      .update(artifactFiles)
      .set({ hash: null, deleted: true, updatedAt: ts, lastRunId })
      .where(eq(artifactFiles.id, row.id));
    tombstoned++;
  }
  return tombstoned;
}

/** The loop's current (non-deleted) file set, path-sorted. */
export async function listArtifacts(loopId: string): Promise<ArtifactFile[]> {
  return db
    .select()
    .from(artifactFiles)
    .where(and(eq(artifactFiles.loopId, loopId), eq(artifactFiles.deleted, false)))
    .orderBy(artifactFiles.path);
}

/** One live artifact row joined with its blob's parsed front-matter meta (null for
 *  a binary / oversize / not-yet-stored / untyped file). Read path only — the list
 *  view surfaces the type/title/date without a per-file blob byte fetch. */
export interface ArtifactFileWithMeta extends ArtifactFile {
  meta: ArtifactMeta | null;
}

/** The loop's current (non-deleted) file set with each file's blob meta joined
 *  out, path-sorted. One indexed join (artifact_files ⋈ blobs on hash), not a
 *  point query per file. */
export async function listArtifactsWithMeta(loopId: string): Promise<ArtifactFileWithMeta[]> {
  const rows = await db
    .select({
      id: artifactFiles.id,
      loopId: artifactFiles.loopId,
      path: artifactFiles.path,
      hash: artifactFiles.hash,
      size: artifactFiles.size,
      binary: artifactFiles.binary,
      oversize: artifactFiles.oversize,
      deleted: artifactFiles.deleted,
      updatedAt: artifactFiles.updatedAt,
      lastRunId: artifactFiles.lastRunId,
      meta: blobs.meta,
    })
    .from(artifactFiles)
    .leftJoin(blobs, eq(artifactFiles.hash, blobs.hash))
    .where(and(eq(artifactFiles.loopId, loopId), eq(artifactFiles.deleted, false)))
    .orderBy(artifactFiles.path);
  return rows.map((r) => ({ ...r, meta: r.meta ?? null }));
}

/** Every artifact_files row for a loop, including tombstones (Phase 3 diff seam). */
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
 *  what report() captures as the finishing run's end-state. */
export async function buildLoopManifest(loopId: string): Promise<SnapshotManifest> {
  const manifest: SnapshotManifest = {};
  for (const f of await listArtifacts(loopId)) {
    manifest[f.path] = { hash: f.hash, size: f.size, binary: f.binary, oversize: f.oversize };
  }
  return manifest;
}

// ---- run_snapshots (the loop's full manifest at each run boundary; Phase 3 diff) ----

/** Write/overwrite a run's snapshot (path → file metadata). Idempotent on runId
 *  so a re-report of the same run just refreshes the captured end-state. */
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

/** The most recent snapshot for this loop strictly before `beforeTs` (the prior
 *  run's end-state — the diff baseline). Joins run_snapshots to runs for the ts
 *  ordering; undefined when there is no earlier snapshotted run. */
export async function prevRunSnapshot(loopId: string, beforeTs: string): Promise<RunSnapshot | undefined> {
  const row = (
    await db
      .select({ snap: runSnapshots })
      .from(runSnapshots)
      .innerJoin(runs, eq(runSnapshots.runId, runs.id))
      .where(and(eq(runSnapshots.loopId, loopId), lt(runs.ts, beforeTs)))
      .orderBy(desc(runs.ts))
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
  // fixed number of variables even when a pre-feature backlog leaves thousands of
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

/** Distinct loop ids with a LIVE (non-deleted) file row pointing at this hash.
 *  Drives the per-loop cap re-check at putBlob, where the only loop context is
 *  the artifact_files rows a prior sync already wrote for the requested hash. */
export async function loopsReferencingHash(hash: string): Promise<string[]> {
  return (
    await db
      .selectDistinct({ loopId: artifactFiles.loopId })
      .from(artifactFiles)
      .where(and(eq(artifactFiles.hash, hash), eq(artifactFiles.deleted, false)))
  ).map((r) => r.loopId);
}

/** A loop's live byte footprint EXCLUDING any rows pointing at `hash` — the base
 *  the putBlob cap guard adds the blob's REAL byte length to (the placeholder row
 *  a sync wrote for `hash` carries a client-reported size we must not trust). Sums
 *  the VERIFIED blobs.size where the bytes are stored, falling back to the reported
 *  artifact_files.size only for not-yet-stored (pending) rows, so a daemon that
 *  under-reports sizes can't keep the base artificially low. */
export async function loopStoredBytesExcludingHash(loopId: string, hash: string): Promise<number> {
  const row = (
    await db
      .select({ total: sql<number>`coalesce(sum(coalesce(${blobs.size}, ${artifactFiles.size})), 0)` })
      .from(artifactFiles)
      .leftJoin(blobs, eq(artifactFiles.hash, blobs.hash))
      .where(
        and(
          eq(artifactFiles.loopId, loopId),
          eq(artifactFiles.deleted, false),
          eq(artifactFiles.oversize, false),
          isNotNull(artifactFiles.hash),
          ne(artifactFiles.hash, hash),
        ),
      )
  )[0];
  return Number(row?.total ?? 0);
}

/** Hard-delete a loop's file rows pointing at `hash` — used when putBlob refuses
 *  the bytes (per-loop cap), so nothing dangles pointing at a blob never stored.
 *  Returns the number removed. */
export async function dropArtifactFilesForHash(loopId: string, hash: string): Promise<number> {
  const deleted = await db
    .delete(artifactFiles)
    .where(and(eq(artifactFiles.loopId, loopId), eq(artifactFiles.hash, hash)))
    .returning({ id: artifactFiles.id });
  return deleted.length;
}

/** A loop's current live (non-deleted) byte footprint: sum of sizes over files
 *  that actually have bytes stored (hash non-null, not oversize). Prefers the
 *  VERIFIED blobs.size (real length recorded at recordBlob) and only falls back to
 *  the client-reported artifact_files.size for a row whose blob isn't stored yet
 *  (pending), so an under-reporting daemon can't creep past the cap. This is the
 *  figure the per-loop storage cap is enforced against. */
export async function loopStoredBytes(loopId: string): Promise<number> {
  const row = (
    await db
      .select({ total: sql<number>`coalesce(sum(coalesce(${blobs.size}, ${artifactFiles.size})), 0)` })
      .from(artifactFiles)
      .leftJoin(blobs, eq(artifactFiles.hash, blobs.hash))
      .where(
        and(
          eq(artifactFiles.loopId, loopId),
          eq(artifactFiles.deleted, false),
          eq(artifactFiles.oversize, false),
          isNotNull(artifactFiles.hash),
        ),
      )
  )[0];
  return Number(row?.total ?? 0);
}

/** The PER-PATH breakdown of loopStoredBytes: each live, byte-backed file row's
 *  counted size (verified blobs.size, falling back to the client-reported
 *  artifact_files.size for a pending row — the exact per-row basis
 *  loopStoredBytes sums). One query per sync so the overwrite "freed" credit
 *  doesn't cost two point queries per manifest file on the ~1.5s flush path. */
export async function liveArtifactSizes(loopId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({ path: artifactFiles.path, size: sql<number | null>`coalesce(${blobs.size}, ${artifactFiles.size})` })
    .from(artifactFiles)
    .leftJoin(blobs, eq(artifactFiles.hash, blobs.hash))
    .where(
      and(
        eq(artifactFiles.loopId, loopId),
        eq(artifactFiles.deleted, false),
        eq(artifactFiles.oversize, false),
        isNotNull(artifactFiles.hash),
      ),
    );
  return new Map(rows.map((r) => [r.path, Number(r.size ?? 0)]));
}

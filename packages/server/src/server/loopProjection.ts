/** Canonical client projections for persisted loops and runs. */
import * as store from "../db/store.js";
import type { ArtifactFile, Loop, Run } from "../db/schema.js";
import type { ArtifactSummary, LoopDetail, LoopFull, LoopSummary, RunSummary } from "../types.js";
import { machinePresence } from "../lib/machinePresence.js";
import { MIN_DAEMON_VERSION, daemonNeedsUpdate } from "../gateway/protocol.js";
import { scheduleFromLoop, statusDefinitionsFromLoop } from "../gateway/loopConfig.js";

const SUMMARY_RUNS = 18;

/** Dashboard order: loops with runs first, most recent run first. The incoming
 * order remains the tie-breaker, so never-run loops keep listLoops' newest-created
 * ordering and equal timestamps do not make cards jump between polls. */
export function sortLoopSummariesByRecentRun(summaries: LoopSummary[]): LoopSummary[] {
  return summaries.toSorted((a, b) => {
    if (a.lastRunTs && b.lastRunTs) return b.lastRunTs.localeCompare(a.lastRunTs);
    if (a.lastRunTs) return -1;
    if (b.lastRunTs) return 1;
    return 0;
  });
}

function nextRun(loop: Loop): string | null {
  return [loop.nextRunAt, loop.nextCadenceAt].filter((v): v is string => v != null).sort()[0] ?? null;
}

export function toRunSummary(r: Run, reconciliation?: "blocking" | "report-only"): RunSummary {
  return {
    id: r.id,
    loopId: r.loopId,
    ts: r.ts,
    phase: r.phase,
    ...(reconciliation ? { reconciliation } : {}),
    requestedBy: r.requestedBy,
    cancelRequested: r.cancelRequestedAt != null,
    agent: r.agent ?? null,
    status: r.status ?? null,
    message: r.message ?? null,
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
    sessionId: r.sessionId ?? null,
    reportIncident: r.reportIncident ?? null,
  };
}

export async function toRunSummaries(loopId: string, rows: Run[]): Promise<RunSummary[]> {
  const states = await store.reconciliationStatesForRuns(loopId, rows.map((run) => run.id));
  return rows.map((run) => toRunSummary(run, states.get(run.id)));
}

/** One live artifact_files row → compact UI metadata. */
export function toArtifactSummary(row: ArtifactFile): ArtifactSummary {
  return {
    path: row.path,
    size: row.size ?? null,
    updatedAt: row.updatedAt,
    binary: row.binary,
    oversize: row.oversize,
  };
}

export async function toLoopSummary(loop: Loop): Promise<LoopSummary> {
  const runs = await toRunSummaries(loop.id, await store.listRuns(loop.id, SUMMARY_RUNS));
  return {
    id: loop.id,
    name: loop.name,
    schedule: scheduleFromLoop(loop),
    workdir: loop.workdir,
    agent: loop.agent,
    model: loop.model ?? null,
    reasoningEffort: loop.reasoningEffort ?? null,
    enabled: loop.enabled,
    nextRun: nextRun(loop),
    running: await store.hasRunningRun(loop.id),
    queued: await store.hasPendingRun(loop.id),
    reconciliationBlocking: runs.some((run) => run.reconciliation === "blocking"),
    lastRunTs: runs.length ? runs[runs.length - 1]!.ts : null,
    deleteRequestedAt: loop.deleteRequestedAt ?? null,
    pauseCause: loop.pauseCause ?? null,
    runs,
    runCount: await store.countRuns(loop.id),
  };
}

function toLoopFull(loop: Loop): LoopFull {
  return {
    id: loop.id,
    name: loop.name,
    schedule: scheduleFromLoop(loop),
    workdir: loop.workdir,
    agent: loop.agent,
    model: loop.model ?? null,
    reasoningEffort: loop.reasoningEffort ?? null,
    prompt: loop.prompt,
    statusDefinitions: statusDefinitionsFromLoop(loop),
    artifacts: loop.artifacts,
    enabled: loop.enabled,
    pauseCause: loop.pauseCause ?? null,
    createdAt: loop.createdAt,
    updatedAt: loop.updatedAt,
  };
}

export async function toLoopDetail(loop: Loop): Promise<LoopDetail> {
  const fullRuns = (await toRunSummaries(loop.id, await store.listRuns(loop.id, 100))).reverse(); // newest first
  const m = await store.getMachine(loop.machineId);
  const presence = machinePresence(m?.online, m?.lastSeen);
  return {
    loop: toLoopFull(loop),
    summary: await toLoopSummary(loop),
    // Presence drives calm asleep-vs-offline copy. Manual work may queue while
    // offline and is claimed after reconnect.
    machine: {
      id: loop.machineId,
      name: m?.name || "",
      online: presence === "online",
      presence,
      lastSeen: m?.lastSeen ?? null,
      daemonProtocol: m?.daemonProtocol ?? null,
      daemonVersion: m?.daemonVersion ?? null,
      needsUpdate: daemonNeedsUpdate(m?.daemonVersion),
      requiredDaemonVersion: MIN_DAEMON_VERSION,
    },
    runs: fullRuns,
  };
}

/**
 * Map the new relational rows (Loop + Run) onto the shapes the UI already
 * renders (JobSummary / JobDetail / RunSummary / JobFull), so the dashboard
 * components stay unchanged while the data now comes from the in-process store.
 */
import * as store from "../db/store.js";
import type { ArtifactFileWithMeta } from "../db/store.js";
import type { Loop, Run } from "../db/schema.js";
import type { ArtifactSummary, JobDetail, JobFull, JobSummary, RunSummary } from "../types.js";
import { machinePresence } from "../lib/machinePresence.js";

const SUMMARY_RUNS = 18;

function nextRun(loop: Loop): string | null {
  return [loop.nextRunAt, loop.nextCadenceAt].filter((v): v is string => v != null).sort()[0] ?? null;
}

export function toRunSummary(r: Run): RunSummary {
  return {
    id: r.id,
    loopId: r.loopId,
    ts: r.ts,
    queued: r.phase === "pending",
    running: r.phase === "running",
    phase: r.phase,
    requestedBy: r.requestedBy,
    canceled: r.phase === "canceled",
    cancelRequested: r.cancelRequestedAt != null,
    role: r.role,
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
    state: (r.state as RunSummary["state"]) ?? null,
    control: (r.control as RunSummary["control"]) ?? null,
    sessionId: r.sessionId ?? null,
    reportIncident: r.reportIncident ?? null,
  };
}

/** One live artifact_files row (with its blob meta joined) → the compact UI shape
 *  (metadata only; the bytes are fetched lazily by getArtifact / the download
 *  route. The front-matter `meta` rides along so the
 *  Files list + calendar can surface type/title/date without a byte fetch. */
export function toArtifactSummary(row: ArtifactFileWithMeta): ArtifactSummary {
  return {
    path: row.path,
    size: row.size ?? null,
    updatedAt: row.updatedAt,
    binary: row.binary,
    oversize: row.oversize,
    meta: row.meta ?? null,
  };
}

export async function toJobSummary(loop: Loop): Promise<JobSummary> {
  const runs = (await store.listRuns(loop.id, SUMMARY_RUNS)).map(toRunSummary);
  return {
    id: loop.id,
    name: loop.name ?? loop.id,
    cron: loop.cron,
    scheduleMode: loop.scheduleMode,
    continuousDelayMinutes: loop.continuousDelayMinutes,
    kind: `exec:${loop.agent}`,
    model: loop.model ?? null,
    reasoningEffort: loop.reasoningEffort ?? null,
    hasUi: !!loop.ui,
    enabled: loop.enabled,
    notify: loop.notify,
    nextRun: nextRun(loop),
    running: await store.hasRunningRun(loop.id),
    queued: await store.hasPendingRun(loop.id),
    lastRunTs: runs.length ? runs[runs.length - 1]!.ts : null,
    graduation: null, // shadow/graduation is post-v1
    goal: loop.goal ?? null,
    completedAt: loop.completedAt ?? null,
    completionReason: loop.completionReason ?? null,
    deleteRequestedAt: loop.deleteRequestedAt ?? null,
    pauseCause: loop.pauseCause ?? null,
    runs,
    runCount: await store.countRuns(loop.id),
  };
}

function toJobFull(loop: Loop): JobFull {
  return {
    id: loop.id,
    name: loop.name ?? undefined,
    cron: loop.cron,
    scheduleMode: loop.scheduleMode,
    continuousDelayMinutes: loop.continuousDelayMinutes,
    enabled: loop.enabled,
    notify: loop.notify,
    goal: loop.goal ?? null,
    completedAt: loop.completedAt ?? null,
    completionReason: loop.completionReason ?? null,
    pauseCause: loop.pauseCause ?? null,
    taskFile: loop.taskFile ?? undefined,
    stateSchema: loop.stateSchema ?? undefined,
    ui: loop.ui ?? undefined,
    channelId: loop.channelId ?? null,
    agent: loop.agent,
    exec: {
      // The coding agent this loop executes with (claude-code | codex).
      // The daemon branches spawn + credentials on this value.
      executor: loop.agent,
      workdir: loop.workdir ?? "",
      model: loop.model ?? undefined,
      reasoningEffort: loop.reasoningEffort ?? undefined,
      allowControl: loop.allowControl,
    },
    createdAt: loop.createdAt,
    updatedAt: loop.updatedAt,
  };
}

export async function toJobDetail(loop: Loop): Promise<JobDetail> {
  const fullRuns = (await store.listRuns(loop.id, 100)).map(toRunSummary).reverse(); // newest first
  const m = await store.getMachine(loop.machineId);
  const presence = machinePresence(m?.online, m?.lastSeen);
  return {
    job: toJobFull(loop),
    summary: await toJobSummary(loop),
    taskFileContent: loop.taskFileContent ?? null, // synced from the machine on each run report
    taskFileSyncedAt: loop.taskFileSyncedAt ?? null,
    // Presence drives calm asleep-vs-offline copy. Manual work may queue while
    // offline and is claimed after reconnect.
    machine: { id: loop.machineId, name: m?.name || "", online: presence === "online", presence, lastSeen: m?.lastSeen ?? null, daemonProtocol: m?.daemonProtocol ?? null },
    runs: fullRuns,
  };
}

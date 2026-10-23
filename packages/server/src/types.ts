import type { MachinePresence } from './lib/machinePresence'

/** Single source for coding agents: server types, the `loops.agent` column enum,
 *  validators, and the dashboard select all derive from this array. The daemon
 *  keeps its own copy in `packages/daemon/src/create.ts`; widen both together. */
export const CODING_AGENTS = ['claude-code', 'codex', 'pi'] as const
export type CodingAgent = (typeof CODING_AGENTS)[number]

export function coerceCodingAgent(value: unknown): CodingAgent | null {
  return typeof value === 'string' && (CODING_AGENTS as readonly string[]).includes(value) ? (value as CodingAgent) : null
}

export type ReportIncidentCode = 'REPORT_INVALID' | 'REPORT_CONFLICT'
export type ReportIncidentFaultDomain = 'daemon' | 'protocol' | 'internal'
export type ReportIncidentDisposition = 'run-error' | 'telemetry-rejected'

/** Durable, client-safe diagnosis for a terminal report the server rejected. */
export interface ReportIncident {
  at: string
  code: ReportIncidentCode
  reason: string
  issues: string[]
  reportId: string
  payloadDigest: string
  faultDomain: ReportIncidentFaultDomain
  recommendedAction: string
}

/** Why a loop is paused. This annotates lifecycle; it is not a new state. */
export type PauseCause =
  | { kind: 'owner'; at: string }
  | { kind: 'failure-streak'; at: string; runId: string; count: number }
  | { kind: 'blocked'; at: string; runId: string }

export type RunStatus = 'ok' | 'block'
export type RunPhase = 'pending' | 'running' | 'done' | 'error' | 'canceled'
export type CronOverlap = 'skip' | 'queue-one'
export type LoopSchedule =
  | { mode: 'cron'; cron: string; timezone: string; overlap: CronOverlap }
  | { mode: 'continuous'; delayMinutes: number }

export const MAX_LOOP_TAGS = 4
export const MAX_LOOP_TAG_LENGTH = 64
export const RESERVED_LOOP_TAGS = ['all loops', 'active', 'paused', 'blocked'] as const

export interface RunSummary {
  id: string
  loopId: string
  /** 1-based history number, as in `pievo log --run <index>`; null while pending. */
  runIndex: number | null
  ts: string
  phase: RunPhase
  /** Interrupted terminal report authority: blocking waits for daemon recovery;
   * report-only no longer fences queued work. */
  reconciliation?: 'blocking' | 'report-only'
  requestedBy?: 'owner' | 'system'
  /** Durable cancellation intent. This is never itself presented as Canceled. */
  cancelRequested?: boolean
  /** Agent captured when this run was claimed; null while pending. */
  agent: CodingAgent | null
  status: RunStatus | null
  message: string | null
  /** Set when the run asked for owner attention; independent of status. */
  attention?: string | null
  durationMs: number | null
  exitCode: number | null
  finalText: string | null
  /** Provider-neutral token usage. Dollar cost is deliberately not stored. */
  usage: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
  } | null
  error: string | null
  sessionId: string | null
  reportIncident?: ReportIncident | null
  /** Why this run's memory edit was not kept. */
  notices?: string[] | null
}

export interface MachineSummary {
  id: string
  name: string
  online: boolean
  lastSeen: string | null
  hostname: string | null
  platform: string | null
  arch: string | null
  /** Daemon package version reported on poll; null before the first poll. */
  daemonVersion: string | null
  /** Breaking daemon/server protocol last observed on poll. */
  daemonProtocol: number | null
  /** Latest published daemon version (cached npm dist-tag `latest`); null when
   *  npm is unreachable. Same for every machine — the web compares it against
   *  `daemonVersion` to show an "upgrade available" hint. */
  latestDaemonVersion: string | null
  needsUpdate: boolean
  requiredDaemonVersion: string
  /** Plaintext device token, so the UI can re-show the connect command. It fully
   *  impersonates the machine. */
  token: string | null
  /** Loops bound to this machine; machine deletion removes them after confirmation. */
  loopCount: number
}

export interface LoopMachineSummary {
  id: string
  name: string
  online: boolean
  presence: MachinePresence
  lastSeen: string | null
}

export interface LoopSummary {
  id: string
  name: string
  tags: string[]
  schedule: LoopSchedule
  workdir: string
  agent: CodingAgent
  model: string | null
  reasoningEffort: string | null
  machine: LoopMachineSummary
  enabled: boolean
  nextRun: string | null
  running?: boolean
  queued?: boolean
  reconciliationBlocking?: boolean
  lastRunTs: string | null
  deleteRequestedAt?: string | null
  pauseCause?: PauseCause | null
  runs: RunSummary[]
  runCount: number
  /** Runs and reported input + output tokens during the trailing seven days. */
  recentUsage: { runCount: number; tokenCount: number }
}

export interface LoopFull {
  id: string
  name: string
  tags: string[]
  schedule: LoopSchedule
  workdir: string
  agent: CodingAgent
  model: string | null
  reasoningEffort: string | null
  prompt: string
  memory: string
  enabled: boolean
  pauseCause?: PauseCause | null
  createdAt?: string
  updatedAt?: string
}

export interface LoopDetail {
  loop: LoopFull
  summary: LoopSummary
  /** The loop's execution machine + its live presence. Offline machines cannot
   *  claim immediately, but manual work remains queued; `presence` distinguishes a calm
   *  "asleep" (recently seen, likely just idle) from a hard "offline", and
   *  `lastSeen` (ISO) feeds the "last seen 3m ago" hint. */
  machine: LoopMachineSummary & { daemonProtocol: number | null; daemonVersion: string | null; needsUpdate: boolean; requiredDaemonVersion: string }
  runs: RunSummary[]
}

export interface LoopPayload {
  name?: string
  tags?: string[]
  schedule?: LoopSchedule
  workdir?: string
  agent?: CodingAgent
  model?: string | null
  reasoningEffort?: string | null
  prompt?: string
  enabled?: boolean
}

export interface MutationResult {
  ok?: boolean
  id?: string
  runId?: string
  queued?: boolean
  coalesced?: boolean
  /** Delete request committed but execution authority still exists. */
  waiting?: boolean
  /** Server-side loop data was removed. Local files are never part of this action. */
  deleted?: boolean
  error?: string
}

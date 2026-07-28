/** Client-safe domain and API shapes shared by the Pievo server and web UI. */

import type { MachinePresence } from './lib/machinePresence'
export type { MachinePresence } from './lib/machinePresence'

/** The coding agent a loop is bound to AND executed with (BYOA on the owner's
 *  machine): `claude-code` → Claude Code, `codex` → `codex exec`.
 *  Non-Claude agents may still have thinner daemon telemetry until stream
 *  integration lands; execution itself is real for every value.
 *
 *  Runtime SINGLE SOURCE (anti-drift): every server consumer DERIVES from this
 *  array — the `CodingAgent` type here, the `db/schema.ts` `CodingAgent` type AND
 *  the `loops.agent` column enum, the edit validator (`coerceCodingAgent`), and the
 *  web agent `<select>` (LoopForm). So widening the set is a one-line edit HERE with
 *  no other server change (the daemon's own enum in `packages/daemon/src/create.ts`
 *  is a separate package, widened alongside). */
export const CODING_AGENTS = ['claude-code', 'codex'] as const
export type CodingAgent = (typeof CODING_AGENTS)[number]

/** Coerce an unknown value to a known `CodingAgent`, or null when unrecognized.
 *  Canonical loop validation and the web agent select share this enum source. */
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

export type RunStatus = 'keep' | 'no-change' | 'block'
export type RunPhase = 'pending' | 'running' | 'done' | 'error' | 'canceled'
export type LoopSchedule =
  | { mode: 'cron'; cron: string; timezone: string; overlap: 'skip' | 'queue-one' }
  | { mode: 'continuous'; delayMinutes: number }
export interface StatusDefinitions {
  keep: string
  noChange: string
  block: string
}

export interface RunSummary {
  /** Run row id — lets the detail view fetch this run's trace directly. */
  id: string
  /** The loop this run belongs to — lets the run-detail view resolve its files. */
  loopId: string
  ts: string
  /** Canonical durable lifecycle state. */
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
}

/** A connected machine (a teammate's daemon) for the Machines panel. */
export interface MachineSummary {
  id: string
  name: string
  online: boolean
  lastSeen: string | null
  /** Daemon-reported identity (captured on connect). */
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
  /** True when this server will not dispatch runs to the machine until its daemon is upgraded. */
  needsUpdate: boolean
  /** Minimum daemon version required before this server will dispatch runs. */
  requiredDaemonVersion: string
  /** Plaintext device token (so the UI can re-show the connect command). Under
   *  the auth gate it is serialized ONLY to the machine's owner — null for
   *  everyone else (the token fully impersonates the machine). */
  token: string | null
  /** Loops bound to this machine — must be 0 before it can be deleted. */
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

/** The final editable loop configuration plus server lifecycle metadata. */
export interface LoopFull {
  id: string
  name: string
  schedule: LoopSchedule
  workdir: string
  agent: CodingAgent
  model: string | null
  reasoningEffort: string | null
  prompt: string
  statusDefinitions: StatusDefinitions
  artifacts: string[]
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
  /** The loop's owning team + whether it is the caller's active team. Present only
   *  when the auth gate is on (open mode has a single workspace, so no chip). Lets
   *  the loop header show which team owns the loop and, when a member opens it from
   *  outside their active team, offer a "switch to this team" affordance. */
  team?: { id: string; name: string; isActive: boolean } | null
  runs: RunSummary[]
}

// ---- exact artifacts: the loop's current synced files ----

/** One live file in a loop's current artifact set (metadata only; bytes are
 *  fetched lazily via getArtifact / the download route). */
export interface ArtifactSummary {
  /** Normalized, loop-folder-relative path. */
  path: string
  /** Byte size (null when unknown). */
  size: number | null
  /** When this file last synced from the machine (ISO). */
  updatedAt: string
  /** The bytes contain a NUL → download-only (no inline text render). */
  binary: boolean
  /** Over the per-file cap → metadata only (no bytes stored; not downloadable). */
  oversize: boolean
}

/** getArtifact result: a text file's decoded content, a marker for a
 *  binary/oversize file (download via the route instead), or an error. */
export type ArtifactContent =
  | { text: string }
  | { binary: true; size: number | null; oversize: boolean }
  | { error: string }

// ---- per-run artifact diff ----

/** One file's change between a run and the previous run. */
export interface RunDiffFile {
  path: string
  status: 'added' | 'modified' | 'removed'
  /** Binary/oversize on either side → no inline diff, just the size delta. */
  binary: boolean
  /** A real text file that exceeds the inline-diff size cap (but is under the
   *  oversize cap) → no inline diff, but it's NOT binary — the UI says "too large
   *  to diff" rather than mislabeling it. */
  tooLarge?: boolean
  /** newSize − oldSize (added ⇒ +newSize, removed ⇒ −oldSize); null when unknown. */
  sizeDelta: number | null
  /** Unified text diff (text files only); absent for binary/oversize/too-large. */
  diff?: string
  /** Bounded callers may omit work before reading blobs or running jsdiff. */
  diffOmitted?: 'input-budget' | 'diff-budget'
  /** Bounded callers clip emitted text without hiding its original size. */
  diffTruncated?: boolean
  diffTotalChars?: number
}

/** getRunDiff result. `hasSnapshot` false ⇒ this run predates the feature
 *  (no recorded manifest) → the UI shows the degrade copy, not an empty diff. */
export interface RunDiffResult {
  hasSnapshot: boolean
  files: RunDiffFile[]
  /** Present for budgeted computation; total changed paths before file limiting. */
  totalFiles?: number
  truncated?: boolean
  truncation?: { files: boolean; inputBytes: boolean; diffChars: boolean }
  work?: { filesProcessed: number; inputBytes: number; emittedDiffChars: number }
}

// ---- canonical loop writes ----

/** The canonical create/edit envelope used by the web and owner CLI. */
export interface LoopPayload {
  name?: string
  schedule?: LoopSchedule
  workdir?: string
  agent?: CodingAgent
  model?: string | null
  reasoningEffort?: string | null
  prompt?: string
  statusDefinitions?: StatusDefinitions
  artifacts?: string[]
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

/** The team switcher's data: the teams this user may view + the active selection. */
export interface TeamsView {
  teams: { id: string; name: string }[]
  /** The active team id. */
  activeTeamId: string
}

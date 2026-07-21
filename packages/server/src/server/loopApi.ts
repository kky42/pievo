/**
 * Server functions backing the dashboard. They run server-side (createServerFn
 * → RPC) and call the IN-PROCESS scheduler + store directly — the scheduler
 * lives in this same TanStack process (booted on first call via ensureServer).
 * The machine-facing endpoints (poll / agent-api / report) are sibling server
 * routes in this same process, so one process owns the single scheduler.
 *
 * Shared workspace (v1): no per-user filtering — every signed-in user sees all
 * loops/machines. `userId` is creator attribution only.
 */
import { createServerFn } from '@tanstack/react-start'

import type {
  ArtifactContent,
  ArtifactSummary,
  CodingAgent,
  JobDetail,
  JobPayload,
  JobSummary,
  MutationResult,
  RunDiffResult,
  RunSummary,
  TeamsView,
  TemplateInfo,
} from '../types'
import { coerceCodingAgent } from '../types'
import * as store from '../db/store.js'
import { canAccessLoop, requestScope } from '../auth.js'
import { ensureServer } from './boot.js'
import { toJobDetail, toJobSummary, toRunSummary } from './adapters.js'
import { normalizeProviderSetting } from '../gateway/validate.js'
import { machinePresence } from '../lib/machinePresence.js'
import { TEMPLATES } from './templates.js'

function backend() {
  return ensureServer()
}

/**
 * Resolve a loop and authorize the request against its owner. Returns the loop,
 * or undefined when it's missing OR (gate on) owned by a different user — callers
 * treat both as "not found" so existence never leaks across users.
 */
async function ownedLoop(id: string) {
  const loop = await store.getLoop(id)
  if (!loop) return undefined
  const scope = await requestScope()
  // Authorize by MEMBERSHIP in the loop's own team (canAccessLoop is the shared
  // gate): a member of the loop's team may open it even when it isn't their active
  // team, so a cross-team link works; a non-member is indistinguishable from a
  // missing loop.
  if (!(await canAccessLoop(loop.teamId, scope))) return undefined
  // Hand back the scope too — callers that mutate (e.g. patchJob) need `enforce`
  // and would otherwise re-run requestScope() (a second session decrypt).
  return { loop, enforce: scope.enforce, teamId: scope.teamId }
}

/** Whether the auth gate is active (a GitHub OAuth app is configured). */
export const getAuthState = createServerFn({ method: 'GET' }).handler(async () => {
  const { authEnabled } = await import('../auth.js')
  return { enabled: authEnabled }
})

/**
 * Client config. `pievoCli` is the CLI invocation prefix the skill + connect
 * dialog use for every verb (`daemon start`, `new`, …) — defaults to the globally
 * installed `pievo`. Set PIEVO_CLI locally to a runnable command that points at the in-repo
 * daemon, e.g. `tsx /abs/packages/daemon/src/cli.ts` or
 * `node /abs/packages/daemon/dist/cli.js`, so loops created from THIS server tell
 * Claude Code to run your local code instead of the registry build.
 */
export const getConfig = createServerFn({ method: 'GET' }).handler(() => {
  const custom = process.env.PIEVO_CLI?.trim()
  return {
    pievoCli: custom || 'pievo',
    /** True when a non-default (dev) CLI is configured — the New-loop paste then
     *  carries an explicit `pievo-cli:` line so Claude Code uses it verbatim. */
    customCli: !!custom,
  }
})

/** GET — the teams this user may view (for the header switcher) + the active
 *  selection. A user gets only their memberships (usually one ⇒ no dropdown).
 *  Open mode ⇒ empty. An explicit `teamId` (the `/t/<id>` route) pins the active
 *  selection for THIS request — so the switcher highlights the tab's own team,
 *  not the cookie's. */
export const listMyTeams = createServerFn({ method: 'GET' })
  .validator((teamId?: string) => teamId)
  .handler(async ({ data: teamId }): Promise<TeamsView> => {
    await backend()
    const { enforce, userId, teamId: active } = await requestScope(teamId)
    if (!enforce || !userId) return { teams: [], activeTeamId: active }
    const teams = (await store.listTeamsForUser(userId)).map((t) => ({
      id: t.id,
      name: t.name,
    }))
    return { teams, activeTeamId: active }
  })

/** GET — whether the caller may view the given dashboard team (`/t/<id>` loader
 *  gate). Enumeration-safe: a team the caller isn't a member of returns false, so
 *  the loader throws the same generic not-found as a missing loop — never
 *  confirming the team exists. Open mode ⇒ always true (single shared workspace). */
export const canViewTeam = createServerFn({ method: 'GET' })
  .validator((teamId: string) => teamId)
  .handler(async ({ data: teamId }): Promise<boolean> => {
    await backend()
    const scope = await requestScope(teamId)
    if (!scope.enforce) return true // open mode: single workspace
    if (!scope.userId) return false // signed out under the gate
    // requestScope honored the requested team ⇒ member; a rejected team fell
    // through to the personal team, so this won't match.
    return scope.teamId === teamId
  })

/** GET — the caller's default dashboard team as an id: the last-used cookie,
 *  validated, else the personal team. Backs the `/` → `/t/<id>` redirect. */
export const getDefaultTeam = createServerFn({ method: 'GET' }).handler(async (): Promise<string> => {
  await backend()
  const scope = await requestScope()
  return scope.teamId
})

/** GET — the signed-in user's loops as compact summaries (newest first).
 *  Gate on ⇒ only the given/active team's loops; open mode ⇒ the full shared list.
 *  An explicit `teamId` (the `/t/<id>` route) scopes this request independent of
 *  the cookie, so different tabs on /t/A and /t/B list different teams at once. */
export const listJobs = createServerFn({ method: 'GET' })
  .validator((teamId?: string) => teamId)
  .handler(async ({ data: teamId }) => {
    await backend()
    const { enforce, userId, teamId: active } = await requestScope(teamId)
    if (enforce && !userId) return [] as JobSummary[]
    // Scope to the resolved active team (open mode ⇒ no team filter, the single
    // shared workspace).
    const loops = (await store.listLoops(enforce ? active : undefined)).sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : -1,
    )
    return (await Promise.all(loops.map(toJobSummary))) as JobSummary[]
  })

/** GET — full detail (job + summary + reversed runs). */
export const getJobDetail = createServerFn({ method: 'GET' })
  .validator((id: string) => id)
  .handler(async ({ data: id }): Promise<JobDetail> => {
    await backend()
    const owned = await ownedLoop(id)
    // Generic, enumeration-safe copy: a nonexistent loop and one in a team the
    // caller can't access return the SAME message (never confirm a loop exists to
    // someone without access).
    if (!owned) throw new Error('This loop does not exist, or you do not have access to it.')
    const detail = await toJobDetail(owned.loop)
    // Team context for the header: which team owns the loop and whether it's the
    // caller's active team. Only under the gate (open mode is a single workspace).
    // When it isn't the active team (a member opened a cross-team link), the header
    // offers a "switch to this team" affordance.
    if (owned.enforce && owned.loop.teamId) {
      const team = await store.getTeam(owned.loop.teamId)
      detail.team = { id: owned.loop.teamId, name: team?.name ?? 'Unknown team', isActive: owned.loop.teamId === owned.teamId }
    }
    return detail
  })

/** GET — one older page of a loop's runs (cursor = `beforeTs`), for the card
 *  timeline's lazy "+N" paging. Chronological (oldest-first), capped. */
export const loadOlderRuns = createServerFn({ method: 'GET' })
  .validator((d: { loopId: string; beforeTs: string; limit?: number }) => d)
  .handler(async ({ data }): Promise<RunSummary[]> => {
    await backend()
    if (!(await ownedLoop(data.loopId))) return []
    const limit = Math.min(Math.max(data.limit ?? 16, 1), 100)
    return (await store.listRunsBefore(data.loopId, data.beforeTs, limit)).map(toRunSummary)
  })

/** GET — the loop's current live-synced files (metadata only; path-sorted). */
export const getArtifacts = createServerFn({ method: 'GET' })
  .validator((d: { loopId: string }) => d)
  .handler(async ({ data }): Promise<ArtifactSummary[]> => {
    await backend()
    if (!(await ownedLoop(data.loopId))) return []
    const { listLoopArtifacts } = await import('./artifactFiles.js')
    return listLoopArtifacts(data.loopId)
  })

/** GET — one artifact's content: decoded text, or a binary/oversize marker the
 *  UI turns into a download link (bytes stream from the /api/artifact route). */
export const getArtifact = createServerFn({ method: 'GET' })
  .validator((d: { loopId: string; path: string }) => d)
  .handler(async ({ data }): Promise<ArtifactContent> => {
    await backend()
    if (!(await ownedLoop(data.loopId))) return { error: 'file not found' }
    const { readLoopArtifact } = await import('./artifactFiles.js')
    return readLoopArtifact(data.loopId, data.path)
  })

/** GET — a run's per-file diff vs the previous run (Phase 3). Lazy by runId like
 *  computed on the server at read time (no stored diffs). Old runs
 *  with no snapshot return `hasSnapshot: false` for the degrade copy. */
export const getRunDiff = createServerFn({ method: 'GET' })
  .validator((d: { runId: string }) => d)
  .handler(async ({ data }): Promise<RunDiffResult> => {
    await backend()
    const run = await store.getRun(data.runId)
    if (!run) return { hasSnapshot: false, files: [] }
    if (!(await ownedLoop(run.loopId))) return { hasSnapshot: false, files: [] }
    const { computeRunDiff } = await import('./runDiff.js')
    return computeRunDiff(data.runId)
  })

// ---- catalog ----

export const listTemplates = createServerFn({ method: 'GET' }).handler((): TemplateInfo[] => {
  // The file-based template registry (server/templates.ts): canned loop intents shown
  // as cards beside "New Loop". Metadata only — the description rides the snippet.
  return TEMPLATES
})

// ---- writes (apply via the live in-process Scheduler) ----

export const patchJob = createServerFn({ method: 'POST' })
  .validator((d: { id: string; patch: JobPayload }) => d)
  .handler(async ({ data }): Promise<MutationResult> => {
    const { scheduler } = await backend()
    const owned = await ownedLoop(data.id)
    if (!owned) return { error: 'not found' }
    const { enforce } = owned
    const p = data.patch
    if (p.scheduleMode !== undefined && p.scheduleMode !== 'cron' && p.scheduleMode !== 'continuous') {
      return { error: 'scheduleMode must be cron|continuous' }
    }
    if (p.continuousDelayMinutes !== undefined && (!Number.isInteger(p.continuousDelayMinutes) || p.continuousDelayMinutes < 1)) {
      return { error: 'continuousDelayMinutes must be an integer >= 1' }
    }
    // A chosen channel must belong to the LOOP's team — not the requester's active
    // team (an admin patching from another team's view, or the All-teams aggregate,
    // would otherwise reject the loop's own valid channels / accept foreign ones).
    if (p.channelId && enforce && (await store.getChannel(p.channelId))?.teamId !== owned.loop.teamId) {
      return { error: 'channel not found' }
    }
    // Enforce the SAME agent enum as the gateway/CLI edit surface via the shared
    // validator: coerce once (null when absent or unrecognized) and only write a
    // known value, so the web surface can't persist an arbitrary agent string.
    const agent = coerceCodingAgent(p.agent)
    const loop = await store.updateLoop(data.id, {
      ...(p.name !== undefined ? { name: p.name.trim() || null } : {}),
      ...(p.cron !== undefined ? { cron: p.cron } : {}),
      ...(p.scheduleMode !== undefined ? { scheduleMode: p.scheduleMode } : {}),
      ...(p.continuousDelayMinutes !== undefined ? { continuousDelayMinutes: p.continuousDelayMinutes } : {}),
      ...(p.notify !== undefined ? { notify: p.notify as 'auto' | 'always' | 'never' } : {}),
      ...(p.channelId !== undefined ? { channelId: p.channelId || null } : {}),
      ...(p.enabled !== undefined ? { enabled: !!p.enabled } : {}),
      ...(agent ? { agent } : {}),
      // Goal set/clear (store.updateLoop enforces the completion-stamp lifecycle:
      // clearing goal or reopening via enabled:true drops the terminal stamps).
      ...(p.goal !== undefined ? { goal: p.goal?.trim() || null } : {}),
      ...(p.taskFile !== undefined ? { taskFile: p.taskFile.trim() || null } : {}),
      ...(p.workflow !== undefined ? { workflow: p.workflow.trim() || null } : {}),
      ...(p.stateSchema !== undefined ? { stateSchema: store.coerceStateSchema(p.stateSchema) ?? null } : {}),
      ...(p.ui !== undefined ? { ui: store.coerceUi(p.ui) ?? null } : {}),
      ...(p.exec?.workdir !== undefined ? { workdir: p.exec.workdir.trim() || null } : {}),
      ...(p.exec?.model !== undefined ? { model: normalizeProviderSetting(p.exec.model) } : {}),
      ...(p.exec?.reasoningEffort !== undefined ? { reasoningEffort: normalizeProviderSetting(p.exec.reasoningEffort) } : {}),
      ...(p.exec?.allowControl !== undefined ? { allowControl: !!p.exec.allowControl } : {}),
    })
    if (!loop) return { error: 'not found' }
    // updateLoop synchronously committed the lifecycle/cadence facts; this only
    // refreshes the in-memory latency hint.
    if (loop.enabled) scheduler.addLoop(loop)
    else scheduler.removeLoop(loop.id)
    return { ok: true }
  })

/** Dedicated lifecycle operations. Dashboard callers never synthesize these
 * transitions with patchJob: each delegates to the loop-locked store operation. */
export const pauseJob = createServerFn({ method: 'POST' })
  .validator((id: string) => id)
  .handler(async ({ data: id }): Promise<MutationResult> => {
    const { scheduler } = await backend()
    if (!(await ownedLoop(id))) return { error: 'not found' }
    const loop = await store.pauseLoop(id)
    if (!loop) return { error: 'not found' }
    scheduler.removeLoop(id)
    return { ok: true }
  })

export const startJob = createServerFn({ method: 'POST' })
  .validator((id: string) => id)
  .handler(async ({ data: id }): Promise<MutationResult> => {
    const { scheduler } = await backend()
    const owned = await ownedLoop(id)
    if (!owned) return { error: 'not found' }
    if (owned.loop.deleteRequestedAt) return { error: 'loop is being deleted' }
    if (owned.loop.completedAt) return { error: 'completed loops must be reopened' }
    const loop = await store.startLoop(id)
    if (!loop) return { error: 'not found' }
    scheduler.addLoop(loop)
    return { ok: true }
  })

export const stopJob = createServerFn({ method: 'POST' })
  .validator((id: string) => id)
  .handler(async ({ data: id }): Promise<MutationResult> => {
    const { scheduler } = await backend()
    const owned = await ownedLoop(id)
    if (!owned) return { error: 'not found' }
    if (await store.hasRunningRun(id)) {
      const machine = await store.getMachine(owned.loop.machineId)
      if (machine?.daemonProtocol !== 2) return { error: 'Daemon upgrade required to stop a running process' }
    }
    const stopped = await store.stopLoop(id)
    if (!stopped) return { error: 'not found' }
    scheduler.removeLoop(id)
    return { ok: true, waiting: !!stopped.running }
  })

/** Delete is one confirmed operation. Reachable machines get the graceful
 * Stop-and-wait path; a machine already offline at click time cannot acknowledge
 * Stop, so retire its execution authority and remove server data immediately.
 * Local files are never touched by either path. */
export const deleteJob = createServerFn({ method: 'POST' })
  .validator((id: string) => id)
  .handler(async ({ data: id }): Promise<MutationResult> => {
    const { scheduler } = await backend()
    const owned = await ownedLoop(id)
    if (!owned) return { error: 'not found' }
    const machine = await store.getMachine(owned.loop.machineId)
    const unreachable = machinePresence(machine?.online, machine?.lastSeen) !== 'online'
    const actor = await requestScope()
    const mayRetireAuthority = !owned.enforce || !!(
      actor.userId && owned.loop.teamId &&
      (await store.getTeamMember(owned.loop.teamId, actor.userId))?.role === 'owner'
    )
    if (!unreachable && await store.hasRunningRun(id) && machine?.daemonProtocol !== 2) {
      return { error: 'Daemon upgrade required to stop a running process' }
    }
    scheduler.removeLoop(id)
    const requested = await store.requestDeleteLoop(id)
    if (!requested) return { error: 'not found' }
    if (unreachable && mayRetireAuthority) {
      const deleted = await store.forceDeleteLoop(id)
      if (!deleted) return { error: 'delete failed; server data was not deleted' }
      const { logger } = await import('../logger.js')
      logger.child({ mod: 'loop-lifecycle' }).warn(
        { action: 'unreachable-delete', loopId: id, actorUserId: actor.userId, machineId: owned.loop.machineId },
        'unreachable-machine delete: retired execution authority and removed server data',
      )
      return { ok: true, deleted: true }
    }
    const deleted = await store.tryDeleteLoop(id)
    return { ok: true, deleted, waiting: !deleted }
  })

const FORCE_DELETE_CONFIRMATION = 'delete-server-data-anyway'

/** Destructive uncertainty escape hatch. Team owners only; the explicit marker
 * is the server-side half of the Dashboard's second confirmation. */
export const forceDeleteJob = createServerFn({ method: 'POST' })
  .validator((d: { id: string; confirmation: string }) => d)
  .handler(async ({ data }): Promise<MutationResult> => {
    const { scheduler } = await backend()
    const owned = await ownedLoop(data.id)
    if (!owned) return { error: 'not found' }
    if (!owned.loop.deleteRequestedAt) return { error: 'delete must be requested first' }
    if (data.confirmation !== FORCE_DELETE_CONFIRMATION) return { error: 'force delete confirmation required' }
    if (owned.enforce) {
      if (!owned.loop.teamId) return { error: 'only a team owner can force delete this loop' }
      const actor = (await requestScope()).userId
      if (!actor || (await store.getTeamMember(owned.loop.teamId, actor))?.role !== 'owner') {
        return { error: 'only a team owner can force delete this loop' }
      }
    }
    scheduler.removeLoop(data.id)
    const deleted = await store.forceDeleteLoop(data.id)
    if (!deleted) return { error: 'force delete failed; server data was not deleted' }
    const { logger } = await import('../logger.js')
    logger.child({ mod: 'loop-lifecycle' }).warn(
      { action: 'force-delete', loopId: data.id, actorUserId: (await requestScope()).userId, machineId: owned.loop.machineId },
      'force-delete: destructive server authority removal',
    )
    return { ok: true, deleted: true }
  })

export const runJob = createServerFn({ method: 'POST' })
  .validator((id: string) => id)
  .handler(async ({ data: id }): Promise<MutationResult> => {
    const { scheduler } = await backend()
    if (!(await ownedLoop(id))) return { error: 'not found' }
    const queued = await scheduler.runNow(id)
    if (!('run' in queued)) return { error: queued.reason }
    return { ok: true, runId: queued.run.id, queued: true, coalesced: queued.state === 'coalesced' }
  })

export const evolveJob = createServerFn({ method: 'POST' })
  .validator((id: string) => id)
  .handler(async ({ data: id }): Promise<MutationResult> => {
    const { scheduler } = await backend()
    const owned = await ownedLoop(id)
    if (!owned) return { error: 'not found' }
    if (!store.canEvolve(owned.loop)) return { error: 'nothing to evolve - add metrics or a workflow first' }
    const queued = await scheduler.evolveNow(id)
    if (!('run' in queued)) return { error: queued.reason }
    return { ok: true, runId: queued.run.id, queued: true, coalesced: queued.state === 'coalesced' }
  })

/** Agent-First edit: durably queue an owner instruction. A pending edit is
 *  updated in place; an edit already running gets one follow-up. */
export const requestEdit = createServerFn({ method: 'POST' })
  .validator((d: { id: string; instruction: string }) => d)
  .handler(async ({ data }): Promise<MutationResult> => {
    const { scheduler } = await backend()
    if (!(await ownedLoop(data.id))) return { error: 'not found' }
    const instruction = data.instruction.trim()
    if (!instruction) return { error: 'describe what to change' }
    const queued = await scheduler.requestEdit(data.id, instruction)
    if (!('run' in queued)) return { error: queued.reason }
    return { ok: true, runId: queued.run.id, queued: true, coalesced: queued.state === 'coalesced' }
  })

/** Dedicated Stop-run operation. Pending work cancels immediately; running work
 * records intent and stays Running until the daemon reports its actual result. */
export const stopRun = createServerFn({ method: 'POST' })
  .validator((id: string) => id)
  .handler(async ({ data: id }): Promise<MutationResult> => {
    await backend()
    const run = await store.getRun(id)
    const owned = run ? await ownedLoop(run.loopId) : undefined
    if (!run || !owned) return { error: 'run not found' }
    if (run.phase === 'running' && (await store.getMachine(owned.loop.machineId))?.daemonProtocol !== 2) {
      return { error: 'Daemon upgrade required to stop a running process' }
    }
    const result = await store.requestRunCancel(run.loopId, id)
    return result ? { ok: true, waiting: result.phase === 'running' } : { error: 'run not found' }
  })

/** Compatibility export for older web chunks; it now has truthful Stop-run semantics. */
export const cancelRun = stopRun

// ---- New-loop claim (capture-from-Claude-Code, no machine picker) ----

/**
 * Mint a fresh claim token for a New-loop dialog. It's shown in the paste
 * snippet and used by Claude Code as (a) this machine's device token if the
 * machine is new, and (b) the loop's `claim` so the dialog can correlate the
 * created loop. No machine row is created here — the daemon self-registers.
 */
export const mintClaim = createServerFn({ method: 'POST' })
  .validator((teamId?: string) => teamId)
  .handler(async ({ data: teamId }): Promise<{ token: string } | { error: string }> => {
    await backend()
    const { mintDeviceToken, rememberConnectKey } = await import('../gateway/tokens.js')
    // Honor the tab's explicit team (the `/t/<id>` dashboard) so a loop captured
    // from team B's dashboard binds to team B even if the cookie's last-used is A.
    const { userId, teamId: active } = await requestScope(teamId)
    const owner = userId ?? 'shared'
    const token = mintDeviceToken()
    // Bind the minter (so the machine that self-registers with this token — and
    // the loop Claude Code creates on it — belongs to the signed-in user) AND the
    // VALIDATED active team (so a loop captured from team B's dashboard lands in
    // team B — one machine can then serve many teams). The team is the VALIDATED
    // scope (explicit tab team or cookie), never the raw client value. Durable: a
    // deploy between mint and paste no longer mis-files the loop.
    await rememberConnectKey(token, { userId: owner, teamId: active })
    return { token }
  })

/** Poll a claim while the New-loop dialog waits for Claude Code to create the loop. */
export const claimStatus = createServerFn({ method: 'GET' })
  .validator((token: string) => token)
  .handler(async ({ data: token }): Promise<{ done: boolean; id?: string; name?: string; agent?: CodingAgent }> => {
    const r = (await backend()).gateway.claimStatus(token)
    return r ? { done: true, id: r.loopId, name: r.name, agent: r.agent } : { done: false }
  })

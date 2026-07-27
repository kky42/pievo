/**
 * Server functions backing the dashboard. They run server-side (createServerFn
 * → RPC) and call the IN-PROCESS scheduler + store directly — the scheduler
 * lives in this same TanStack process (booted on first call via ensureServer).
 * The machine-facing poll, CLI, report, and artifact-sync endpoints are sibling
 * server routes in this same process, so one process owns the single scheduler.
 *
 * Reads and writes are scoped through requestScope/ownedLoop so users only see
 * teams and loops their current session is authorized to access.
 */
import { createServerFn } from '@tanstack/react-start'

import type {
  ArtifactContent,
  ArtifactSummary,
  CodingAgent,
  LoopDetail,
  LoopPayload,
  LoopSummary,
  MutationResult,
  RunDiffResult,
  RunSummary,
  TeamsView,
} from '../types'
import * as store from '../db/store.js'
import { canAccessLoop, requestScope } from '../auth.js'
import { ensureServer } from './boot.js'
import { toLoopDetail, toLoopSummary, toRunSummaries } from './loopProjection.js'
import { validateLoopEdit } from '../gateway/loopConfig.js'
import { machinePresence } from '../lib/machinePresence.js'
import { DAEMON_PROTOCOL_VERSION } from '../gateway/protocol.js'

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
  // Hand back the scope too — callers that mutate (e.g. patchLoop) need `enforce`
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
export const listLoops = createServerFn({ method: 'GET' })
  .validator((teamId?: string) => teamId)
  .handler(async ({ data: teamId }) => {
    await backend()
    const { enforce, userId, teamId: active } = await requestScope(teamId)
    if (enforce && !userId) return [] as LoopSummary[]
    // Scope to the resolved active team (open mode ⇒ no team filter, the single
    // shared workspace).
    const loops = (await store.listLoops(enforce ? active : undefined)).sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : -1,
    )
    return (await Promise.all(loops.map(toLoopSummary))) as LoopSummary[]
  })

/** GET — full detail (loop + summary + reversed runs). */
export const getLoopDetail = createServerFn({ method: 'GET' })
  .validator((id: string) => id)
  .handler(async ({ data: id }): Promise<LoopDetail> => {
    await backend()
    const owned = await ownedLoop(id)
    // Generic, enumeration-safe copy: a nonexistent loop and one in a team the
    // caller can't access return the SAME message (never confirm a loop exists to
    // someone without access).
    if (!owned) throw new Error('This loop does not exist, or you do not have access to it.')
    const detail = await toLoopDetail(owned.loop)
    // Team context for the header: which team owns the loop and whether it's the
    // caller's active team. Only under the gate (open mode is a single workspace).
    // When it isn't the active team (a member opened a cross-team link), the header
    // offers a "switch to this team" affordance.
    if (owned.enforce) {
      const team = await store.getTeam(owned.loop.teamId)
      if (!team) throw new Error(`invariant: loop ${owned.loop.id} references missing team ${owned.loop.teamId}`)
      detail.team = { id: owned.loop.teamId, name: team.name, isActive: owned.loop.teamId === owned.teamId }
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
    return toRunSummaries(data.loopId, await store.listRunsBefore(data.loopId, data.beforeTs, limit))
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

/** GET — a run's per-file diff vs the previous run. Lazy by runId like
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

// ---- writes (apply via the live in-process Scheduler) ----

export const patchLoop = createServerFn({ method: 'POST' })
  .validator((d: { id: string; patch: LoopPayload }) => d)
  .handler(async ({ data }): Promise<MutationResult> => {
    const { scheduler } = await backend()
    const owned = await ownedLoop(data.id)
    if (!owned) return { error: 'not found' }
    const p = data.patch
    {
      const validated = validateLoopEdit(owned.loop, p)
      if (!validated.ok) return { error: validated.detail }
      const loop = await store.updateLoop(data.id, validated.value)
      if (!loop) return { error: 'not found' }
      if (loop.enabled) scheduler.addLoop(loop)
      else scheduler.removeLoop(loop.id)
      return { ok: true }
    }
  })

/** Dedicated lifecycle operations. Dashboard callers never synthesize these
 * transitions with patchLoop: each delegates to the loop-locked store operation. */
export const pauseLoop = createServerFn({ method: 'POST' })
  .validator((id: string) => id)
  .handler(async ({ data: id }): Promise<MutationResult> => {
    const { scheduler } = await backend()
    if (!(await ownedLoop(id))) return { error: 'not found' }
    const loop = await store.pauseLoop(id)
    if (!loop) return { error: 'not found' }
    scheduler.removeLoop(id)
    return { ok: true }
  })

export const startLoop = createServerFn({ method: 'POST' })
  .validator((id: string) => id)
  .handler(async ({ data: id }): Promise<MutationResult> => {
    const { scheduler } = await backend()
    const owned = await ownedLoop(id)
    if (!owned) return { error: 'not found' }
    if (owned.loop.deleteRequestedAt) return { error: 'loop is being deleted' }
    const loop = await store.startLoop(id)
    if (!loop) return { error: 'not found' }
    scheduler.addLoop(loop)
    return { ok: true }
  })

export const stopLoop = createServerFn({ method: 'POST' })
  .validator((id: string) => id)
  .handler(async ({ data: id }): Promise<MutationResult> => {
    const { scheduler } = await backend()
    const owned = await ownedLoop(id)
    if (!owned) return { error: 'not found' }
    if (await store.hasRunningRun(id)) {
      const machine = await store.getMachine(owned.loop.machineId)
      if (machine?.daemonProtocol !== DAEMON_PROTOCOL_VERSION) return { error: 'Daemon upgrade required to stop a running process' }
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
export const deleteLoop = createServerFn({ method: 'POST' })
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
    if (!unreachable && await store.hasRunningRun(id) && machine?.daemonProtocol !== DAEMON_PROTOCOL_VERSION) {
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
export const forceDeleteLoop = createServerFn({ method: 'POST' })
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

export const runLoop = createServerFn({ method: 'POST' })
  .validator((id: string) => id)
  .handler(async ({ data: id }): Promise<MutationResult> => {
    const { scheduler } = await backend()
    if (!(await ownedLoop(id))) return { error: 'not found' }
    const queued = await scheduler.runNow(id)
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
    if (run.phase === 'running' && (await store.getMachine(owned.loop.machineId))?.daemonProtocol !== DAEMON_PROTOCOL_VERSION) {
      return { error: 'Daemon upgrade required to stop a running process' }
    }
    const result = await store.requestRunCancel(run.loopId, id)
    return result ? { ok: true, waiting: result.phase === 'running' } : { error: 'run not found' }
  })

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
    return r
      ? { done: true as const, id: r.loopId, name: r.name, agent: r.agent }
      : { done: false as const }
  })

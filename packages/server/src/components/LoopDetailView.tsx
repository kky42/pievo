import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import type { ChannelSummary, CodingAgent, JobDetail, RunSummary } from '../types'
import { buildSteerPrompt, loopDir } from '../lib/steerPrompt'
import { cronText, dotColor, dotLabel, dur, fmt, rel, tsShort, until } from '../lib/format'
import { mergeRuns } from '../lib/runs'
import { DAEMON_UPGRADE_REQUIRED, daemonStopSupport, deriveLoopLifecycle, lifecycleDisplay } from '../lib/lifecycleUi'
import { setActiveTeamCookie } from '../lib/teamCookie'
import { deleteJob, evolveJob, getJobDetail, loadOlderRuns, patchJob, pauseJob, requestSteer, runJob, startJob, stopJob } from '../server/loopApi'
import { listChannels } from '../server/notifyFns'
import { LoopFilesPanel } from './LoopFilesPanel'
import { LoopForm, type LoopFormHandle } from './LoopForm'
import { MachinesModal } from './MachinesModal'
import { Timeline, WINDOW } from './Timeline'
import { btn, btnCost, btnDanger, btnPrimary, btnQuiet, ErrorBanner, Loading, Pill, Pre, runPulseStyle, sectionHeadCls } from './ui'
import { ConfirmBar, FlashLine, LoadErrorCard, useFlash } from './actionUi'

const AGENT_LABEL: Record<CodingAgent, string> = { 'claude-code': 'Claude Code', codex: 'Codex' }

/** Composer starters - one per editable dimension, so a blank box never stalls
 *  the owner. Clicking seeds the instruction; the agent handles the rest. */
const STEER_SEEDS = [
  { label: 'Change the schedule', seed: 'Change the schedule: ' },
  { label: 'Adjust what it does', seed: 'Change what this loop does: ' },
  { label: 'Improve the dashboard', seed: 'Improve the dashboard: ' },
  { label: 'Set an objective', seed: 'Give this loop a standing objective to optimize toward: ' },
] as const

// The agent-authored dashboard rides in its own lazy chunk (it pulls in
// recharts via LoopChart) - a loop without a `ui` template never loads it.
const LoopView = lazy(() => import('./LoopView').then((m) => ({ default: m.LoopView })))


/**
 * Loop detail PAGE body (`/loops/$loopId`) — the redesign of the former modal.
 * One scrolling page: a loop header (name / status / schedule / agent / machine +
 * the action toolbar), an optional agent-authored dashboard, then a two-column
 * main with the UNIFIED Files panel (the task file alongside synced artifacts) and
 * the Runs timeline (a strip + a clickable list, each run linking to its own
 * detail route). Self-polls while open (fast while a run is live).
 *
 * Editing (2026-07 redesign): the primary path is an INLINE composer below the
 * always-visible action toolbar - the page stays visible, so
 * the owner describes the change while looking at the spec/dashboard it applies
 * to. Dispatch swaps the composer for a live status card under the header
 * (queued → applying → settled with report + files + a link to
 * the steer run); the page keeps polling, so the applied change surfaces around
 * the card. Settings remains a full-page field-form takeover.
 */
export function LoopDetailView({ id }: { id: string }) {
  const navigate = useNavigate()
  const [detail, setDetail] = useState<JobDetail | null>(null)
  const [channels, setChannels] = useState<ChannelSummary[]>([]) // team push channels for the inline picker
  const [err, setErr] = useState<string | null>(null) // fatal load error - replaces the whole view
  const [actionErr, setActionErr] = useState<string | null>(null) // inline action error - never nukes the view
  const [editing, setEditing] = useState(false) // manual field form (LoopForm) - the demoted fallback
  const [steerVia, setSteerVia] = useState(false) // primary: the inline hand-to-your-coding-agent composer
  const [steerInstruction, setSteerInstruction] = useState('')
  const [promptCopied, setPromptCopied] = useState(false) // copy-prompt path: adjust the loop yourself, no dispatch
  const [steerDispatched, setSteerDispatched] = useState(false) // dispatched → the live status card watches the steer run
  const [steerRunId, setSteerRunId] = useState<string | null>(null)
  const steerBoxRef = useRef<HTMLTextAreaElement>(null)
  const [machinesOpen, setMachinesOpen] = useState(false)
  const [pending, setPending] = useState<null | 'run' | 'evolve' | 'save' | 'lifecycle' | 'steer'>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [flash, setFlash] = useFlash()
  const formRef = useRef<LoopFormHandle>(null)
  const deletingRef = useRef(false)

  // Older run pages (lazy) for the timeline strip, mirroring LoopCard.
  const [older, setOlder] = useState<RunSummary[]>([])

  // One fetch for both the initial load and the background poll. Success always
  // clears a prior transient error (so a blip on the initial load can't brick
  // the page while the poll keeps succeeding); only the non-silent initial load
  // surfaces a failure — a silent poll keeps the stale data and the next tick retries.
  const load = useCallback(
    async (silent = false) => {
      try {
        const next = await getJobDetail({ data: id })
        setDetail(next)
        deletingRef.current = next.summary.deleteRequestedAt != null
        setErr(null)
      } catch (e) {
        if (deletingRef.current) navigate({ to: '/' })
        else if (!silent) setErr(String(e))
      }
    },
    [id],
  )

  useEffect(() => {
    setDetail(null)
    setEditing(false)
    setSteerVia(false)
    setSteerInstruction('')
    setPromptCopied(false)
    setSteerDispatched(false)
    setSteerRunId(null)
    setConfirmingDelete(false)
    setOlder([])
    void load()
    void listChannels()
      .then(setChannels)
      .catch(() => {})
  }, [id, load])

  // Self-poll the page (fast while a run is live), but not mid-edit (don't churn
  // the form) or mid-delete (the optimistic tombstone).
  const running = !!detail?.summary.running
  useEffect(() => {
    if (editing) return
    const t = setInterval(() => void load(true), running || deletingRef.current ? 3_000 : 8_000)
    return () => clearInterval(t)
  }, [editing, running, load])

  async function refreshAll() {
    await load()
  }

  async function doRun() {
    setActionErr(null)
    setPending('run')
    try {
      const r = await runJob({ data: id })
      if (r?.error) return setActionErr(`Run failed: ${r.error}`)
      setFlash({ label: r.coalesced ? 'Already queued' : 'Queued', hold: 4000 })
      await refreshAll()
    } finally {
      setPending(null)
    }
  }
  async function doEvolve() {
    setActionErr(null)
    setPending('evolve')
    try {
      const r = await evolveJob({ data: id })
      if (r?.error) return setActionErr(`Evolve failed: ${r.error}`)
      setFlash({ label: r.coalesced ? 'Evolve already queued' : 'Evolve queued', hold: 4000 })
      await refreshAll()
    } finally {
      setPending(null)
    }
  }
  async function doLifecycle(action: 'pause' | 'start' | 'stop' | 'delete') {
    setActionErr(null)
    setPending('lifecycle')
    try {
      const r = action === 'pause' ? await pauseJob({ data: id })
        : action === 'start' ? await startJob({ data: id })
          : action === 'stop' ? await stopJob({ data: id })
            : await deleteJob({ data: id })
      if (r.error) return setActionErr(`${action[0]!.toUpperCase() + action.slice(1)} failed: ${r.error}`)
      setConfirmingDelete(false)
      if (r.deleted) {
        deletingRef.current = false
        navigate({ to: '/' })
        return
      }
      if (action === 'delete') deletingRef.current = true
      await refreshAll()
      setFlash({ label: action === 'start' ? 'Started' : action === 'pause' ? 'Paused' : action === 'stop' ? 'Stop requested' : 'Deleting' })
    } finally {
      setPending(null)
    }
  }
  async function onSave() {
    const payload = formRef.current?.read()
    if (!payload) return
    setActionErr(null)
    setPending('save')
    try {
      const r = await patchJob({ data: { id, patch: payload } })
      if (r.error) return setActionErr(`Save failed: ${r.error}`)
      setEditing(false)
      await refreshAll()
      setFlash({ label: 'Saved' })
    } finally {
      setPending(null)
    }
  }
  async function onRequestSteer() {
    const instruction = steerInstruction.trim()
    if (!instruction) return
    setActionErr(null)
    setPending('steer')
    try {
      const r = await requestSteer({ data: { id, instruction } })
      if (r.error) return setActionErr(`Couldn't queue the steer pass: ${r.error}`)
      setSteerRunId(r.runId ?? null)
      setSteerDispatched(true)
      setSteerVia(false) // composer collapses; the live status card takes over
      setSteerInstruction('')
      await refreshAll()
    } finally {
      setPending(null)
    }
  }

  const backLink = (
    <Link
      to="/"
      className="inline-flex items-center gap-1.5 text-meta font-medium text-secondary transition-colors hover:text-display"
    >
      <span aria-hidden>←</span> Loops
    </Link>
  )

  if (err)
    return (
      <Shell back={backLink}>
        <LoadErrorCard title="Couldn't load this loop." detail={err} onRetry={() => void load()} />
      </Shell>
    )
  if (!detail)
    return (
      <Shell back={backLink}>
        <Loading />
      </Shell>
    )

  const { job, summary: s, runs } = detail
  const hasUi = !!job.ui
  const busy = !!pending
  const online = detail.machine.online
  // A machine recently seen but not currently polling is likely just ASLEEP
  // (calm), vs genuinely offline. Manual requests still queue in either state.
  const asleep = detail.machine.presence === 'asleep'
  const offlineHint = !online
    ? asleep
      ? 'Machine asleep - requests will stay queued until it wakes'
      : 'Machine offline - requests will stay queued until it reconnects'
    : undefined
  const lifecycle = deriveLoopLifecycle(s)
  const lifecycleText = lifecycleDisplay(detail)
  const protocolSupport = daemonStopSupport(detail.machine.daemonProtocol)
  const onMachine = detail.machine.name ? `“${detail.machine.name}”` : 'the bound machine'
  // The dispatched steer run (once the poll surfaces it) drives the status card.
  const steerRun = steerDispatched && steerRunId ? runs.find((r) => r.id === steerRunId) : undefined
  const steerSettled = !!steerRun && !steerRun.queued && !steerRun.running
  const dismissSteer = () => {
    setSteerDispatched(false)
    setSteerRunId(null)
  }
  // The loop's on-disk folder — where the owner runs their own coding agent for
  // the copy-prompt path (null ⇒ generic instruction, no fabricated path).
  const steerDir = loopDir(job.taskFile)
  const copySteerPrompt = async () => {
    try {
      await navigator.clipboard.writeText(buildSteerPrompt({ loopId: id, loopName: s.name, instruction: steerInstruction }))
      setPromptCopied(true)
      setTimeout(() => setPromptCopied(false), 4000)
    } catch {
      setActionErr('Could not copy the prompt - try again or copy it manually.')
    }
  }

  const flashLine = flash && (
    <div className="mb-2.5">
      <FlashLine label={flash.label} tone={flash.tone} onUndo={flash.undo} />
    </div>
  )

  const deleting = lifecycle === 'deleting'
  const paused = !s.enabled && !deleting
  const active = s.enabled && !deleting
  const actionDisabled = busy || deleting
  const canRunWork = active || paused
  const canStop = canRunWork && !!s.running && protocolSupport.supported
  const stopTitle = s.running && !protocolSupport.supported
    ? DAEMON_UPGRADE_REQUIRED
    : !s.running ? 'No run is currently running' : undefined

  const actionBar = (
    <div className="min-w-0">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <button
          className={btnPrimary}
          disabled={actionDisabled || !canRunWork}
          onClick={() => void doRun()}
          title={!canRunWork ? 'Unavailable for a deleting loop' : offlineHint ?? (job.exec ? 'Spends credits' : undefined)}
          aria-label={job.exec ? 'Run once - spends credits' : 'Run once'}
        >
          {pending === 'run' ? 'Queuing…' : 'Run once'}
        </button>
        <button
          className={btn}
          disabled={actionDisabled || !canRunWork}
          title="Dispatch or copy a prompt for an owner-requested steer"
          onClick={() => setSteerVia(true)}
        >
          Steer
        </button>
        <button
          className={btn}
          disabled={actionDisabled || !canRunWork}
          title={!canRunWork ? 'Unavailable for a deleting loop' : offlineHint ?? 'Spends credits'}
          onClick={() => void doEvolve()}
        >
          {pending === 'evolve' ? 'Evolving…' : 'Evolve once'}
        </button>
        <button className={btn} disabled={actionDisabled} onClick={() => setEditing(true)}>Settings</button>
        <button className={btn} disabled={actionDisabled || !paused} onClick={() => void doLifecycle('start')}>Start</button>
        <button className={btn} disabled={actionDisabled || !active} onClick={() => void doLifecycle('pause')}>Pause</button>
        <button className={btnDanger} disabled={actionDisabled || !canStop} title={stopTitle} onClick={() => void doLifecycle('stop')}>Stop</button>
        <button className={btnDanger} disabled={actionDisabled} onClick={() => setConfirmingDelete(true)}>
          {deleting ? 'Deleting…' : 'Delete'}
        </button>
      </div>

      {confirmingDelete && !deleting && (
        <div className="mt-3">
          <ConfirmBar
            prompt="Stop this loop and delete its server data?"
            note="This stops the loop and deletes server history and synced artifacts. Local files are not deleted. If the machine is unreachable, server data is still deleted and its local process may continue running."
            cta="Delete"
            danger
            busy={busy}
            onConfirm={() => void doLifecycle('delete')}
            onCancel={() => setConfirmingDelete(false)}
          />
        </div>
      )}

      {deleting && (
        <div className="mt-3 rounded-md border border-wire bg-raised px-4 py-3 text-meta text-secondary">
          Deleting… graceful stop is waiting for execution authority to end.
        </div>
      )}

      {steerVia && !deleting && (
        <div
          className="mt-4 border-t border-hairline pt-4"
          onKeyDown={(e) => {
            if (e.key === 'Escape' && pending !== 'steer') {
              e.stopPropagation()
              setSteerVia(false)
            }
          }}
        >
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <span className="text-body font-medium text-display">Steer with your coding agent</span>
            <span className="text-meta text-secondary">One agent pass on {onMachine} · spends credits</span>
          </div>
          <textarea
            ref={steerBoxRef}
            autoFocus
            value={steerInstruction}
            onChange={(e) => setSteerInstruction(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && steerInstruction.trim() && pending !== 'steer') void onRequestSteer()
            }}
            rows={3}
            placeholder="e.g. run at 9am on weekdays instead, and also check coffee stock"
            className="mt-3 w-full resize-y rounded-control border border-wire bg-raised p-3 font-mono text-label leading-relaxed text-primary outline-none transition-shadow placeholder:text-disabled focus:border-transparent focus:shadow-focus"
          />
          {!steerInstruction.trim() && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {STEER_SEEDS.map((sd) => (
                <button
                  key={sd.label}
                  type="button"
                  onClick={() => { setSteerInstruction(sd.seed); steerBoxRef.current?.focus() }}
                  className="cursor-pointer rounded-full border border-wire bg-surface px-3 py-1 text-label font-medium text-secondary transition-colors hover:bg-raised hover:text-display"
                >
                  {sd.label}
                </button>
              ))}
            </div>
          )}
          <div className="mt-3.5 flex flex-wrap items-center gap-x-2.5 gap-y-2">
            <button className={btnCost} disabled={pending === 'steer' || !steerInstruction.trim()} title={offlineHint} onClick={() => void onRequestSteer()}>
              {pending === 'steer' ? 'Dispatching…' : 'Dispatch to your coding agent'}
            </button>
            <button type="button" className={btn} disabled={pending === 'steer'} onClick={() => void copySteerPrompt()}>
              {promptCopied ? '✓ Prompt copied' : 'Copy prompt'}
            </button>
            <button className={btn} disabled={pending === 'steer'} onClick={() => setSteerVia(false)}>Cancel</button>
            <span className="hidden text-caption text-disabled sm:inline">⌘↩ dispatch · esc cancel</span>
          </div>
          <div className="mt-2 text-caption leading-snug text-disabled">
            {promptCopied ? (
              <span className="text-secondary">
                ✓ Copied · run your coding agent{' '}
                {steerDir ? <>in <code className="break-all font-mono text-primary">{steerDir}</code></> : "in the loop’s local directory on this machine"}{' '}
                and paste the prompt to adjust the loop yourself.
              </span>
            ) : (
              <>Prefer to adjust it yourself? Copy prompt drops a ready-to-paste prompt for your own coding agent - no dispatch, no credits.</>
            )}
          </div>
        </div>
      )}
    </div>
  )

  const actionErrEl = actionErr && <ErrorBanner message={actionErr} onDismiss={() => setActionErr(null)} className="mb-2.5" />

  // A member can open a loop in a team that isn't their active team (the loop page
  // authorizes by membership, not the active-team cookie). We render it in the
  // loop's own context WITHOUT silently switching the active team; this makes the
  // switch explicit so the dashboard/back-nav can follow if the user wants it.
  const crossTeam = detail.team && !detail.team.isActive ? detail.team : null
  const switchTeam = (teamId: string) => {
    // Persist the last-used default, then open that team's explicit dashboard
    // (`/t/<id>`) — the Phase 2 home for a team, instead of a full reload.
    setActiveTeamCookie(teamId)
    void navigate({ to: '/t/$teamId', params: { teamId } })
  }
  const crossTeamEl = crossTeam && (
    <div className="mb-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-control border border-hairline bg-raised px-4 py-2.5">
      <span className="inline-flex items-center gap-2 text-meta font-medium text-secondary">
        <span aria-hidden className="size-2 rounded-full bg-interactive" />
        Viewing a loop in {crossTeam.name}
      </span>
      <span className="text-meta text-secondary">- not your active team.</span>
      <button
        type="button"
        onClick={() => switchTeam(crossTeam.id)}
        className="ml-auto cursor-pointer text-meta font-medium text-interactive underline underline-offset-2 transition-colors hover:text-display"
      >
        Switch to this team
      </button>
    </div>
  )

  const needsUpdateEl = detail.machine.needsUpdate && (
    <div className="mb-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-control border border-warn/40 bg-warn/10 px-4 py-2.5">
      <span className="inline-flex items-center gap-2 text-meta font-medium text-primary">
        <span aria-hidden className="size-2 rounded-full bg-warn" />
        Daemon update required
      </span>
      <span className="text-meta text-secondary">
        This server requires v{detail.machine.requiredDaemonVersion}; {detail.machine.name ? `“${detail.machine.name}”` : 'the bound machine'} reports {detail.machine.daemonVersion ? `v${detail.machine.daemonVersion}` : 'an unknown version'}. Queued work will wait.
      </span>
      <button
        type="button"
        onClick={() => setMachinesOpen(true)}
        className="ml-auto cursor-pointer text-meta font-medium text-interactive underline underline-offset-2 transition-colors hover:text-display"
      >
        Update daemon
      </button>
    </div>
  )

  const offlineEl = !online && (
    <div className="mb-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-control border border-hairline bg-raised px-4 py-2.5">
      <span className="inline-flex items-center gap-2 text-meta font-medium text-secondary">
        <span aria-hidden className={`size-2 rounded-full ${asleep ? 'bg-rubik-yellow' : 'bg-disabled'}`} />
        Machine {detail.machine.name ? `“${detail.machine.name}” ` : ''}
        {asleep ? 'seems to be asleep or offline' : 'offline'}
      </span>
      <span className="text-meta text-secondary">
        {asleep ? '- queued work starts automatically when it reconnects.' : '- manual run, evolve, and steer requests remain safely queued.'}
        {detail.machine.lastSeen ? ` Last seen ${rel(detail.machine.lastSeen)}.` : ''}
      </span>
      <button
        type="button"
        onClick={() => setMachinesOpen(true)}
        className="ml-auto cursor-pointer text-meta font-medium text-interactive underline underline-offset-2 transition-colors hover:text-display"
      >
        Reconnect
      </button>
    </div>
  )

  // ---- Settings field-form mode ----
  if (editing) {
    return (
      <Shell back={backLink}>
        <EditHead name={s.name} onBack={() => setEditing(false)} />
        <div className="mt-5 rounded-card border border-hairline bg-surface px-6 pb-6 pt-2 shadow-card">
          <LoopForm ref={formRef} initial={job} channels={channels} />
          <div className="mt-7 border-t border-hairline pt-4">
            {actionErrEl}
            <div className="flex flex-wrap gap-2.5">
              <button className={btnPrimary} disabled={pending === 'save'} onClick={onSave}>
                {pending === 'save' ? 'Saving…' : 'Save'}
              </button>
              <button className={btn} disabled={pending === 'save'} onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      </Shell>
    )
  }

  // ---- read mode (the page) ----
  const agentLabel = AGENT_LABEL[job.agent ?? 'claude-code'] ?? job.agent ?? 'Claude Code'
  const modelLabel = job.exec?.model?.trim() || 'default'
  const reasoningEffortLabel = job.exec?.reasoningEffort?.trim() || 'default'
  const newestRun = runs[0]
  const latestIncidentRun = newestRun?.reportIncident ? newestRun : undefined
  const metaDot = <span className="text-wire">·</span>

  return (
    <Shell back={backLink}>
      {/* header */}
      <header className="rounded-card border border-hairline bg-surface px-6 pb-5 pt-[22px] shadow-card">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.015em] text-display">{s.name}</h1>
              <Pill tone={lifecycle === 'stopping' ? 'running' : undefined} dot={lifecycle === 'stopping' ? 'pulse' : undefined}>
                {lifecycleText}
              </Pill>
              {s.queued && lifecycle === 'active' ? <Pill tone="outline">Queued</Pill> : null}
              {s.goal && (
                <Pill tone="success" title={s.goal ?? undefined}>
                  Objective
                </Pill>
              )}
              {/* Which coding agent this loop is recorded against (loops.agent) —
                  a quiet, unobtrusive chip, not a status pill. */}
              <Pill tone="outline" title="Recorded coding agent">
                {agentLabel}
              </Pill>
              <Pill tone="outline" title={`Model: ${modelLabel}`}>
                <span className="max-w-72 truncate">Model: {modelLabel}</span>
              </Pill>
              <Pill tone="outline" title={`Reasoning: ${reasoningEffortLabel}`}>
                <span className="max-w-72 truncate">Reasoning: {reasoningEffortLabel}</span>
              </Pill>
              {/* Cross-team context: this loop belongs to another of your teams,
                  not your active one. A quiet chip; the switch is offered below. */}
              {crossTeam && (
                <Pill tone="outline" title="This loop belongs to another of your teams">
                  {crossTeam.name}
                </Pill>
              )}
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-meta text-secondary">
              <span className="text-primary" title={job.cron}>
                {job.scheduleMode === 'continuous' ? `continuous · ${job.continuousDelayMinutes}m delay` : cronText(job.cron)}
              </span>
              {metaDot}
              <span>next {fmt(s.nextRun)}</span>
              {s.nextRun && s.enabled && <span className="text-disabled">({until(s.nextRun)})</span>}
              {metaDot}
              <span className="inline-flex items-center gap-1.5" title={online ? 'Machine online' : asleep ? 'Machine asleep' : 'Machine offline'}>
                <span className={`size-1.5 rounded-full ${online ? 'bg-rubik-green' : asleep ? 'bg-rubik-yellow' : 'bg-disabled'}`} />
                {detail.machine.name || 'machine'}
              </span>
              {metaDot}
              <span title="Breaking daemon/server lifecycle protocol">{protocolSupport.label}</span>
              {metaDot}
              <code className="font-mono text-label text-disabled">{s.id}</code>
            </div>
            {s.goal && (
              <div className="mt-2 text-body leading-snug text-secondary">
                Working toward: <span className="text-primary">{s.goal}</span>
              </div>
            )}
            {latestIncidentRun?.reportIncident && (
              <div className="mt-2 text-body leading-snug text-secondary">
                {latestIncidentRun.phase === 'error'
                  ? 'Last run failed · Terminal report rejected'
                  : 'Last run telemetry warning · Terminal report rejected'}
              </div>
            )}
          </div>
        </div>

        <div className="mt-5 border-t border-hairline pt-4">
          {crossTeamEl}
          {needsUpdateEl}
          {offlineEl}
          {actionErrEl}
          {flashLine}
          {actionBar}
        </div>
      </header>

      {/* dispatched steer - the live status card (queued → applying → settled).
          The page stays live around it, so the applied change (new schedule,
          rewritten spec, fresh dashboard) surfaces as the card settles. */}
      {steerDispatched && (
        <section
          className="mt-6 rounded-card border border-hairline bg-surface px-6 py-5 shadow-card"
          style={{ animation: 'fadeIn 0.2s ease-out' }}
          aria-live="polite"
        >
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {!steerRun || steerRun.queued ? (
              <span className="inline-flex items-center gap-2.5 text-body text-secondary">
                <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-disabled" />
                <span className="font-medium text-primary">Steer queued</span>
                <span>waiting for {onMachine} and higher-priority work…</span>
              </span>
            ) : steerRun.running ? (
              <span className="inline-flex min-w-0 items-center gap-2.5 text-body text-secondary">
                <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={runPulseStyle} />
                <span className="shrink-0 font-medium text-primary">Applying your steer</span>
              </span>
            ) : (
              <span className="inline-flex min-w-0 items-center gap-2 text-body">
                <span aria-hidden className="size-2.5 shrink-0 rounded-[2px]" style={{ background: dotColor(steerRun) }} />
                <span className="font-medium" style={{ color: dotColor(steerRun) }}>
                  {steerRun.canceled ? 'Steer canceled' : steerRun.phase === 'error' ? 'Steer failed' : 'Steer applied'}
                </span>
                {steerRun.error && <span className="truncate text-secondary">· {steerRun.error}</span>}
              </span>
            )}
            <div className="ml-auto flex items-center gap-3.5">
              {steerRun && (
                <Link
                  to="/loops/$loopId/runs/$runId"
                  params={{ loopId: id, runId: steerRun.id }}
                  className="text-label font-medium text-interactive underline underline-offset-2 transition-colors hover:text-display"
                >
                  View run →
                </Link>
              )}
              <button type="button" onClick={dismissSteer} className={btnQuiet}>
                {steerSettled ? 'Done' : 'Hide'}
              </button>
            </div>
          </div>

          {steerSettled && steerRun.message && (
            <div className="mt-3.5">
              <Pre>{steerRun.message}</Pre>
            </div>
          )}
        </section>
      )}

      {/* agent-authored dashboard (when present) */}
      {hasUi && (
        <section className="mt-6 min-w-0 rounded-card border border-hairline bg-surface px-6 py-5 shadow-card">
          <div className={`mb-3.5 border-b border-hairline pb-1.5 ${sectionHeadCls}`}>Dashboard</div>
          {/* Agent-authored HTML - contain it so an over-wide card row / chart
              scrolls inside the dashboard box rather than widening the whole page;
              a responsive (auto-fit) card grid then wraps within this bounded width. */}
          <div className="min-w-0 overflow-x-auto">
            <Suspense fallback={<Loading className="py-4" />}>
              <LoopView html={job.ui!} runs={runs} loopId={id} taskFile={job.taskFile} />
            </Suspense>
          </div>
        </section>
      )}

      {/* files (unified) + runs - the files panel (its content viewer is the star)
          takes the bulk of the width via a shrinkable minmax(0,1fr) track; runs is
          a capped medium rail that's always visible. `minmax(0,…)` + each child's
          own `min-w-0` keep a wide artifact (or table) from forcing PAGE scroll —
          it scrolls inside its own pane instead. Collapses to one column < lg. */}
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(300px,360px)]">
        <LoopFilesPanel
          loopId={id}
          taskFile={job.taskFile}
          taskFileContent={detail.taskFileContent}
          taskFileSyncedAt={detail.taskFileSyncedAt}
          running={running}
        />
        <RunsSection
          loopId={id}
          summary={s}
          runs={runs}
          older={older}
          onMore={async () => {
            const seed = older.length ? mergeRuns(s.runs ?? [], older) : s.runs ?? []
            const oldest = seed[0]
            if (!oldest) return 0
            const more = await loadOlderRuns({ data: { loopId: id, beforeTs: oldest.ts, limit: WINDOW } })
            if (more.length) setOlder((prev) => mergeRuns(prev, more))
            return more.length
          }}
          onPickRun={(run) => navigate({ to: '/loops/$loopId/runs/$runId', params: { loopId: id, runId: run.id } })}
        />
      </div>

      <MachinesModal open={machinesOpen} onClose={() => setMachinesOpen(false)} />
    </Shell>
  )
}

/**
 * Settings page heading. The field form is an in-page mode takeover (NOT
 * a modal), so this is a plain heading - NOT `ModalHead`, whose Base UI
 * `Dialog.Title`/`Dialog.Close` require a `Dialog.Root` ancestor and throw
 * ("Cannot destructure property 'store' of 'useDialogRootContext(...)'") when
 * rendered on a bare page.
 */
function EditHead({ name, onBack }: { name: string; onBack: () => void }) {
  return (
    <div>
      <button type="button" onClick={onBack} className={btnQuiet}>
        <span aria-hidden>←</span> Back to loop
      </button>
      <h1 className="mt-2.5 text-[24px] font-semibold leading-tight tracking-[-0.015em] text-display">
        Settings · {name}
      </h1>
      <p className="mt-1.5 max-w-[640px] text-meta leading-snug text-secondary">
        Loop configuration, notifications, and push channel, saved directly - no agent pass or credits. For changes in plain words, use
        Steer instead.
      </p>
    </div>
  )
}

/** The page shell — centered column, a back affordance, consistent padding. */
function Shell({ back, children }: { back: React.ReactNode; children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-[1360px] px-8 pb-24 pt-10">
      <div className="mb-5">{back}</div>
      {children}
    </main>
  )
}

/** The runs panel — the signature timeline strip (paged) over a scannable list
 *  of recent runs, each row linking to its own run-detail route. */
function RunsSection({
  loopId,
  summary,
  runs,
  older,
  onMore,
  onPickRun,
}: {
  loopId: string
  summary: JobDetail['summary']
  runs: RunSummary[] // newest-first (for the list)
  older: RunSummary[]
  onMore: () => Promise<number>
  onPickRun: (run: RunSummary) => void
}) {
  // The timeline strip wants chronological (oldest-first) runs; the summary seeds
  // the newest page and `older` grows it leftward, same as a dashboard card.
  const stripRuns = useMemo(
    () => (older.length ? mergeRuns(summary.runs ?? [], older) : summary.runs ?? []),
    [summary.runs, older],
  )

  return (
    <section className="min-w-0">
      <div className="mb-2.5 flex items-end justify-between gap-3 border-b border-hairline pb-1.5">
        <h2 className={sectionHeadCls}>Runs ({summary.runCount})</h2>

      </div>

      {summary.runCount === 0 ? (
        <div className="rounded-card border border-hairline bg-surface px-5 py-10 text-center text-body text-disabled">Never run</div>
      ) : (
        <div className="rounded-card border border-hairline bg-surface px-5 pb-4 pt-5 shadow-card">
          <Timeline job={summary} runs={stripRuns} total={summary.runCount} onLoadMore={onMore} onPickRun={onPickRun} />

          <ul className="mt-5 max-h-[clamp(280px,46vh,520px)] divide-y divide-hairline overflow-y-auto border-t border-hairline">
            {runs.map((x) => (
              <li key={x.id}>
                <Link
                  to="/loops/$loopId/runs/$runId"
                  params={{ loopId, runId: x.id }}
                  className="flex items-start gap-2.5 py-2.5 transition-colors hover:bg-raised"
                >
                  <span
                    className="mt-1 inline-block size-2.5 shrink-0 rounded-[2px]"
                    style={{ background: dotColor(x) }}
                    title={dotLabel(x)}
                    aria-label={dotLabel(x)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="font-mono text-label text-secondary">{tsShort(x.ts)}</span>
                      <span className="shrink-0 font-mono text-caption text-disabled">
                        {dur(x.durationMs)}
                      </span>
                    </span>
                    <span className="mt-0.5 block">
                      {x.queued ? (
                        <span className="inline-flex items-center gap-2 text-meta text-secondary">
                          <span aria-hidden className="size-1.5 rounded-full bg-disabled" />
                          <span>Queued</span>
                        </span>
                      ) : x.running ? (
                        <span className="inline-flex items-center gap-2 text-meta text-secondary">
                          <span aria-hidden className="size-1.5 rounded-full" style={runPulseStyle} />
                          <span>Running</span>
                        </span>
                      ) : x.error ? (
                        <span className="line-clamp-2 text-meta text-secondary">{x.error}</span>
                      ) : (
                        <span className="line-clamp-2 text-meta text-primary">{x.message || dotLabel(x)}</span>
                      )}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

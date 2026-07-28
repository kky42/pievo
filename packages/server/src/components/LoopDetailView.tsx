import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import type { CodingAgent, LoopDetail, RunSummary } from '../types'
import { dotColor, dotLabel, dur, fmt, rel, tsShort, until } from '../lib/format'
import { mergeRuns } from '../lib/runs'
import { DAEMON_UPGRADE_REQUIRED, daemonStopSupport, deriveLoopLifecycle, lifecycleDisplay, lifecyclePresentation } from '../lib/lifecycleUi'
import { setActiveTeamCookie } from '../lib/teamCookie'
import { deleteLoop, getLoopDetail, loadOlderRuns, patchLoop, pauseLoop, runLoop, startLoop, stopLoop } from '../server/loopApi'
import { LoopFilesPanel } from './LoopFilesPanel'
import { LoopForm, type LoopFormHandle } from './LoopForm'
import { MachinesModal } from './MachinesModal'
import { Timeline, WINDOW } from './Timeline'
import { btn, btnDanger, btnPrimary, btnQuiet, ErrorBanner, Loading, Pill, runPulseStyle, sectionHeadCls } from './ui'
import { ConfirmBar, FlashLine, LoadErrorCard, useFlash } from './actionUi'

const AGENT_LABEL: Record<CodingAgent, string> = { 'claude-code': 'Claude Code', codex: 'Codex' }

export function LoopDetailView({ id }: { id: string }) {
  const navigate = useNavigate()
  const [detail, setDetail] = useState<LoopDetail | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [actionErr, setActionErr] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [machinesOpen, setMachinesOpen] = useState(false)
  const [pending, setPending] = useState<null | 'run' | 'save' | 'lifecycle'>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [flash, setFlash] = useFlash()
  const [older, setOlder] = useState<RunSummary[]>([])
  const formRef = useRef<LoopFormHandle>(null)
  const deletingRef = useRef(false)

  const load = useCallback(async (silent = false) => {
    try {
      const next = await getLoopDetail({ data: id })
      setDetail(next)
      deletingRef.current = next.summary.deleteRequestedAt != null
      setErr(null)
    } catch (error) {
      if (deletingRef.current) navigate({ to: '/' })
      else if (!silent) setErr(String(error))
    }
  }, [id])

  useEffect(() => {
    setDetail(null)
    setEditing(false)
    setConfirmingDelete(false)
    setOlder([])
    void load()
  }, [id, load])

  const running = !!detail?.summary.running
  useEffect(() => {
    if (editing) return
    const timer = setInterval(() => void load(true), running || deletingRef.current ? 3_000 : 8_000)
    return () => clearInterval(timer)
  }, [editing, running, load])

  async function doRun() {
    setActionErr(null)
    setPending('run')
    try {
      const result = await runLoop({ data: id })
      if (result.error) return setActionErr(`Run failed: ${result.error}`)
      setFlash({ label: result.coalesced ? 'Already queued' : 'Queued', hold: 4000 })
      await load()
    } finally { setPending(null) }
  }

  async function doLifecycle(action: 'pause' | 'start' | 'stop' | 'delete') {
    setActionErr(null)
    setPending('lifecycle')
    try {
      const result = action === 'pause' ? await pauseLoop({ data: id })
        : action === 'start' ? await startLoop({ data: id })
          : action === 'stop' ? await stopLoop({ data: id })
            : await deleteLoop({ data: id })
      if (result.error) return setActionErr(`${action[0]!.toUpperCase() + action.slice(1)} failed: ${result.error}`)
      setConfirmingDelete(false)
      if (result.deleted) return navigate({ to: '/' })
      if (action === 'delete') deletingRef.current = true
      await load()
      setFlash({ label: action === 'start' ? 'Started' : action === 'pause' ? 'Paused' : action === 'stop' ? 'Stop requested' : 'Deleting' })
    } finally { setPending(null) }
  }

  async function onSave() {
    const patch = formRef.current?.read()
    if (!patch) return
    setActionErr(null)
    setPending('save')
    try {
      const result = await patchLoop({ data: { id, patch } })
      if (result.error) return setActionErr(`Save failed: ${result.error}`)
      setEditing(false)
      await load()
      setFlash({ label: 'Saved' })
    } finally { setPending(null) }
  }

  const back = <Link to="/" className="inline-flex items-center gap-1.5 text-meta font-medium text-secondary hover:text-display"><span aria-hidden>←</span> Loops</Link>
  if (err) return <Shell back={back}><LoadErrorCard title="Couldn't load this loop." detail={err} onRetry={() => void load()} /></Shell>
  if (!detail) return <Shell back={back}><Loading /></Shell>

  const { loop, summary, runs } = detail
  const lifecycle = deriveLoopLifecycle(summary)
  const lifecycleBadge = lifecyclePresentation(summary)
  const deleting = lifecycle === 'deleting'
  const active = summary.enabled && !deleting
  const paused = !summary.enabled && !deleting
  const busy = pending != null
  const stopSupport = daemonStopSupport(detail.machine.daemonProtocol)
  const canStop = !deleting && !!summary.running && stopSupport.supported
  const online = detail.machine.online
  const asleep = detail.machine.presence === 'asleep'
  const crossTeam = detail.team && !detail.team.isActive ? detail.team : null

  if (editing) {
    return (
      <Shell back={back}>
        <EditHead name={summary.name} onBack={() => setEditing(false)} />
        <div className="mt-5 rounded-card border border-hairline bg-surface px-6 pb-6 pt-2 shadow-card">
          <LoopForm ref={formRef} initial={loop} />
          <div className="mt-7 border-t border-hairline pt-4">
            {actionErr && <ErrorBanner message={actionErr} onDismiss={() => setActionErr(null)} className="mb-3" />}
            <div className="flex gap-2.5">
              <button className={btnPrimary} disabled={pending === 'save'} onClick={() => void onSave()}>{pending === 'save' ? 'Saving…' : 'Save'}</button>
              <button className={btn} disabled={pending === 'save'} onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </div>
        </div>
      </Shell>
    )
  }

  const scheduleText = loop.schedule.mode === 'cron'
    ? `${loop.schedule.cron} · ${loop.schedule.timezone} · overlap ${loop.schedule.overlap}`
    : `continuous · ${loop.schedule.delayMinutes}m after terminal`
  const model = loop.model || 'default'
  const effort = loop.reasoningEffort || 'default'

  return (
    <Shell back={back}>
      <header className="rounded-card border border-hairline bg-surface px-6 pb-5 pt-[22px] shadow-card">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.015em] text-display">{summary.name}</h1>
              <Pill tone={lifecycleBadge.tone}>{lifecycleDisplay(detail)}</Pill>
              <Pill tone="outline">{AGENT_LABEL[loop.agent]}</Pill>
              {crossTeam && <Pill tone="outline">{crossTeam.name}</Pill>}
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-meta text-secondary">
              <span className="font-mono text-primary">{scheduleText}</span><span className="text-wire">·</span>
              <span>next {fmt(summary.nextRun)}</span>{summary.nextRun && summary.enabled && <span className="text-disabled">({until(summary.nextRun)})</span>}
              <span className="text-wire">·</span>
              <span className="inline-flex items-center gap-1.5"><span className={`size-1.5 rounded-full ${online ? 'bg-rubik-green' : asleep ? 'bg-rubik-yellow' : 'bg-disabled'}`} />{detail.machine.name || 'machine'}</span>
            </div>
          </div>
        </div>

        <div className="mt-5 border-t border-hairline pt-4">
          {crossTeam && <TeamBanner team={crossTeam} onSwitch={() => { setActiveTeamCookie(crossTeam.id); void navigate({ to: '/t/$teamId', params: { teamId: crossTeam.id } }) }} />}
          {detail.machine.needsUpdate && <MachineBanner tone="warn" text={`Daemon update required · server requires v${detail.machine.requiredDaemonVersion}; machine reports ${detail.machine.daemonVersion ? `v${detail.machine.daemonVersion}` : 'an unknown version'}.`} action="Update daemon" onAction={() => setMachinesOpen(true)} />}
          {!online && <MachineBanner text={`Machine ${asleep ? 'seems asleep or offline' : 'is offline'}; queued work starts when it reconnects.${detail.machine.lastSeen ? ` Last seen ${rel(detail.machine.lastSeen)}.` : ''}`} action="Reconnect" onAction={() => setMachinesOpen(true)} />}
          {actionErr && <ErrorBanner message={actionErr} onDismiss={() => setActionErr(null)} className="mb-2.5" />}
          {flash && <div className="mb-2.5"><FlashLine label={flash.label} tone={flash.tone} onUndo={flash.undo} /></div>}
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <button className={btnPrimary} disabled={busy || deleting} onClick={() => void doRun()}>{pending === 'run' ? 'Queuing…' : 'Run once'}</button>
            <button className={btn} disabled={busy || deleting} onClick={() => setEditing(true)}>Settings</button>
            <button className={btn} disabled={busy || !paused} onClick={() => void doLifecycle('start')}>Start</button>
            <button className={btn} disabled={busy || !active} onClick={() => void doLifecycle('pause')}>Pause</button>
            <button className={btnDanger} disabled={busy || !canStop} title={summary.running && !stopSupport.supported ? DAEMON_UPGRADE_REQUIRED : !summary.running ? 'No run is currently running' : undefined} onClick={() => void doLifecycle('stop')}>Stop</button>
            <button className={btnDanger} disabled={busy || deleting} onClick={() => setConfirmingDelete(true)}>{deleting ? 'Deleting…' : 'Delete'}</button>
          </div>
          {confirmingDelete && !deleting && <div className="mt-3"><ConfirmBar prompt="Stop this loop and delete its server data?" note="This stops the loop and deletes server history and collected artifacts. Files in the working directory are not deleted. If the machine is unreachable, its local process may continue running." cta="Delete" danger busy={busy} onConfirm={() => void doLifecycle('delete')} onCancel={() => setConfirmingDelete(false)} /></div>}
        </div>
      </header>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(300px,360px)]">
        <LoopFilesPanel loopId={id} configuredPaths={loop.artifacts} running={running} />
        <RunsSection loopId={id} summary={summary} runs={runs} older={older} onPickRun={(run) => navigate({ to: '/loops/$loopId/runs/$runId', params: { loopId: id, runId: run.id } })} onMore={async () => {
          const seed = older.length ? mergeRuns(summary.runs, older) : summary.runs
          const oldest = seed[0]
          if (!oldest) return 0
          const more = await loadOlderRuns({ data: { loopId: id, beforeTs: oldest.ts, limit: WINDOW } })
          if (more.length) setOlder((current) => mergeRuns(current, more))
          return more.length
        }} />
      </div>

      <section className="mt-6 min-w-0 rounded-card border border-hairline bg-surface px-6 py-5 shadow-card">
        <h2 className={`mb-4 border-b border-hairline pb-1.5 ${sectionHeadCls}`}>Configuration</h2>
        <dl className="grid min-w-0 gap-x-6 gap-y-4 md:grid-cols-[180px_minmax(0,1fr)]">
          <Config label="Schedule"><code className="break-all font-mono">{scheduleText}</code></Config>
          <Config label="Working directory"><code className="break-all font-mono">{loop.workdir}</code></Config>
          <Config label="Agent">{AGENT_LABEL[loop.agent]}</Config>
          <Config label="Model / effort">{model} / {effort}</Config>
          <Config label="Prompt"><pre className="whitespace-pre-wrap break-words font-sans">{loop.prompt}</pre></Config>
          <Config label="Status definitions"><ul className="space-y-1"><li><b>keep:</b> {loop.statusDefinitions.keep}</li><li><b>no-change:</b> {loop.statusDefinitions.noChange}</li><li><b>block:</b> {loop.statusDefinitions.block}</li></ul></Config>
          <Config label="Artifact paths">{loop.artifacts.length ? <ul className="space-y-1">{loop.artifacts.map((path) => <li key={path}><code className="break-all font-mono">{path}</code></li>)}</ul> : <span className="text-disabled">None</span>}</Config>
        </dl>
      </section>

      <MachinesModal open={machinesOpen} onClose={() => setMachinesOpen(false)} />
    </Shell>
  )
}

function Config({ label, children }: { label: string; children: React.ReactNode }) {
  return <><dt className="text-label font-medium text-secondary">{label}</dt><dd className="min-w-0 text-body text-primary">{children}</dd></>
}

function TeamBanner({ team, onSwitch }: { team: { name: string }; onSwitch: () => void }) {
  return <div className="mb-2.5 flex flex-wrap items-center gap-3 rounded-control border border-hairline bg-raised px-4 py-2.5 text-meta text-secondary"><span>Viewing a loop in {team.name} - not your active team.</span><button onClick={onSwitch} className="ml-auto font-medium text-interactive underline">Switch to this team</button></div>
}

function MachineBanner({ text, action, onAction, tone }: { text: string; action: string; onAction: () => void; tone?: 'warn' }) {
  return <div className={`mb-2.5 flex flex-wrap items-center gap-3 rounded-control border px-4 py-2.5 text-meta ${tone === 'warn' ? 'border-warn/40 bg-warn/10' : 'border-hairline bg-raised'}`}><span className="text-secondary">{text}</span><button onClick={onAction} className="ml-auto font-medium text-interactive underline">{action}</button></div>
}

function EditHead({ name, onBack }: { name: string; onBack: () => void }) {
  return <div><button type="button" onClick={onBack} className={btnQuiet}><span aria-hidden>←</span> Back to loop</button><h1 className="mt-2.5 text-[24px] font-semibold text-display">Settings · {name}</h1><p className="mt-1.5 text-meta text-secondary">Edit the stored schedule, execution settings, prompt, status definitions, and exact artifact paths.</p></div>
}

function Shell({ back, children }: { back: React.ReactNode; children: React.ReactNode }) {
  return <main className="mx-auto max-w-[1360px] px-8 pb-24 pt-10"><div className="mb-5">{back}</div>{children}</main>
}

function RunsSection({ loopId, summary, runs, older, onMore, onPickRun }: { loopId: string; summary: LoopDetail['summary']; runs: RunSummary[]; older: RunSummary[]; onMore: () => Promise<number>; onPickRun: (run: RunSummary) => void }) {
  const stripRuns = useMemo(() => older.length ? mergeRuns(summary.runs, older) : summary.runs, [summary.runs, older])
  return (
    <section className="min-w-0">
      <div className="mb-2.5 border-b border-hairline pb-1.5"><h2 className={sectionHeadCls}>Runs ({summary.runCount})</h2></div>
      {summary.runCount === 0 ? <div className="rounded-card border border-hairline bg-surface px-5 py-10 text-center text-body text-disabled">Never run</div> : (
        <div className="rounded-card border border-hairline bg-surface px-5 pb-4 pt-5 shadow-card">
          <Timeline loop={summary} runs={stripRuns} total={summary.runCount} onLoadMore={onMore} onPickRun={onPickRun} />
          <ul className="mt-5 max-h-[clamp(280px,46vh,520px)] divide-y divide-hairline overflow-y-auto border-t border-hairline">
            {runs.map((run) => <li key={run.id}><Link to="/loops/$loopId/runs/$runId" params={{ loopId, runId: run.id }} className="flex items-start gap-2.5 py-2.5 hover:bg-raised"><span className="mt-1 inline-block size-2.5 shrink-0 rounded-[2px]" style={{ background: dotColor(run) }} title={dotLabel(run)} /><span className="min-w-0 flex-1"><span className="flex justify-between gap-2"><span className="font-mono text-label text-secondary">{tsShort(run.ts)}</span><span className="font-mono text-caption text-disabled">{dur(run.durationMs)}</span></span><span className="mt-0.5 block line-clamp-2 text-meta text-primary">{run.phase === 'pending' ? 'Queued' : run.phase === 'running' ? <span className="inline-flex items-center gap-2"><span className="size-1.5 rounded-full" style={runPulseStyle} />Running</span> : run.error || run.message || dotLabel(run)}</span></span></Link></li>)}
          </ul>
        </div>
      )}
    </section>
  )
}

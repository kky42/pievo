import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import type { CodingAgent, LoopDetail, RunSummary } from '../types'
import { attentionOf, dotLabel, rel, runSwatch, scheduleText, tsShort } from '../lib/format'
import { mergeRuns } from '../lib/runs'
import { DAEMON_UPGRADE_REQUIRED, daemonStopSupport, deriveLoopLifecycle } from '../lib/lifecycleUi'
import { deleteLoop, getLoopDetail, loadOlderRuns, patchLoop, pauseLoop, runLoop, startLoop, stopLoop } from '../server/loopApi'
import { LoopForm, type LoopFormHandle } from './LoopForm'
import { LoopOverview } from './LoopOverview'
import { MachinesModal } from './MachinesModal'
import { MemoryPanel } from './MemoryPanel'
import { WINDOW } from './Timeline'
import { btn, btnDanger, btnPrimary, btnQuiet, ErrorBanner, Loading, sectionHeadCls, useHydrated } from './ui'
import { ConfirmBar, FlashLine, LoadErrorCard, useFlash } from './actionUi'

const AGENT_LABEL: Record<CodingAgent, string> = { 'claude-code': 'Claude Code', codex: 'Codex', pi: 'Pi' }

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
  const deleting = lifecycle === 'deleting'
  const active = summary.enabled && !deleting
  const paused = !summary.enabled && !deleting
  const busy = pending != null
  const stopSupport = daemonStopSupport(detail.machine.daemonProtocol)
  const canStop = !deleting && !!summary.running && stopSupport.supported
  const online = detail.machine.online
  const asleep = detail.machine.presence === 'asleep'

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

  const configurationScheduleText = loop.schedule.mode === 'cron'
    ? `${loop.schedule.cron} · ${loop.schedule.timezone} · overlap ${loop.schedule.overlap}`
    : `continuous · ${loop.schedule.delayMinutes}m after terminal`
  const model = loop.model || 'default'
  const effort = loop.reasoningEffort || 'default'
  const overviewRuns = older.length ? mergeRuns(summary.runs, older) : summary.runs
  const loadMore = async (): Promise<number> => {
    const oldest = overviewRuns[0]
    if (!oldest) return 0
    const more = await loadOlderRuns({ data: { loopId: id, beforeTs: oldest.ts, limit: WINDOW } })
    if (more.length) setOlder((current) => mergeRuns(current, more))
    return more.length
  }

  return (
    <Shell back={back}>
      <header className="rounded-card border border-hairline bg-surface px-[26px] pb-5 pt-[22px] shadow-card">
        <LoopOverview
          loop={summary}
          runs={overviewRuns}
          onLoadMore={loadMore}
          onPickRun={(run) => navigate({ to: '/loops/$loopId/runs/$runId', params: { loopId: id, runId: run.id } })}
        />

        <div className="mt-5 border-t border-hairline pt-4">
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
          {confirmingDelete && !deleting && <div className="mt-3"><ConfirmBar prompt="Stop this loop and delete its server data?" note="This stops the loop and deletes its server history and memory. Files in the working directory are not deleted. If the machine is unreachable, its local process may continue running." cta="Delete" danger busy={busy} onConfirm={() => void doLifecycle('delete')} onCancel={() => setConfirmingDelete(false)} /></div>}
        </div>
      </header>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(300px,420px)]">
        <Highlights loopId={id} runs={runs} />
        <MemoryPanel loopId={id} memory={loop.memory} onSaved={() => load(true)} />
      </div>

      <details className="group mt-6 min-w-0 rounded-card border border-hairline bg-surface px-6 py-4 shadow-card">
        <summary className={`flex cursor-pointer select-none items-center gap-2 marker:content-[''] ${sectionHeadCls}`}>
          <span aria-hidden className="text-micro text-disabled transition-transform group-open:rotate-90">▸</span>
          Configuration
          <span className="ml-2 truncate font-normal text-disabled">{scheduleText(loop.schedule)} · {AGENT_LABEL[loop.agent]}</span>
        </summary>
        <dl className="mt-4 grid min-w-0 gap-x-6 gap-y-4 border-t border-hairline pt-4 md:grid-cols-[180px_minmax(0,1fr)]">
          <Config label="Schedule"><code className="break-all font-mono">{configurationScheduleText}</code></Config>
          <Config label="Tags">{loop.tags.length ? <div className="flex flex-wrap gap-1.5">{loop.tags.map((tag) => <span key={tag} className="inline-flex h-[22px] max-w-52 items-center truncate rounded-full bg-raised px-2.5 text-caption font-medium text-secondary" title={tag}>{tag}</span>)}</div> : <span className="text-disabled">None</span>}</Config>
          <Config label="Working directory"><code className="break-all font-mono">{loop.workdir}</code></Config>
          <Config label="Agent">{AGENT_LABEL[loop.agent]}</Config>
          <Config label="Model / effort">{model} / {effort}</Config>
          <Config label="Prompt"><pre className="whitespace-pre-wrap break-words font-sans">{loop.prompt}</pre></Config>
        </dl>
      </details>

      <MachinesModal open={machinesOpen} onClose={() => setMachinesOpen(false)} />
    </Shell>
  )
}

function Config({ label, children }: { label: string; children: React.ReactNode }) {
  return <><dt className="text-label font-medium text-secondary">{label}</dt><dd className="min-w-0 text-body text-primary">{children}</dd></>
}

function MachineBanner({ text, action, onAction, tone }: { text: string; action: string; onAction: () => void; tone?: 'warn' }) {
  return <div className={`mb-2.5 flex flex-wrap items-center gap-3 rounded-control border px-4 py-2.5 text-meta ${tone === 'warn' ? 'border-warn/40 bg-warn/10' : 'border-hairline bg-raised'}`}><span className="text-secondary">{text}</span><button onClick={onAction} className="ml-auto font-medium text-interactive underline">{action}</button></div>
}

function EditHead({ name, onBack }: { name: string; onBack: () => void }) {
  return <div><button type="button" onClick={onBack} className={btnQuiet}><span aria-hidden>←</span> Back to loop</button><h1 className="mt-2.5 text-[24px] font-semibold text-display">Settings · {name}</h1><p className="mt-1.5 text-meta text-secondary">Edit tags, schedule, execution settings, and prompt.</p></div>
}

function Shell({ back, children }: { back: React.ReactNode; children: React.ReactNode }) {
  return <main className="mx-auto max-w-[1360px] px-8 pb-24 pt-10"><div className="mb-5">{back}</div>{children}</main>
}

/** Runs worth the owner's time: attention, block, and errors. Routine ok runs
 *  live only on the timeline. */
function Highlights({ loopId, runs }: { loopId: string; runs: RunSummary[] }) {
  const hydrated = useHydrated()
  const notable = runs.filter((run) => attentionOf(run) || run.status === 'block' || run.phase === 'error').slice(0, 30)
  return (
    <section className="min-w-0">
      <div className="mb-2.5 border-b border-hairline pb-1.5"><h2 className={sectionHeadCls}>Highlights</h2></div>
      {notable.length === 0 ? (
        <div className="rounded-card border border-hairline bg-surface px-5 py-10 text-center text-body text-disabled shadow-card">Nothing needs you yet. Routine runs stay on the timeline.</div>
      ) : (
        <ul className="divide-y divide-hairline overflow-hidden rounded-card border border-hairline bg-surface shadow-card">
          {notable.map((run) => {
            const attention = attentionOf(run)
            return (
              <li key={run.id}>
                <Link to="/loops/$loopId/runs/$runId" params={{ loopId, runId: run.id }} className="flex items-start gap-3 px-5 py-3 hover:bg-raised">
                  <span className="mt-[3px] inline-block size-2.5 shrink-0 rounded-[3px]" style={runSwatch(run)} title={dotLabel(run)} />
                  <span className="min-w-0 flex-1">
                    <span className={`block break-words text-body ${attention ? 'font-medium text-attention' : 'text-primary'}`}>
                      {attention ?? (run.phase === 'error' ? run.error : run.message?.split('\n')[0]) ?? dotLabel(run)}
                    </span>
                    <span className="mt-0.5 block font-mono text-caption text-disabled">#{run.runIndex} · {hydrated ? tsShort(run.ts) : ''}</span>
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

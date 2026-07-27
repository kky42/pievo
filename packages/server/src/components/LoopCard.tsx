import { useMemo, useState } from 'react'
import type { LoopSummary, RunSummary } from '../types'
import { cronText, dotLabel, lastRunOf, rel } from '../lib/format'
import { mergeRuns } from '../lib/runs'
import { deriveLoopLifecycle } from '../lib/lifecycleUi'
import { loadOlderRuns } from '../server/loopApi'
import { Timeline, WINDOW } from './Timeline'
import { Pill, useHydrated } from './ui'

export function LoopCard({
  loop,
  onOpen,
  onPickRun,
}: {
  loop: LoopSummary
  onOpen: (id: string) => void
  onPickRun: (id: string, run: RunSummary) => void
}) {
  const en = loop.enabled
  const last = lastRunOf(loop)
  const lifecycle = deriveLoopLifecycle(loop)
  const hydrated = useHydrated()

  // The loader seeds `loop.runs` with the newest page; we lazily fetch OLDER
  // pages on demand and keep them here. The merged list (loop's fresh newest page
  // wins on overlap, so live status updates survive a poll) is what the timeline
  // renders. `older` are strictly before the newest page, so no holes form.
  const [older, setOlder] = useState<RunSummary[]>([])
  // Common case (never paged): no older runs, so skip the merge entirely — this
  // runs on every poll for every card.
  const runs = useMemo(
    () => (older.length ? mergeRuns(loop.runs ?? [], older) : (loop.runs ?? [])),
    [loop.runs, older],
  )
  const newestRun = runs.at(-1)
  const latestIncidentRun = newestRun?.reportIncident ? newestRun : undefined

  const loadMore = async (): Promise<number> => {
    const oldest = runs[0]
    if (!oldest) return 0
    const more = await loadOlderRuns({ data: { loopId: loop.id, beforeTs: oldest.ts, limit: WINDOW } })
    if (more.length) setOlder((prev) => mergeRuns(prev, more))
    return more.length
  }

  // The whole card is a mouse hit-area (convenience), but the keyboard/screen-
  // reader entry point is the real <button> around the title — so we never nest
  // a button inside a button (the timeline's run blocks are buttons too).
  return (
    <div
      onClick={() => onOpen(loop.id)}
      className={`mb-[18px] cursor-pointer rounded-card border border-hairline bg-surface px-[26px] pb-5 pt-[22px] shadow-card transition-colors hover:border-wire ${
        en || latestIncidentRun?.reportIncident || loop.pauseCause?.kind === 'failure-streak' || loop.pauseCause?.kind === 'blocked' ? '' : 'opacity-60'
      }`}
      style={{ animation: 'fadeIn .25s cubic-bezier(0.25,0.1,0.25,1) both' }}
    >
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onOpen(loop.id)
          }}
          className="cursor-pointer rounded-sm text-left text-[17px] font-semibold tracking-[-0.01em] text-display outline-none focus-visible:ring-2 focus-visible:ring-interactive focus-visible:ring-offset-4 focus-visible:ring-offset-surface"
        >
          {loop.name}
        </button>
        {lifecycle === 'stopping' ? (
          <Pill tone="running" dot="pulse">Stopping</Pill>
        ) : lifecycle === 'paused-finishing' ? (
          <Pill>{loop.pauseCause?.kind === 'blocked' ? 'Paused — blocked · current run finishing' : loop.pauseCause?.kind === 'owner' ? 'Paused by owner · current run finishing' : 'Paused · current run finishing'}</Pill>
        ) : lifecycle === 'deleting' ? (
          <Pill>Deleting</Pill>
        ) : loop.running ? (
          <Pill tone="running" dot="pulse">Running</Pill>
        ) : loop.queued && loop.reconciliationBlocking ? (
          <Pill tone="outline">Queued · waiting for machine recovery</Pill>
        ) : loop.queued ? (
          <Pill tone="outline">Queued</Pill>
        ) : null}
        {lifecycle === 'paused' && (
          <Pill tone={loop.pauseCause?.kind === 'blocked' ? 'accent' : undefined}>{loop.pauseCause?.kind === 'blocked' ? 'Paused — blocked' : loop.pauseCause?.kind === 'failure-streak' ? 'Paused automatically' : loop.pauseCause?.kind === 'owner' ? 'Paused by owner' : 'Paused'}</Pill>
        )}
        <div className="ml-auto min-w-0 text-right text-meta text-secondary">
          <div className="whitespace-nowrap">
            <span className="text-primary" title={loop.schedule.mode === 'cron' ? loop.schedule.cron : undefined}>
              {loop.schedule.mode === 'continuous'
                ? `continuous · ${loop.schedule.delayMinutes}m`
                : `${cronText(loop.schedule.cron)} · ${loop.schedule.timezone} · ${loop.schedule.overlap}`}
            </span>
            <span className="mx-2.5 text-wire">·</span>
            {loop.agent}
          </div>
          <div className="mt-1 truncate text-caption text-disabled" title={loop.workdir}>
            {loop.workdir} · Model: {loop.model || 'default'} · Reasoning: {loop.reasoningEffort || 'default'}
          </div>
        </div>
      </div>

      <Timeline
        loop={loop}
        runs={runs}
        total={loop.runCount}
        onLoadMore={loadMore}
        onPickRun={(run) => onPickRun(loop.id, run)}
      />

      <div className="mt-[18px] flex items-center gap-2 text-label text-secondary">
        <span>{loop.runCount} runs</span>
        {last && (
          <span>
            · last {dotLabel(last)}
            {hydrated && ` · ${rel(last.ts)}`}
          </span>
        )}
      </div>

      {latestIncidentRun?.reportIncident && (
        <div className="mt-1.5 text-label text-secondary">
          {latestIncidentRun.phase === 'error' ? 'Last run failed · Terminal report rejected' : 'Last run telemetry warning · Terminal report rejected'}
        </div>
      )}

    </div>
  )
}

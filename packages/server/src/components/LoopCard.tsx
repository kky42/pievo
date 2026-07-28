import { useMemo, useState } from 'react'
import type { LoopSummary, RunSummary } from '../types'
import { mergeRuns } from '../lib/runs'
import { loadOlderRuns } from '../server/loopApi'
import { LoopOverview } from './LoopOverview'
import { WINDOW } from './Timeline'

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
      <LoopOverview
        loop={loop}
        runs={runs}
        onLoadMore={loadMore}
        onPickRun={(run) => onPickRun(loop.id, run)}
        onOpen={() => onOpen(loop.id)}
      />
    </div>
  )
}

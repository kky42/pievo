import type { CodingAgent, LoopSummary, RunSummary } from '../types'
import { dotLabel, lastRunOf, rel } from '../lib/format'
import { lifecyclePresentation } from '../lib/lifecycleUi'
import { LoopMeta } from './LoopMeta'
import { Timeline } from './Timeline'
import { Pill, useHydrated } from './ui'

const AGENT_LABEL: Record<CodingAgent, string> = { 'claude-code': 'Claude Code', codex: 'Codex' }
const titleCls = 'rounded-sm text-left text-[17px] font-semibold tracking-[-0.01em] text-display outline-none'

/** The shared loop summary shown on both the dashboard and loop detail page. */
export function LoopOverview({
  loop,
  runs,
  onLoadMore,
  onPickRun,
  onOpen,
  extraPill,
}: {
  loop: LoopSummary
  runs: RunSummary[]
  onLoadMore: () => Promise<number>
  onPickRun: (run: RunSummary) => void
  onOpen?: () => void
  extraPill?: React.ReactNode
}) {
  const last = lastRunOf({ ...loop, runs })
  const lifecycle = lifecyclePresentation(loop)
  const hydrated = useHydrated()
  const newestRun = runs.at(-1)
  const latestIncidentRun = newestRun?.reportIncident ? newestRun : undefined

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        {onOpen ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              onOpen()
            }}
            className={`${titleCls} cursor-pointer focus-visible:ring-2 focus-visible:ring-interactive focus-visible:ring-offset-4 focus-visible:ring-offset-surface`}
          >
            {loop.name}
          </button>
        ) : (
          <h1 className={titleCls}>{loop.name}</h1>
        )}
        <Pill tone={lifecycle.tone}>{lifecycle.label}</Pill>
        <Pill tone="outline">{AGENT_LABEL[loop.agent]}</Pill>
        {extraPill}
        <div className="ml-auto min-w-0">
          <LoopMeta
            schedule={loop.schedule}
            nextRun={loop.nextRun}
            enabled={loop.enabled}
            machine={loop.machine}
            workdir={loop.workdir}
            model={loop.model}
            reasoningEffort={loop.reasoningEffort}
          />
        </div>
      </div>

      <Timeline
        loop={loop}
        runs={runs}
        total={loop.runCount}
        onLoadMore={onLoadMore}
        onPickRun={onPickRun}
      />

      <div className="mt-[18px] flex items-center gap-2 text-meta text-secondary">
        <span>{loop.runCount} runs</span>
        {last && (
          <span>
            · last {dotLabel(last)}
            {hydrated && ` · ${rel(last.ts)}`}
          </span>
        )}
      </div>

      {latestIncidentRun?.reportIncident && (
        <div className="mt-1.5 text-meta text-secondary">
          {latestIncidentRun.phase === 'error' ? 'Last run failed · Terminal report rejected' : 'Last run telemetry warning · Terminal report rejected'}
        </div>
      )}
    </>
  )
}

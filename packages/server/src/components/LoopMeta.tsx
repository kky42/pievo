import type { LoopMachineSummary, LoopSchedule } from '../types'
import { scheduleText } from '../lib/format'

export function LoopMeta({
  schedule,
  machine,
  workdir,
  model,
  reasoningEffort,
}: {
  schedule: LoopSchedule
  machine: LoopMachineSummary
  workdir: string
  model: string | null
  reasoningEffort: string | null
}) {
  return (
    <div className="min-w-0 text-right text-meta text-secondary">
      <div className="flex flex-wrap items-center justify-end gap-x-2.5 gap-y-1">
        <span title={schedule.mode === 'cron' ? schedule.cron : undefined}>{scheduleText(schedule)}</span>
        <span className="text-wire">·</span>
        <span className="inline-flex items-center gap-1.5" title={`${machine.name || 'machine'} · ${machine.presence}`}>
          <span className={`size-1.5 rounded-full ${machine.presence === 'online' ? 'bg-rubik-green' : machine.presence === 'asleep' ? 'bg-rubik-yellow' : 'bg-disabled'}`} aria-hidden="true" />
          {machine.name || 'machine'}
          <span className="sr-only">({machine.presence})</span>
        </span>
      </div>
      <div className="mt-1 truncate" title={workdir}>
        {workdir} · Model: {model || 'default'} · Reasoning: {reasoningEffort || 'default'}
      </div>
    </div>
  )
}

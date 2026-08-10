import type { LoopFilter, LoopFilterOption } from '../lib/loopFilters'
import { focusRing } from './ui'

export function LoopFilterBar({
  options,
  selectedKey,
  onSelect,
}: {
  options: LoopFilterOption[]
  selectedKey: string
  onSelect: (filter: LoopFilter) => void
}) {
  return (
    <div className="scrollbar-none -mx-1 overflow-x-auto px-1 pb-1">
      <div role="group" aria-label="Loop filters" className="flex min-w-max items-center gap-1.5">
        {options.map((option) => {
          const selected = option.key === selectedKey
          return (
            <button
              key={option.key}
              type="button"
              aria-pressed={selected}
              title={option.filter.kind === 'tag' ? option.label : undefined}
              onClick={(event) => {
                event.currentTarget.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
                onSelect(option.filter)
              }}
              className={`inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-body font-medium transition-colors ${focusRing} ${
                selected
                  ? 'border-display bg-display text-paper'
                  : 'border-hairline bg-surface text-secondary hover:border-wire hover:bg-raised hover:text-primary'
              }`}
            >
              <span className={option.filter.kind === 'tag' ? 'max-w-44 truncate' : ''}>{option.label}</span>
              <span className={selected ? 'text-paper/70' : 'text-disabled'}>({option.count})</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

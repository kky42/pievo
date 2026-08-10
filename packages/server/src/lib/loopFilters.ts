import type { LoopSummary } from '../types'

export type LoopFilter =
  | { kind: 'all' }
  | { kind: 'active' }
  | { kind: 'paused' }
  | { kind: 'blocked' }
  | { kind: 'tag'; tag: string }

export interface LoopFilterOption {
  key: string
  label: string
  count: number
  filter: LoopFilter
}

export function loopFilterKey(filter: LoopFilter): string {
  return filter.kind === 'tag' ? `tag:${filter.tag}` : filter.kind
}

export function loopFilterOptions(loops: LoopSummary[]): LoopFilterOption[] {
  const active = loops.filter((loop) => loop.enabled && !loop.deleteRequestedAt).length
  const paused = loops.filter((loop) => !loop.enabled && !loop.deleteRequestedAt).length
  const blocked = loops.filter((loop) => !loop.enabled && !loop.deleteRequestedAt && loop.pauseCause?.kind === 'blocked').length
  const tagCounts = new Map<string, number>()
  for (const loop of loops) {
    for (const tag of new Set(loop.tags)) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)
  }

  return [
    { key: 'all', label: 'All Loops', count: loops.length, filter: { kind: 'all' } },
    { key: 'active', label: 'Active', count: active, filter: { kind: 'active' } },
    { key: 'paused', label: 'Paused', count: paused, filter: { kind: 'paused' } },
    { key: 'blocked', label: 'Blocked', count: blocked, filter: { kind: 'blocked' } },
    ...[...tagCounts].sort(([a], [b]) => a.localeCompare(b, 'en-US')).map(([tag, count]) => ({
      key: `tag:${tag}`,
      label: tag,
      count,
      filter: { kind: 'tag' as const, tag },
    })),
  ]
}

export function filterLoops(loops: LoopSummary[], filter: LoopFilter): LoopSummary[] {
  switch (filter.kind) {
    case 'all': return loops
    case 'active': return loops.filter((loop) => loop.enabled && !loop.deleteRequestedAt)
    case 'paused': return loops.filter((loop) => !loop.enabled && !loop.deleteRequestedAt)
    case 'blocked': return loops.filter((loop) => !loop.enabled && !loop.deleteRequestedAt && loop.pauseCause?.kind === 'blocked')
    case 'tag': return loops.filter((loop) => loop.tags.includes(filter.tag))
  }
}

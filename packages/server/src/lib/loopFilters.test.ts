import { describe, expect, it } from 'vitest'
import type { LoopSummary } from '../types'
import { filterLoops, loopFilterOptions } from './loopFilters'

function loop(id: string, patch: Partial<LoopSummary> = {}): LoopSummary {
  return {
    id,
    name: id,
    tags: [],
    schedule: { mode: 'cron', cron: '0 6 * * *', timezone: 'UTC', overlap: 'skip' },
    workdir: '/tmp/project',
    agent: 'claude-code',
    model: null,
    reasoningEffort: null,
    machine: { id: 'm1', name: 'Mac', online: true, presence: 'online', lastSeen: null },
    enabled: true,
    nextRun: null,
    lastRunTs: null,
    runs: [],
    runCount: 0,
    recentUsage: { runCount: 0, tokenCount: 0 },
    ...patch,
  }
}

const loops = [
  loop('active', { tags: ['daily', 'project'] }),
  loop('paused', { enabled: false, tags: ['ops'], pauseCause: { kind: 'owner', at: '2026-01-01T00:00:00Z' } }),
  loop('blocked', { enabled: false, tags: ['daily'], pauseCause: { kind: 'blocked', at: '2026-01-01T00:00:00Z', runId: 'r1' } }),
  loop('deleting', { enabled: false, tags: ['daily'], deleteRequestedAt: '2026-01-01T00:00:00Z' }),
  loop('untagged'),
]

describe('dashboard loop filters', () => {
  it('builds fixed lifecycle counts and stable custom tag counts', () => {
    expect(loopFilterOptions(loops).map(({ key, count }) => [key, count])).toEqual([
      ['all', 5],
      ['active', 2],
      ['paused', 2],
      ['blocked', 1],
      ['tag:daily', 3],
      ['tag:ops', 1],
      ['tag:project', 1],
    ])
  })

  it('keeps Blocked inside Paused and excludes deleting loops from lifecycle filters', () => {
    expect(filterLoops(loops, { kind: 'active' }).map((item) => item.id)).toEqual(['active', 'untagged'])
    expect(filterLoops(loops, { kind: 'paused' }).map((item) => item.id)).toEqual(['paused', 'blocked'])
    expect(filterLoops(loops, { kind: 'blocked' }).map((item) => item.id)).toEqual(['blocked'])
  })

  it('includes deleting loops in custom tags and preserves the incoming order', () => {
    expect(filterLoops(loops, { kind: 'tag', tag: 'daily' }).map((item) => item.id)).toEqual([
      'active',
      'blocked',
      'deleting',
    ])
    expect(filterLoops(loops, { kind: 'all' })).toBe(loops)
  })
})

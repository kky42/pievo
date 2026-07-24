import { describe, expect, it } from 'vitest'
import { chartDomain, progressChartRows, runningBest, scatterChartRows, seriesChartRows } from './stats'
import type { ChartRun } from '../types'

const run = (runIndex: number, status: string | null, metrics: ChartRun['metrics']): ChartRun => ({
  runIndex,
  ts: `2026-07-${String(runIndex).padStart(2, '0')}T00:00:00Z`,
  status,
  metrics,
})

describe('dashboard chart data', () => {
  const runs = [
    run(5, 'kept', { x: 50, score: 0.8, cost: 12 }),
    run(2, 'kept', { x: 20, score: 1, cost: null }),
    run(3, 'no-change', { x: 30, score: null, cost: 10 }),
    run(4, 'no-change', { x: 40, score: 0.9, cost: 11 }),
  ]

  it('sorts by runIndex, omits invalid values, and leaves sparse series values absent', () => {
    expect(seriesChartRows(runs, ['score', 'cost'], 'runIndex')).toEqual([
      { __x: 2, __runIndex: 2, __status: 'kept', score: 1 },
      { __x: 3, __runIndex: 3, __status: 'no-change', cost: 10 },
      { __x: 4, __runIndex: 4, __status: 'no-change', score: 0.9, cost: 11 },
      { __x: 5, __runIndex: 5, __status: 'kept', score: 0.8, cost: 12 },
    ])
  })

  it('builds scatter pairs only when both metrics are finite', () => {
    expect(scatterChartRows(runs, 'x', 'score').map(({ x, y, runIndex, status }) => ({ x, y, runIndex, status }))).toEqual([
      { x: 20, y: 1, runIndex: 2, status: 'kept' },
      { x: 40, y: 0.9, runIndex: 4, status: 'no-change' },
      { x: 50, y: 0.8, runIndex: 5, status: 'kept' },
    ])
  })

  it('colors every persisted kept point equally and applies no keep threshold', () => {
    const points = progressChartRows([
      run(1, 'kept', { score: 1 }),
      run(2, 'kept', { score: 0.999999 }),
      run(3, 'no-change', { score: 0.5 }),
      run(4, 'kept', { score: 1.1 }),
    ], 'score')
    expect(points.filter((point) => point.status === 'kept')).toHaveLength(3)
    expect(runningBest(points, 'min')).toEqual([
      { x: 1, y: 1 },
      { x: 2, y: 0.999999 },
      { x: 3, y: 0.999999 },
      { x: 4, y: 0.999999 },
    ])
  })

  it('uses padded auto domains and honors zero and explicit domains', () => {
    expect(chartDomain([0.949, 0.951], 'auto')).toEqual([0.9488, 0.9511999999999999])
    expect(chartDomain([4, 8], 'zero')).toEqual([0, 8])
    expect(chartDomain([4, 8], [3, 9])).toEqual([3, 9])
  })
})

import type { ChartRun } from '../types'
import type { YDomain } from './chartSpec'

export interface ChartRow {
  __x: string | number
  __runIndex: number
  __status: string | null
  [key: string]: string | number | null
}

export interface ScatterRow {
  x: number
  y: number
  runIndex: number
  status: string | null
  ts: string
}

export const finiteMetric = (run: ChartRun, key: string): number | null => {
  const value = run.metrics?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const chronological = (runs: ChartRun[]): ChartRun[] =>
  runs.slice().sort((a, b) => a.runIndex - b.runIndex)

export function seriesChartRows(runs: ChartRun[], keys: string[], x: 'time' | 'runIndex'): ChartRow[] {
  return chronological(runs).flatMap((run) => {
    const values = keys.map((key) => [key, finiteMetric(run, key)] as const)
    if (!values.some(([, value]) => value != null)) return []
    const row: ChartRow = {
      __x: x === 'time' ? run.ts : run.runIndex,
      __runIndex: run.runIndex,
      __status: run.status,
    }
    for (const [key, value] of values) if (value != null) row[key] = value
    return [row]
  })
}

export function scatterChartRows(runs: ChartRun[], xKey: string, yKey: string): ScatterRow[] {
  return chronological(runs).flatMap((run) => {
    const x = finiteMetric(run, xKey)
    const y = finiteMetric(run, yKey)
    return x == null || y == null ? [] : [{ x, y, runIndex: run.runIndex, status: run.status, ts: run.ts }]
  })
}

export function progressChartRows(runs: ChartRun[], yKey: string): ScatterRow[] {
  return chronological(runs).flatMap((run) => {
    const y = finiteMetric(run, yKey)
    return y == null ? [] : [{ x: run.runIndex, y, runIndex: run.runIndex, status: run.status, ts: run.ts }]
  })
}

/** Running best follows persisted kept decisions only. There is no renderer-side keep threshold. */
export function runningBest(rows: ScatterRow[], direction: 'min' | 'max'): Array<{ x: number; y: number }> {
  let best: number | null = null
  const out: Array<{ x: number; y: number }> = []
  for (const row of rows) {
    if (row.status === 'kept') best = best == null ? row.y : direction === 'min' ? Math.min(best, row.y) : Math.max(best, row.y)
    if (best != null) out.push({ x: row.x, y: best })
  }
  return out
}

export function chartDomain(values: number[], requested: YDomain): [number, number] | ['auto', 'auto'] {
  if (Array.isArray(requested)) return requested
  if (!values.length) return ['auto', 'auto']
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (requested === 'zero') return [Math.min(0, min), Math.max(0, max)]
  const span = max - min
  const pad = span > 0 ? span * 0.1 : Math.max(Math.abs(max) * 0.05, 1)
  return [min - pad, max + pad]
}

import { useId } from 'react'
import {
  Area, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer,
  Scatter, ScatterChart, Tooltip, XAxis, YAxis,
} from 'recharts'
import type { ChartRun, MetricField } from '../types'
import type { ChartSpec } from '../lib/chartSpec'
import { chartDomain, finiteMetric, progressChartRows, runningBest, scatterChartRows, seriesChartRows } from '../lib/stats'
import { fnum, md, tsShort } from '../lib/format'

const STROKES = [
  'var(--color-chart-1)', 'var(--color-chart-2)', 'var(--color-chart-3)',
  'var(--color-chart-4)', 'var(--color-chart-5)',
]
const HEIGHT = 190
const INITIAL = { width: 640, height: HEIGHT }
const TICK = { fontSize: 10, fontFamily: 'var(--font-mono)', fill: 'var(--color-secondary)' }
const TOOLTIP_STYLE = {
  background: 'var(--color-surface)', border: '1px solid var(--color-wire)', borderRadius: 8,
  boxShadow: 'none', padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 11,
} as const

const withUnit = (value: number, unit = ''): string => unit === '$' ? `$${fnum(value)}` : `${fnum(value)}${unit}`
const metricValues = (runs: ChartRun[], keys: string[]): number[] =>
  runs.flatMap((run) => keys.map((key) => finiteMetric(run, key)).filter((value): value is number => value != null))

const axisDomain = (runs: ChartRun[], keys: string[], spec: ChartSpec) => chartDomain(metricValues(runs, keys), spec.yDomain)
const axisValue = (value: number, domain: [number, number] | ['auto', 'auto']): string => {
  if (typeof domain[0] !== 'number' || typeof domain[1] !== 'number') return fnum(value)
  const span = Math.abs(domain[1] - domain[0])
  const digits = span < 0.001 ? 6 : span < 0.01 ? 5 : span < 0.1 ? 4 : span < 1 ? 3 : span < 10 ? 2 : span < 100 ? 1 : 0
  return value.toFixed(digits)
}

function ChartFrame({ children, caption }: { children: React.ReactNode; caption?: React.ReactNode }) {
  return (
    <figure className="my-2 min-w-0">
      <div className="min-w-0" style={{ height: HEIGHT }}>{children}</div>
      {caption ? <figcaption className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-label text-[var(--color-secondary)]">{caption}</figcaption> : null}
    </figure>
  )
}

export function LoopChart({ runs, spec }: { runs: ChartRun[]; spec: ChartSpec }) {
  if (spec.type === 'scatter') return <ScatterPlot runs={runs} spec={spec} />
  if (spec.type === 'progress') return <ProgressPlot runs={runs} spec={spec} />
  return <SeriesPlot runs={runs} spec={spec} />
}

function SeriesPlot({ runs, spec }: { runs: ChartRun[]; spec: Extract<ChartSpec, { type: 'line' | 'area' }> }) {
  const gradientId = useId()
  const keys = spec.series.map((field) => field.key)
  const rows = seriesChartRows(runs, keys, spec.x)
  if (!rows.length) return null
  const units = new Map(spec.series.map((field) => [field.key, field.unit ?? '']))
  const domain = axisDomain(runs, keys, spec)
  const latest = new Map<string, number>()
  for (const row of rows) for (const key of keys) if (typeof row[key] === 'number') latest.set(key, row[key] as number)
  const margin = { top: 6, right: 12, left: 0, bottom: 0 }

  return (
    <ChartFrame caption={spec.series.map((field, index) => {
      const value = latest.get(field.key)
      return value == null ? null : (
        <span key={field.key} className="inline-flex items-center gap-1.5">
          <span className="inline-block h-[2px] w-3" style={{ background: STROKES[index % STROKES.length] }} />
          {field.label ?? field.key}<span className="text-[var(--color-display)]">{withUnit(value, field.unit)}</span>
        </span>
      )
    })}>
      <ResponsiveContainer width="100%" height="100%" initialDimension={INITIAL}>
        <ComposedChart data={rows} margin={margin}>
          {spec.type === 'area' ? (
            <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={STROKES[0]} stopOpacity={0.28}/><stop offset="95%" stopColor={STROKES[0]} stopOpacity={0.02}/></linearGradient></defs>
          ) : null}
          <CartesianGrid vertical={false} stroke="var(--color-hairline)" />
          <XAxis dataKey="__x" type={spec.x === 'runIndex' ? 'number' : 'category'} domain={spec.x === 'runIndex' ? ['dataMin', 'dataMax'] : undefined} tick={TICK} tickLine={false} axisLine={false} tickMargin={8} minTickGap={28} tickFormatter={(value) => spec.x === 'time' ? md(String(value)) : String(value)} />
          <YAxis width={60} domain={domain} allowDataOverflow={Array.isArray(spec.yDomain)} tick={TICK} tickLine={false} axisLine={false} tickFormatter={(value: number) => axisValue(value, domain)} />
          <Tooltip isAnimationActive={false} contentStyle={TOOLTIP_STYLE} labelFormatter={(value) => spec.x === 'time' ? tsShort(String(value)) : `run #${value}`} formatter={(value, name, item) => [withUnit(Number(value), units.get(String(item?.dataKey))), String(name)]} />
          {spec.type === 'area' ? (
            <Area {...seriesProps(spec.series[0]!, 0)} connectNulls dot={rows.length === 1 ? { r: 3.5, strokeWidth: 0 } : false} fill={`url(#${gradientId})`} />
          ) : spec.series.map((field, index) => (
            <Line {...seriesProps(field, index)} key={field.key} connectNulls dot={spec.colorBy === 'status' ? statusDot(field.key) : rows.length === 1 ? { r: 3.5, strokeWidth: 0 } : false} />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </ChartFrame>
  )
}

function ScatterPlot({ runs, spec }: { runs: ChartRun[]; spec: Extract<ChartSpec, { type: 'scatter' }> }) {
  const rows = scatterChartRows(runs, spec.xKey, spec.yKey)
  if (!rows.length) return null
  const domain = chartDomain(rows.map((row) => row.y), spec.yDomain)
  const xDomain = chartDomain(rows.map((row) => row.x), 'auto')
  const kept = rows.filter((row) => row.status === 'kept')
  const other = rows.filter((row) => row.status !== 'kept')
  const groups = spec.colorBy === 'status'
    ? [{ name: 'Other', rows: other, fill: 'var(--color-disabled)' }, { name: 'Kept', rows: kept, fill: 'var(--color-success)' }]
    : [{ name: spec.yLabel ?? spec.yKey, rows, fill: STROKES[0] }]
  return (
    <ChartFrame>
      <ResponsiveContainer width="100%" height="100%" initialDimension={INITIAL}>
        <ScatterChart margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
          <CartesianGrid stroke="var(--color-hairline)" />
          <XAxis type="number" dataKey="x" name={spec.xLabel ?? spec.xKey} domain={xDomain} tickFormatter={(value: number) => axisValue(value, xDomain)} tick={TICK} tickLine={false} axisLine={false} />
          <YAxis type="number" dataKey="y" name={spec.yLabel ?? spec.yKey} domain={domain} allowDataOverflow={Array.isArray(spec.yDomain)} width={60} tickFormatter={(value: number) => axisValue(value, domain)} tick={TICK} tickLine={false} axisLine={false} />
          <Tooltip isAnimationActive={false} contentStyle={TOOLTIP_STYLE} cursor={{ stroke: 'var(--color-wire)', strokeDasharray: '3 3' }} labelFormatter={(_, payload) => payload?.[0]?.payload ? `run #${payload[0].payload.runIndex}` : ''} formatter={(value, name, item) => [withUnit(Number(value), String(item?.dataKey) === 'x' ? spec.xUnit : spec.yUnit), String(name)]} />
          {groups.map((group) => <Scatter key={group.name} name={group.name} data={group.rows} fill={group.fill} isAnimationActive={false} />)}
          {spec.colorBy ? <Legend verticalAlign="top" align="right" /> : null}
        </ScatterChart>
      </ResponsiveContainer>
    </ChartFrame>
  )
}

function ProgressPlot({ runs, spec }: { runs: ChartRun[]; spec: Extract<ChartSpec, { type: 'progress' }> }) {
  const rows = progressChartRows(runs, spec.yKey)
  if (!rows.length) return null
  const kept = rows.filter((row) => row.status === 'kept')
  const other = rows.filter((row) => row.status !== 'kept')
  const best = runningBest(rows, spec.direction)
  const domain = chartDomain(rows.map((row) => row.y), spec.yDomain)
  return (
    <ChartFrame>
      <ResponsiveContainer width="100%" height="100%" initialDimension={INITIAL}>
        <ComposedChart margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
          <CartesianGrid vertical={false} stroke="var(--color-hairline)" />
          <XAxis type="number" dataKey="x" domain={['dataMin', 'dataMax']} tick={TICK} tickLine={false} axisLine={false} />
          <YAxis type="number" dataKey="y" domain={domain} allowDataOverflow={Array.isArray(spec.yDomain)} width={60} tickFormatter={(value: number) => axisValue(value, domain)} tick={TICK} tickLine={false} axisLine={false} />
          <Tooltip isAnimationActive={false} contentStyle={TOOLTIP_STYLE} labelFormatter={(_, payload) => payload?.[0]?.payload ? `run #${payload[0].payload.runIndex ?? payload[0].payload.x}` : ''} />
          <Scatter name="Other" data={other} fill="var(--color-disabled)" isAnimationActive={false} />
          <Scatter name="Kept" data={kept} fill="var(--color-success)" isAnimationActive={false} />
          {best.length ? <Line name="Running best" data={best} dataKey="y" type="stepAfter" stroke="var(--color-success)" strokeWidth={2} dot={false} isAnimationActive={false} /> : null}
          <Legend verticalAlign="top" align="right" />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartFrame>
  )
}

const seriesProps = (field: MetricField, index: number) => ({
  dataKey: field.key,
  name: field.label ?? field.key,
  type: 'linear' as const,
  stroke: STROKES[index % STROKES.length],
  strokeWidth: 1.5,
  activeDot: { r: 3, strokeWidth: 0 },
  isAnimationActive: false,
})

const statusDot = (key: string) => (props: any) => {
  const value = props?.payload?.[key]
  if (typeof value !== 'number') return <g />
  return <circle cx={props.cx} cy={props.cy} r={2.8} fill={props.payload.__status === 'kept' ? 'var(--color-success)' : 'var(--color-disabled)'} />
}

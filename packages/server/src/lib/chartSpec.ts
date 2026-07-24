import type { MetricField } from '../types'

export const CHART_ATTRS = [
  'type', 'x', 'y', 'series', 'direction', 'y-domain', 'color-by',
  'x-label', 'y-label', 'x-unit', 'y-unit',
] as const

export type ChartType = 'line' | 'area' | 'scatter' | 'progress'
export type YDomain = 'auto' | 'zero' | [number, number]

interface CommonChartSpec {
  yDomain: YDomain
}

export interface SeriesChartSpec extends CommonChartSpec {
  type: 'line' | 'area'
  x: 'time' | 'runIndex'
  series: MetricField[]
  colorBy: 'status' | null
}

export interface ScatterChartSpec extends CommonChartSpec {
  type: 'scatter'
  xKey: string
  yKey: string
  colorBy: 'status' | null
  xLabel?: string
  yLabel?: string
  xUnit?: string
  yUnit?: string
}

export interface ProgressChartSpec extends CommonChartSpec {
  type: 'progress'
  x: 'runIndex'
  yKey: string
  direction: 'min' | 'max'
}

export type ChartSpec = SeriesChartSpec | ScatterChartSpec | ProgressChartSpec
export type ChartSpecResult = { ok: true; value: ChartSpec } | { ok: false; detail: string }

const KEY = /^[a-zA-Z0-9_-]+$/
const safeMetricKey = (key: string): boolean => KEY.test(key) && !key.startsWith('__') && key !== 'constructor' && key !== 'prototype'
const metricKey = (value: string | undefined): string | null => {
  const match = value?.match(/^metric\.([a-zA-Z0-9_-]+)$/)
  return match?.[1] && safeMetricKey(match[1]) ? match[1] : null
}

export function parseChartSeries(value: string | undefined): MetricField[] {
  if (!value) return []
  return value.split(',').map((part) => {
    const [key = '', label, unit] = part.split(':').map((s) => s.trim())
    return { key, ...(label ? { label } : {}), ...(unit ? { unit } : {}) }
  }).filter((field) => safeMetricKey(field.key))
}

function parseDomain(value: string | undefined): YDomain | null {
  if (!value || value === 'auto') return 'auto'
  if (value === 'zero') return 'zero'
  const match = value.match(/^(-?(?:\d+(?:\.\d*)?|\.\d+)):(-?(?:\d+(?:\.\d*)?|\.\d+))$/)
  if (!match) return null
  const min = Number(match[1])
  const max = Number(match[2])
  return Number.isFinite(min) && Number.isFinite(max) && min < max ? [min, max] : null
}

export function parseChartSpec(attrs: Record<string, string>): ChartSpecResult {
  const type = attrs.type as ChartType | undefined
  if (!type || !['line', 'area', 'scatter', 'progress'].includes(type)) {
    return { ok: false, detail: '<loop-chart> requires type="line|area|scatter|progress"' }
  }
  const yDomain = parseDomain(attrs['y-domain'])
  if (!yDomain) return { ok: false, detail: '<loop-chart> y-domain must be auto, zero, or min:max' }
  const allowedByType: Record<ChartType, string[]> = {
    line: ['type', 'x', 'series', 'y-domain', 'color-by'],
    area: ['type', 'x', 'series', 'y-domain'],
    scatter: ['type', 'x', 'y', 'y-domain', 'color-by', 'x-label', 'y-label', 'x-unit', 'y-unit'],
    progress: ['type', 'x', 'y', 'y-domain', 'direction'],
  }
  const inapplicable = Object.keys(attrs).filter((name) => !allowedByType[type].includes(name))
  if (inapplicable.length) return { ok: false, detail: `<loop-chart type="${type}"> unsupported attribute: ${inapplicable.join(', ')}` }

  if (type === 'line' || type === 'area') {
    if (attrs.x !== 'time' && attrs.x !== 'runIndex') {
      return { ok: false, detail: `<loop-chart type="${type}"> requires x="time|runIndex"` }
    }
    const series = parseChartSeries(attrs.series)
    if (!attrs.series || !series.length || series.length !== attrs.series.split(',').length) {
      return { ok: false, detail: `<loop-chart type="${type}"> requires valid series="key:Label:unit"` }
    }
    if (type === 'area' && series.length !== 1) {
      return { ok: false, detail: '<loop-chart type="area"> supports exactly one series' }
    }
    const colorBy = attrs['color-by'] ?? null
    if (colorBy !== null && (colorBy !== 'status' || series.length !== 1 || type !== 'line')) {
      return { ok: false, detail: 'color-by="status" is supported only by a single-series line chart' }
    }
    return { ok: true, value: { type, x: attrs.x, series, colorBy, yDomain } }
  }

  const xKey = metricKey(attrs.x)
  const yKey = metricKey(attrs.y)
  if (type === 'scatter') {
    if (!xKey || !yKey) {
      return { ok: false, detail: '<loop-chart type="scatter"> requires x="metric.key" and y="metric.key"' }
    }
    const colorBy = attrs['color-by'] ?? null
    if (colorBy !== null && colorBy !== 'status') {
      return { ok: false, detail: '<loop-chart type="scatter"> color-by must be status' }
    }
    return {
      ok: true,
      value: {
        type, xKey, yKey, colorBy, yDomain,
        ...(attrs['x-label'] ? { xLabel: attrs['x-label'] } : {}),
        ...(attrs['y-label'] ? { yLabel: attrs['y-label'] } : {}),
        ...(attrs['x-unit'] ? { xUnit: attrs['x-unit'] } : {}),
        ...(attrs['y-unit'] ? { yUnit: attrs['y-unit'] } : {}),
      },
    }
  }

  if (attrs.x !== 'runIndex' || !yKey) {
    return { ok: false, detail: '<loop-chart type="progress"> requires x="runIndex" and y="metric.key"' }
  }
  if (attrs.direction !== 'min' && attrs.direction !== 'max') {
    return { ok: false, detail: '<loop-chart type="progress"> requires direction="min|max"' }
  }
  return { ok: true, value: { type, x: 'runIndex', yKey, direction: attrs.direction, yDomain } }
}

export function chartMetricKeys(spec: ChartSpec): string[] {
  if ('series' in spec) return spec.series.map((field) => field.key)
  if ('xKey' in spec) return [spec.xKey, spec.yKey]
  return [spec.yKey]
}

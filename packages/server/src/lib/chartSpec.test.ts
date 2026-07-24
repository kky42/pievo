import { describe, expect, it } from 'vitest'
import { parseChartSpec } from './chartSpec'

describe('parseChartSpec', () => {
  it('parses the supported chart shapes', () => {
    expect(parseChartSpec({ type: 'line', x: 'runIndex', series: 'score:Score:%' })).toMatchObject({ ok: true, value: { type: 'line', x: 'runIndex', yDomain: 'auto' } })
    expect(parseChartSpec({ type: 'area', x: 'time', series: 'score:Score', 'y-domain': '0.9:1' })).toMatchObject({ ok: true, value: { type: 'area', yDomain: [0.9, 1] } })
    expect(parseChartSpec({ type: 'scatter', x: 'metric.batch', y: 'metric.score', 'color-by': 'status' })).toMatchObject({ ok: true, value: { type: 'scatter', xKey: 'batch', yKey: 'score', colorBy: 'status' } })
    expect(parseChartSpec({ type: 'progress', x: 'runIndex', y: 'metric.score', direction: 'min' })).toMatchObject({ ok: true, value: { type: 'progress', yKey: 'score', direction: 'min' } })
  })

  it('deliberately rejects the old chart grammar', () => {
    expect(parseChartSpec({ series: 'score:Score' })).toEqual({ ok: false, detail: '<loop-chart> requires type="line|area|scatter|progress"' })
  })

  it.each([
    [{ type: 'area', x: 'time', series: 'a:A,b:B' }, 'supports exactly one series'],
    [{ type: 'scatter', x: 'runIndex', y: 'metric.score' }, 'requires x="metric.key"'],
    [{ type: 'progress', x: 'runIndex', y: 'metric.score' }, 'requires direction="min|max"'],
    [{ type: 'line', x: 'runIndex', series: 'score', 'y-domain': '1:0' }, 'y-domain must be'],
    [{ type: 'line', x: 'runIndex', series: 'score', direction: 'min' }, 'unsupported attribute: direction'],
    [{ type: 'line', x: 'runIndex', series: '__status:Status' }, 'requires valid series'],
    [{ type: 'scatter', x: 'metric.__proto__', y: 'metric.score' }, 'requires x="metric.key"'],
  ])('rejects an invalid spec: %o', (attrs, message) => {
    const result = parseChartSpec(attrs)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.detail).toContain(message)
  })
})

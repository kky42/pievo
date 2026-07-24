import { describe, expect, test } from 'vitest'
import { validateUi } from './validate.js'

describe('validateUi custom primitives', () => {
  test('accepts the supported chart shapes and retained artifact primitives', () => {
    expect(validateUi('  ')).toEqual({ ok: true, value: null })
    const html = [
      '<loop-chart type="line" x="runIndex" series="score:Score" y-domain="auto"></loop-chart>',
      '<loop-chart type="area" x="time" series="score:Score"></loop-chart>',
      '<loop-chart type="scatter" x="metric.cost" y="metric.score" color-by="status"></loop-chart>',
      '<loop-chart type="progress" x="runIndex" y="metric.score" direction="min"></loop-chart>',
      '<loop-embed file="latest.md"></loop-embed>',
      '<loop-calendar match="reports/*.md"></loop-calendar>',
      '<loop-kanban columns="open,merged" match="*.md"></loop-kanban>',
    ].join('')
    expect(validateUi(html)).toEqual({ ok: true, value: html })
  })

  test.each([
    ['<loop-chart series="score:Score"></loop-chart>', 'requires type="line|area|scatter|progress"'],
    ['<loop-chart type="line" x="runIndex" series="score" filter="role=exec"></loop-chart>', 'unsupported attribute: filter'],
    ['<loop-chart type="scatter" x="runIndex" y="metric.score"></loop-chart>', 'requires x="metric.key"'],
    ['<loop-chart type="progress" x="runIndex" y="metric.score"></loop-chart>', 'requires direction="min|max"'],
    ['<loop-chart type="line" x="runIndex" series="score" height="20"></loop-chart>', 'unsupported attribute: height'],
    ['<loop-chart type="line" x="runIndex" series="score" direction="min"></loop-chart>', 'unsupported attribute: direction'],
    ['<loop-chart type="line" x=runIndex series="score"></loop-chart>', 'quoted name="value" syntax'],
    ['<loop-chart type="line" type="area" x="runIndex" series="score"></loop-chart>', 'duplicate attribute: type'],
    ['<loop-embed src="latest.md"></loop-embed>', '<loop-embed> requires file="…" or match="…"'],
    ['<loop-kanban match="*.md"></loop-kanban>', '<loop-kanban> requires columns="…"'],
  ])('rejects invalid custom markup: %s', (html, detail) => {
    const result = validateUi(html)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.detail).toContain(detail)
  })

  test('rejects oversized UI instead of truncating it', () => {
    expect(validateUi('x'.repeat(20_001))).toEqual({ ok: false, detail: 'dashboard UI exceeds 20000 characters' })
  })
})

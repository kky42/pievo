import { describe, expect, it } from 'vitest'
import { normalizeLoopTag, validateLoopTags } from './loopTags'

describe('loop tags', () => {
  it('normalizes tags into one stable set representation', () => {
    expect(normalizeLoopTag('  ＤＡＩＬＹ  ')).toBe('daily')
    expect(normalizeLoopTag('Daily   Report')).toBe('daily report')
    expect(validateLoopTags([' Project ', 'DAILY', '中文'])).toEqual({
      ok: true,
      value: ['daily', 'project', '中文'],
    })
  })

  it('accepts no tags and the four-tag maximum', () => {
    expect(validateLoopTags(undefined)).toEqual({ ok: true, value: [] })
    expect(validateLoopTags([])).toEqual({ ok: true, value: [] })
    expect(validateLoopTags(['a', 'b', 'c', 'd'])).toMatchObject({ ok: true })
    expect(validateLoopTags(['a', 'b', 'c', 'd', 'e'])).toMatchObject({ ok: false })
  })

  it('rejects reserved, duplicate, empty, malformed, and overlong tags', () => {
    for (const tag of ['active', ' ACTIVE ', 'all  loops', 'paused', 'blocked']) {
      expect(validateLoopTags([tag])).toMatchObject({ ok: false, detail: expect.stringContaining('reserved') })
    }
    expect(validateLoopTags(['Daily', 'ｄａｉｌｙ'])).toMatchObject({ ok: false, detail: 'duplicate tag: daily' })
    expect(validateLoopTags(['daily report', 'daily  report'])).toMatchObject({ ok: false, detail: 'duplicate tag: daily report' })
    expect(validateLoopTags([' '])).toMatchObject({ ok: false })
    expect(validateLoopTags(['nul\0tag'])).toMatchObject({ ok: false })
    expect(validateLoopTags(['\u200b'])).toMatchObject({ ok: false })
    expect(validateLoopTags(['active\u200b'])).toMatchObject({ ok: false })
    expect(validateLoopTags(['active\u034f'])).toMatchObject({ ok: false })
    expect(validateLoopTags(['daily\ufe0f'])).toMatchObject({ ok: false })
    expect(validateLoopTags(['\u3164'])).toMatchObject({ ok: false })
    expect(validateLoopTags([42])).toMatchObject({ ok: false })
    expect(validateLoopTags(null)).toMatchObject({ ok: false })
    expect(validateLoopTags('daily')).toMatchObject({ ok: false })
    expect(validateLoopTags(['a'.repeat(65)])).toMatchObject({ ok: false })
  })
})

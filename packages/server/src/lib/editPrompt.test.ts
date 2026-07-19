import { describe, expect, it } from 'vitest'
import { buildEditPrompt, loopDir } from './editPrompt'

describe('loopDir', () => {
  it('returns the containing directory of a POSIX task file path', () => {
    expect(loopDir('/home/me/pievo/coffee/task.md')).toBe('/home/me/pievo/coffee')
  })

  it('handles Windows separators', () => {
    expect(loopDir('C:\\Users\\me\\pievo\\coffee\\task.md')).toBe('C:/Users/me/pievo/coffee')
  })

  it('ignores a trailing slash', () => {
    expect(loopDir('/home/me/pievo/coffee/')).toBe('/home/me/pievo')
  })

  it('degrades to null when absent or parentless (no fabricated path)', () => {
    expect(loopDir()).toBeNull()
    expect(loopDir(null)).toBeNull()
    expect(loopDir('')).toBeNull()
    expect(loopDir('task.md')).toBeNull()
  })
})

describe('buildEditPrompt', () => {
  it('names the loop, carries the instruction, and points at the pievo CLI', () => {
    const p = buildEditPrompt({ loopId: 'lp_123', loopName: 'Coffee stock', instruction: 'run at 9am on weekdays' })
    expect(p).toContain('Pievo loop "Coffee stock"')
    expect(p).toContain('loop id: lp_123')
    expect(p).toContain('run at 9am on weekdays')
    expect(p).toContain('pievo loops')
    expect(p).toContain('pievo edit lp_123')
  })

  it('falls back to a describe-the-change placeholder when no instruction is given', () => {
    const p = buildEditPrompt({ loopId: 'lp_9', loopName: 'X', instruction: '   ' })
    expect(p).toContain('Describe the change you want to make to this loop.')
  })

  it('is agent-neutral (never names a specific coding agent)', () => {
    const p = buildEditPrompt({ loopId: 'lp_9', loopName: 'X', instruction: 'y' })
    expect(p).not.toMatch(/claude/i)
    expect(p).not.toMatch(/codex/i)
  })
})

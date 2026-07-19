import { describe, expect, it } from 'vitest'
import type { ArtifactSummary } from '../types'
import { buildFileEntries, isTaskEntry, isTaskPath, pickTaskPath } from './fileEntries'

const art = (path: string, over: Partial<ArtifactSummary> = {}): ArtifactSummary => ({
  path,
  size: 100,
  updatedAt: '2026-06-30T00:00:00.000Z',
  binary: false,
  oversize: false,
  meta: null,
  ...over,
})

describe('isTaskPath', () => {
  it('matches an absolute task file against its relative synced path', () => {
    // The real-world bug: stored task file is absolute, the artifact is relative.
    expect(isTaskPath('/Users/me/work/loop/README.md', 'README.md')).toBe(true)
    expect(isTaskPath('/Users/me/work/loop/hn/README.md', 'hn/README.md')).toBe(true)
  })

  it('matches on a whole-segment suffix either direction', () => {
    expect(isTaskPath('loop/hn/README.md', 'hn/README.md')).toBe(true)
    expect(isTaskPath('hn/README.md', 'loop/hn/README.md')).toBe(true)
  })

  it('matches equal paths and basenames; normalizes separators / ./ / trailing slash', () => {
    expect(isTaskPath('README.md', 'README.md')).toBe(true)
    expect(isTaskPath('a/b/README.md', 'c/d/README.md')).toBe(true) // basename fallback
    expect(isTaskPath('.\\loop\\README.md', './loop/README.md')).toBe(true)
  })

  it('does not match unrelated files or an absent task file', () => {
    expect(isTaskPath('/x/README.md', 'report.md')).toBe(false)
    expect(isTaskPath(undefined, 'README.md')).toBe(false)
    expect(isTaskPath('', 'README.md')).toBe(false)
  })
})

describe('buildFileEntries', () => {
  it('badges the synced task artifact and never doubles it (the dedup fix)', () => {
    const entries = buildFileEntries('/Users/me/work/loop/README.md', [
      art('README.md'),
      art('articles/2026-06-30.md'),
    ])
    // README appears exactly once, first, badged as the task.
    const readmes = entries.filter((e) => e.path === 'README.md')
    expect(readmes).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: 'artifact', path: 'README.md', task: true })
    expect(isTaskEntry(entries[0])).toBe(true)
    expect(entries.map((e) => e.path)).toEqual(['README.md', 'articles/2026-06-30.md'])
  })

  it('prefers a stronger suffix match over a basename collision in a subdir', () => {
    const entries = buildFileEntries('/Users/me/work/loop/hn/README.md', [
      art('ARCHIVE/README.md'),
      art('hn/README.md'),
    ])
    expect(entries[0]).toMatchObject({ kind: 'artifact', path: 'hn/README.md', task: true })
    expect(entries.filter((e) => isTaskEntry(e))).toHaveLength(1)
    expect(entries.map((e) => e.path)).toEqual(['hn/README.md', 'ARCHIVE/README.md'])
  })

  it('breaks a basename tie by preferring the shallowest path', () => {
    const entries = buildFileEntries('/x/README.md', [art('ARCHIVE/README.md'), art('README.md')])
    expect(entries[0]).toMatchObject({ kind: 'artifact', path: 'README.md', task: true })
    expect(entries.filter((e) => isTaskEntry(e))).toHaveLength(1)
    expect(entries.map((e) => e.path)).toEqual(['README.md', 'ARCHIVE/README.md'])
  })

  it('falls back to a single synthetic task entry before the first sync', () => {
    const entries = buildFileEntries('/Users/me/work/loop/README.md', [])
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual({ kind: 'task', path: '/Users/me/work/loop/README.md' })
    expect(isTaskEntry(entries[0])).toBe(true)
  })

  it('keeps the synthetic task plus artifacts when none of them is the task file', () => {
    const entries = buildFileEntries('/Users/me/work/loop/README.md', [art('report.md'), art('data/nums.csv')])
    expect(entries[0]).toEqual({ kind: 'task', path: '/Users/me/work/loop/README.md' })
    expect(entries.filter((e) => isTaskEntry(e))).toHaveLength(1)
    expect(entries.map((e) => e.path)).toEqual(['/Users/me/work/loop/README.md', 'report.md', 'data/nums.csv'])
  })

  it('emits no task row when the loop has no task file', () => {
    const entries = buildFileEntries(undefined, [art('report.md')])
    expect(entries.some((e) => isTaskEntry(e))).toBe(false)
    expect(entries).toEqual([{ kind: 'artifact', path: 'report.md', file: art('report.md') }])
  })
})

describe('pickTaskPath', () => {
  it('returns null when nothing matches or taskFile is absent', () => {
    expect(pickTaskPath(undefined, ['README.md'])).toBeNull()
    expect(pickTaskPath('/loops/l1/README.md', ['notes.md', 'reports/day-1.md'])).toBeNull()
  })

  it('suffix-matches an absolute taskFile against a relative synced path', () => {
    expect(pickTaskPath('/home/u/loops/demo/README.md', ['notes.md', 'README.md'])).toBe('README.md')
  })

  it('prefers the exact/shallow match over a nested basename match', () => {
    expect(pickTaskPath('/loops/l1/README.md', ['ARCHIVE/README.md', 'README.md'])).toBe('README.md')
    // order must not matter
    expect(pickTaskPath('/loops/l1/README.md', ['README.md', 'ARCHIVE/README.md'])).toBe('README.md')
  })
})

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Regression guards for the page-poll resilience fixes.
 *
 * (1) LoopDetailView: a transient initial-load failure used to brick the page
 * permanently — `load()` set `err`, the background poll kept succeeding but never
 * cleared it, and the `if (err)` render guard won over the fresh data. The poll
 * must clear `err` on success, and the error view must offer a Retry (mirroring
 * RunDetailView's).
 *
 * (2) LoopDetailView must not retain removed strategy-dispatch state.
 *
 * (3) ComposeModal: the claimStatus setInterval tick had no rejection handler —
 * an unhandled rejection every 2.5s during a server hiccup. The tick must catch.
 */
const read = (name: string) => readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8')

describe('LoopDetailView poll/error resilience', () => {
  const src = read('LoopDetailView.tsx')

  it('clears err when a background poll succeeds and keeps stale data on a silent failure', () => {
    expect(src).toContain('async (silent = false)')
    expect(src).toContain('setErr(null)')
    expect(src).toContain('if (!silent) setErr(')
    expect(src).toContain('void load(true)')
  })

  it('offers a Retry in the fatal-error view', () => {
    expect(src).toContain('<LoadErrorCard')
    expect(src).toContain('onRetry={() => void load()}')
  })
})

describe('ComposeModal claim-poll rejection handling', () => {
  const src = read('ComposeModal.tsx')

  it('catches a failed claimStatus tick (no unhandled rejection every 2.5s)', () => {
    const tick = /pollRef\.current = setInterval\(\(\) => \{[\s\S]*?\}, 2500\)/.exec(src)?.[0]
    expect(tick, 'the claim poll tick should exist').toBeTruthy()
    expect(tick).toContain('.catch(')
    // Every interval rejection must be handled locally.
    expect(src).not.toMatch(/setInterval\(async /)
  })

  it('stays BYOA-only and builds the connect snippet from the current instance origin', () => {
    expect(src).toContain("window.location.origin")
    expect(src).toContain('`server-url: ${origin}`')
    expect(src).not.toContain('Hosted on Pievo')
    expect(src).not.toMatch(/pievo[.]ai/)
  })
})

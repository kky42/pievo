// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'

describe('renderMarkdown', () => {
  it('strips scripts and event handlers (allowlist sanitizer)', () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)"> <script>alert(2)</script> [x](javascript:alert(3))')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('onerror')
    expect(html.toLowerCase()).not.toContain('javascript:')
  })
})

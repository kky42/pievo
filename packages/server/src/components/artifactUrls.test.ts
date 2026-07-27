import { describe, expect, it } from 'vitest'
import { downloadHref, inlineHref } from './artifactUrls'

describe('artifact URLs', () => {
  it('encodes loop IDs and each nested path segment', () => {
    expect(downloadHref('loop/1', 'reports/a b.html')).toBe('/api/artifact/loop%2F1/reports/a%20b.html')
  })

  it('requests hardened inline serving without changing the artifact path', () => {
    expect(inlineHref('loop-1', 'images/a.svg')).toBe('/api/artifact/loop-1/images/a.svg?view=inline')
  })
})

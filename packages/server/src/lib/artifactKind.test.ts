import { describe, expect, it } from 'vitest'
import { imageMime } from './artifactKind'

describe('imageMime', () => {
  it('maps only the allowlisted image types to a MIME, else null', () => {
    expect(imageMime('a.png')).toBe('image/png')
    expect(imageMime('a.jpg')).toBe('image/jpeg')
    expect(imageMime('a.jpeg')).toBe('image/jpeg')
    expect(imageMime('a.svg')).toBe('image/svg+xml')
    expect(imageMime('a.webp')).toBe('image/webp')
    expect(imageMime('a.html')).toBeNull()
    expect(imageMime('a.md')).toBeNull()
    expect(imageMime('a.exe')).toBeNull()
  })

})

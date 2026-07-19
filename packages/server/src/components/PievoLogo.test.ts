import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { PievoLogo } from './PievoLogo'

const read = (url: URL) => readFileSync(fileURLToPath(url), 'utf8')

describe('PievoLogo', () => {
  it('renders the shared eight-step ring mark', () => {
    const markup = renderToStaticMarkup(createElement(PievoLogo, { size: 32 }))
    expect(markup).toContain('aria-label="Pievo"')
    expect(markup).toContain('ring-logo-plate')
    expect(markup).toContain('ring-logo-animated')
    expect(markup.match(/class="ring-cell/g)).toHaveLength(8)
  })

  it('keeps the README asset and favicon byte-aligned', () => {
    const readmeMark = read(new URL('../../../../docs/assets/logo.svg', import.meta.url))
    const favicon = read(new URL('../../public/favicon.svg', import.meta.url))
    expect(favicon).toBe(readmeMark)
  })

  it('does not retain the old spelling-cube CSS', () => {
    const css = read(new URL('../styles/app.css', import.meta.url))
    expect(css).not.toContain('.loop-cube')
    expect(css).not.toContain('loopCubeSpin')
    expect(css).not.toContain('L-O-O-P')
  })
})

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { PievoLogo } from './PievoLogo'

describe('PievoLogo', () => {
  it('renders the shared eight-step ring mark', () => {
    const markup = renderToStaticMarkup(createElement(PievoLogo, { size: 32 }))
    expect(markup).toContain('aria-label="Pievo"')
    expect(markup).toContain('ring-logo-plate')
    expect(markup).toContain('ring-logo-animated')
    expect(markup.match(/class="ring-cell/g)).toHaveLength(8)
  })
})

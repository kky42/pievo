/** /api/bootstrap is the server-only first-contact connection/create handoff. */
import { describe, expect, test } from 'vitest'

import { Route } from './api.bootstrap'

const GET = (Route as any).options.server.handlers.GET as () => Response | Promise<Response>
const flat = (s: string) => s.replace(/\s+/g, ' ')

describe('/api/bootstrap', () => {
  test('serves server-only markdown without installable-skill frontmatter', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    const body = await res.text()
    expect(body.length).toBeGreaterThan(100)
    expect(body.startsWith('---')).toBe(false)
    expect(body).not.toContain('name: pievo')
  })

  test('hands off only to connect and create', async () => {
    const body = flat(await (await GET()).text())
    expect(body).toContain('server-url')
    expect(body).toContain('connect-key')
    expect(body).toContain('/api/skill/references/connect.md')
    expect(body).toContain('/api/skill/references/create.md')
    expect(body).toContain('exclusive cron or continuous schedule')
    expect(body).toContain('three status definitions')
    expect(body).toContain('exact artifact files')
    expect(body).not.toContain('/api/skill/references/dashboard.md')
    expect(body).not.toContain('/api/skill/references/run.md')
  })

  test('states the minimal delivered prompt model', async () => {
    const body = flat(await (await GET()).text())
    expect(body).toContain('The stored user prompt is delivered unchanged')
    expect(body).toContain("Pievo's complete status/report contract")
  })
})

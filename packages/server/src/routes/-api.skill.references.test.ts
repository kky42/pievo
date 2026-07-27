/** The static fallback serves exactly the three installable owner references. */
import { describe, expect, test } from 'vitest'

import { Route } from './api.skill.references.$'

const GET = (Route as any).options.server.handlers.GET as (ctx: {
  request: Request
}) => Response | Promise<Response>

const call = (pathname: string) =>
  GET({ request: new Request(`http://localhost:3000${pathname}`) })

const flat = (s: string) => s.replace(/\s+/g, ' ')

const publicReferences = ['connect.md', 'create.md', 'update.md']

describe('/api/skill/references/$', () => {
  for (const name of publicReferences) {
    test(`serves ${name} as markdown`, async () => {
      const res = await call(`/api/skill/references/${name}`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
      expect((await res.text()).length).toBeGreaterThan(100)
    })
  }

  test('connect.md owns machine enrollment', async () => {
    const body = flat(await (await call('/api/skill/references/connect.md')).text())
    expect(body).toContain('npm install -g @kky42/pievo@latest')
    expect(body).toContain('daemon start --server-url <server-url> --connect-key <connect-key>')
    expect(body).toContain('daemon already running')
  })

  test('create.md documents the minimal canonical config and confirmation flow', async () => {
    const body = flat(await (await call('/api/skill/references/create.md')).text())
    expect(body).toContain('The stored `prompt` is sent unchanged')
    expect(body).toContain('"schedule": { "mode": "cron"')
    expect(body).toContain('"overlap": "skip"')
    expect(body).toContain('"statusDefinitions": {')
    expect(body).toContain('"keep"')
    expect(body).toContain('"noChange"')
    expect(body).toContain('"block"')
    expect(body).toContain('exact paths relative to `workdir`')
    expect(body).toContain('new --json')
    expect(body).toContain('--dry-run')
    expect(body).toContain('--connect-key <connect-key>')
    expect(body).not.toContain('--agent')
  })

  test('update.md documents only canonical editable fields', async () => {
    const body = flat(await (await call('/api/skill/references/update.md')).text())
    for (const field of ['name', 'schedule', 'workdir', 'agent', 'model', 'reasoningEffort', 'prompt', 'statusDefinitions', 'artifacts', 'enabled']) {
      expect(body).toContain(`\`${field}\``)
    }
    expect(body).toContain('complete exclusive shape')
    expect(body).toContain('edit <loop-id> --json')
    expect(body).toContain('use `<pievo-cli> --help`')
  })

  test('removed public and internal prompt names are not served', async () => {
    for (const name of ['nope.md', 'nested/path.md']) {
      const res = await call(`/api/skill/references/${name}`)
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'not found' })
    }
  })

  test('path traversal and nested paths are refused', async () => {
    for (const path of [
      '/api/skill/references/..%2f..%2fpackage.json',
      '/api/skill/references/sub/create.md',
      '/api/skill/references/create.md/extra',
    ]) {
      expect((await call(path)).status).toBe(404)
    }
  })
})

import { beforeEach, describe, expect, test, vi } from 'vitest'

const h = vi.hoisted(() => ({ readBytes: vi.fn() }))

vi.mock('../db/store.js', () => ({
  getLoop: vi.fn(async (id: string) => {
    return id === 'loop-a' ? { id } : undefined
  }),
}))
vi.mock('../server/artifactFiles.js', () => ({ readLoopArtifactBytes: (...args: unknown[]) => h.readBytes(...args) }))

import { Route } from './api.artifact.$loopId.$'

const GET = (Route as any).options.server.handlers.GET as (ctx: {
  request: Request
}) => Response | Promise<Response>

const call = (pathname: string) =>
  GET({ request: new Request(`http://localhost:3000${pathname}`) })

const bytes = Buffer.from([1, 2, 3, 4])

beforeEach(() => {
  h.readBytes.mockReset()
  h.readBytes.mockResolvedValue({ status: 200, bytes, binary: true, filename: 'pic.png' })
})

describe('/api/artifact/$loopId/$ validation', () => {
  test('malformed percent-encoding in the loop id returns 400', async () => {
    const res = await call('/api/artifact/%zz/report.md')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'bad loop id' })
  })

  test('a lone trailing percent in the loop id returns 400', async () => {
    expect((await call('/api/artifact/loop-1%/report.md')).status).toBe(400)
  })

  test('malformed percent-encoding in a path segment returns 400', async () => {
    const res = await call('/api/artifact/loop-a/data/%zz.json')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'bad path' })
  })

  test('missing file path returns 400', async () => {
    const res = await call('/api/artifact/loop-a')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'missing path' })
  })
})

describe('/api/artifact/$loopId/$ lookup', () => {
  test('a missing loop returns 404 without reading bytes', async () => {
    const res = await call('/api/artifact/missing/report.md')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not found' })
    expect(h.readBytes).not.toHaveBeenCalled()
  })

  test('an existing loop streams the requested path', async () => {
    expect((await call('/api/artifact/loop-a/report.md')).status).toBe(200)
    expect(h.readBytes).toHaveBeenCalledWith('loop-a', 'report.md')
  })
})

describe('/api/artifact/$loopId/$ dispositions', () => {
  test('inline png uses an image content type and hardening headers', async () => {
    const res = await call('/api/artifact/loop-a/pic.png?view=inline')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('content-disposition')).toContain('inline')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toBe('sandbox')
  })

  test('inline svg remains sandboxed', async () => {
    h.readBytes.mockResolvedValue({ status: 200, bytes, binary: false, filename: 'diagram.svg' })
    const res = await call('/api/artifact/loop-a/diagram.svg?view=inline')
    expect(res.headers.get('content-type')).toBe('image/svg+xml')
    expect(res.headers.get('content-disposition')).toContain('inline')
    expect(res.headers.get('content-security-policy')).toBe('sandbox')
  })

  test('inline requested for a non-image stays an attachment', async () => {
    h.readBytes.mockResolvedValue({ status: 200, bytes, binary: false, filename: 'a.html' })
    const res = await call('/api/artifact/loop-a/a.html?view=inline')
    expect(res.headers.get('content-disposition')).toContain('attachment')
    expect(res.headers.get('content-security-policy')).toBeNull()
  })

  test('default disposition remains an attachment', async () => {
    const res = await call('/api/artifact/loop-a/pic.png')
    expect(res.headers.get('content-disposition')).toContain('attachment')
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
  })
})

/**
 * The device-token blob upload route. Exercises the PUT handler directly for the
 * input-validation paths that settle BEFORE the dynamic gateway import (so no DB
 * is touched): a malformed percent-encoded hash must be a clean 400 —
 * `decodeURIComponent` throws a URIError on bad encoding, which used to escape
 * the handler as a 500.
 */
import { describe, expect, test } from 'vitest'

import { BLOB_CAP } from '../gateway/artifacts'
import { Route } from './api.machine.blob.$hash'

const PUT = (Route as any).options.server.handlers.PUT as (ctx: {
  request: Request
}) => Response | Promise<Response>

const call = (pathname: string, headers: Record<string, string> = {}) =>
  PUT({ request: new Request(`http://localhost:3000${pathname}`, { method: 'PUT', headers }) })

describe('/api/machine/blob/$hash', () => {
  test('missing device token → 401 (unchanged guard, runs before the decode)', async () => {
    const res = await call('/api/machine/blob/%zz')
    expect(res.status).toBe(401)
  })

  test('malformed percent-encoding in the hash → 400, not a thrown 500', async () => {
    const res = await call('/api/machine/blob/%zz', { authorization: 'Bearer dev-token' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'bad hash' })
  })

  test('declared oversize is rejected before consuming the body', async () => {
    const body = new ReadableStream<Uint8Array>({ pull() { throw new Error('body must not be read') } })
    const res = await PUT({ request: new Request(`http://localhost:3000/api/machine/blob/${'a'.repeat(64)}`, {
      method: 'PUT',
      headers: { authorization: 'Bearer dev-token', 'content-length': String(BLOB_CAP + 1) },
      body,
      duplex: 'half',
    } as RequestInit) })
    expect(res.status).toBe(413)
  })

  test('chunked upload is canceled and returns 413 at exactly 10MB + 1 byte', async () => {
    let canceled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(BLOB_CAP))
        controller.enqueue(new Uint8Array(1))
        controller.enqueue(new Uint8Array(1024))
      },
      cancel() { canceled = true },
    })
    const res = await PUT({ request: new Request(`http://localhost:3000/api/machine/blob/${'a'.repeat(64)}`, {
      method: 'PUT',
      headers: { authorization: 'Bearer dev-token' },
      body,
      duplex: 'half',
    } as RequestInit) })
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'blob exceeds size cap' })
    expect(canceled).toBe(true)
  })
})

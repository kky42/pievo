/**
 * Machine-route body-size boundary. The gateway's per-field wire caps clip
 * strings AFTER parse; readJsonBody bounds the whole body at ingress so an
 * oversized POST is a clean 413 before any parse/boot work. Exercised on the
 * handlers directly for the paths that settle BEFORE the dynamic boot import
 * (so no DB is touched), plus unit coverage of the helper's result kinds.
 */
import { describe, expect, test } from 'vitest'

import { MACHINE_BODY_CAP, readJsonBody } from '../gateway/http'
import { Route as PollRoute } from './api.machine.poll'
import { Route as ReportRoute } from './machine.report'
import { Route as LoopRoute } from './api.machine.loop'
import { Route as AgentApiRoute } from './agent-api.loop'

type Handler = (ctx: { request: Request }) => Response | Promise<Response>
const handler = (route: unknown, method: string): Handler =>
  (route as any).options.server.handlers[method]

const oversized = (url: string, method = 'POST') =>
  new Request(`http://localhost:3000${url}`, {
    method,
    headers: { authorization: 'Bearer dev-token', 'content-type': 'application/json' },
    body: `{"pad":"${'x'.repeat(MACHINE_BODY_CAP + 1)}"}`,
  })

describe('readJsonBody', () => {
  const req = (body: string, headers: Record<string, string> = {}) =>
    new Request('http://localhost/x', { method: 'POST', headers, body })
  const encoder = new TextEncoder()
  const streamReq = (chunks: string[], cancel?: () => void) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        // Leave an observed oversize stream open so readJsonBody must cancel it.
        if (!cancel) controller.close()
      },
      cancel,
    })
    return new Request('http://localhost/x', {
      method: 'POST',
      body,
      duplex: 'half',
    } as RequestInit)
  }

  test('parses a valid streamed body', async () => {
    expect(await readJsonBody(streamReq(['{"a":', '1}']), 1024)).toEqual({ kind: 'ok', body: { a: 1 } })
  })

  test('chunked oversized body stops and cancels as soon as the byte cap is crossed', async () => {
    let canceled = false
    const request = streamReq(['1234', '5678', 'unread tail'], () => { canceled = true })
    expect(await readJsonBody(request, 5)).toEqual({ kind: 'too-large' })
    expect(canceled).toBe(true)
  })

  test('enforces bytes rather than UTF-16 code units for multibyte JSON', async () => {
    // `"é"` is 3 JS code units but 4 UTF-8 bytes.
    expect(await readJsonBody(streamReq(['"é"']), 3)).toEqual({ kind: 'too-large' })
    expect(await readJsonBody(streamReq(['"é"']), 4)).toEqual({ kind: 'ok', body: 'é' })
  })

  test('unparseable JSON → invalid (each route keeps its own policy)', async () => {
    expect(await readJsonBody(req('not json'), 1024)).toEqual({ kind: 'invalid' })
  })

  test('empty and unreadable bodies parse as {}', async () => {
    expect(await readJsonBody(req(''), 1024)).toEqual({ kind: 'ok', body: {} })
    const unreadable = new ReadableStream<Uint8Array>({
      pull(controller) { controller.error(new Error('read failed')) },
    })
    const request = new Request('http://localhost/x', {
      method: 'POST', body: unreadable, duplex: 'half',
    } as RequestInit)
    expect(await readJsonBody(request, 1024)).toEqual({ kind: 'ok', body: {} })
  })

  test('declared content-length is rejected before streaming', async () => {
    expect(await readJsonBody(req('{}', { 'content-length': '999999' }), 2048)).toEqual({ kind: 'too-large' })
  })
})

describe('machine routes reject an oversized JSON body with 413', () => {
  test.each([
    ['/api/machine/poll', handler(PollRoute, 'POST')],
    ['/machine/report', handler(ReportRoute, 'POST')],
    ['/agent-api/loop', handler(AgentApiRoute, 'POST')],
    ['/api/machine/loop', handler(LoopRoute, 'POST')],
  ])('%s', async (url, h) => {
    const res = await h({ request: oversized(url) })
    expect(res.status).toBe(413)
  })

  test('/api/machine/loop PATCH', async () => {
    const res = await handler(LoopRoute, 'PATCH')({ request: oversized('/api/machine/loop', 'PATCH') })
    expect(res.status).toBe(413)
  })
})

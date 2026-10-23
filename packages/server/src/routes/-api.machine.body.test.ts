/**
 * Machine-route body-size boundary. The gateway's per-field wire caps clip
 * strings AFTER parse; readJsonBody bounds the whole body at ingress so an
 * oversized POST is a clean 413 before any parse/boot work. Exercised on the
 * handlers directly for the paths that settle BEFORE the dynamic boot import
 * (so no DB is touched), plus unit coverage of the helper's result kinds.
 */
import { describe, expect, test } from 'vitest'

import { MACHINE_BODY_CAP, POLL_VERSION_CAP, WIRE_TEXT_CAP, readJsonBody } from '../gateway/http'
import { parsePollBody, Route as PollRoute } from './api.machine.poll'
import { Route as ReportRoute } from './machine.report'
import { Route as CliRoute } from './api.machine.cli'

type Handler = (ctx: { request: Request }) => Response | Promise<Response>
const handler = (route: unknown, method: string): Handler =>
  (route as any).options.server.handlers[method]

const oversized = (url: string, method = 'POST', cap = MACHINE_BODY_CAP) =>
  new Request(`http://localhost:3000${url}`, {
    method,
    headers: { authorization: 'Bearer dev-token', 'content-type': 'application/json' },
    body: `{"pad":"${'x'.repeat(cap + 1)}"}`,
  })

describe('readJsonBody', () => {
  const req = (body: string, headers: Record<string, string> = {}) =>
    new Request('http://localhost/x', { method: 'POST', headers, body })
  const encoder = new TextEncoder()
  const streamReq = (chunks: string[], cancel?: () => void) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
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
    expect(await readJsonBody(streamReq(['"é"']), 3)).toEqual({ kind: 'too-large' })
    expect(await readJsonBody(streamReq(['"é"']), 4)).toEqual({ kind: 'ok', body: 'é' })
  })

  test('unparseable JSON → invalid (each route keeps its own policy)', async () => {
    expect(await readJsonBody(req('not json'), 1024)).toEqual({ kind: 'invalid' })
  })

  test('empty bodies parse as {} and unreadable streams are invalid', async () => {
    expect(await readJsonBody(req(''), 1024)).toEqual({ kind: 'ok', body: {} })
    const unreadable = new ReadableStream<Uint8Array>({
      pull(controller) { controller.error(new Error('read failed')) },
    })
    const request = new Request('http://localhost/x', {
      method: 'POST', body: unreadable, duplex: 'half',
    } as RequestInit)
    expect(await readJsonBody(request, 1024)).toEqual({ kind: 'invalid' })
  })

  test('declared content-length is rejected before streaming', async () => {
    expect(await readJsonBody(req('{}', { 'content-length': '999999' }), 2048)).toEqual({ kind: 'too-large' })
  })
})

test('poll HTTP envelope has an exact, strictly typed field allowlist', () => {
  expect(parsePollBody({ protocolVersion: 7, recoveryComplete: true })).not.toBeNull()
  expect(parsePollBody({ protocolVersion: 7, recoveryComplete: true, unknown: true })).toBeNull()
  expect(parsePollBody({ host: 42 })).toBeNull()
  expect(parsePollBody({ platform: null })).toBeNull()
  expect(parsePollBody({ arch: ['arm64'] })).toBeNull()
  expect(parsePollBody({ version: { value: '4.0.0' } })).toBeNull()
  expect(parsePollBody({ host: 'mac\0forged' })).toBeNull()
  expect(parsePollBody({ host: 'h'.repeat(WIRE_TEXT_CAP + 1) })).toBeNull()
  expect(parsePollBody({ version: 'v'.repeat(POLL_VERSION_CAP + 1) })).toBeNull()
  expect(parsePollBody({ currentRuns: [{ runId: 'run-1', stage: 'reporting' }] })).not.toBeNull()
  expect(parsePollBody({ currentRuns: [{ runId: 'run-1', stage: 'reporting', unknown: true }] })).toBeNull()
  expect(parsePollBody({ currentRuns: [{ runId: 'run-1', stage: 'waiting' }] })).toBeNull()
  expect(parsePollBody([])).toBeNull()
  expect(parsePollBody(null)).toBeNull()
})

test.each([
  ['invalid JSON', 'not json'],
  ['an unknown field', JSON.stringify({ protocolVersion: 7, unknown: true })],
  ['a non-string host', JSON.stringify({ protocolVersion: 7, host: 42 })],
  ['a NUL-bearing platform', JSON.stringify({ protocolVersion: 7, platform: 'darwin\0x' })],
  ['an over-cap version', JSON.stringify({ protocolVersion: 7, version: 'v'.repeat(POLL_VERSION_CAP + 1) })],
])('poll route rejects %s before boot', async (_label, body) => {
  const h = handler(PollRoute, 'POST')
  const res = await h({ request: new Request('http://localhost:3000/api/machine/poll', {
    method: 'POST',
    headers: { authorization: 'Bearer dev-token', 'content-type': 'application/json' },
    body,
  }) })
  expect(res.status).toBe(400)
})

test.each([
  ['invalid JSON', 'not json'],
  ['an array', '[]'],
  ['null', 'null'],
  ['a missing argv field', '{}'],
  ['a non-array argv', '{"argv":"loops"}'],
  ['a non-string argv entry', '{"argv":["loops",1]}'],
  ['an unknown field', '{"argv":[],"unknown":true}'],
])('CLI route rejects %s with 400 before boot', async (_label, body) => {
  const h = handler(CliRoute, 'POST')
  const res = await h({ request: new Request('http://localhost:3000/api/machine/cli', {
    method: 'POST',
    headers: { authorization: 'Bearer dev-token', 'content-type': 'application/json' },
    body,
  }) })
  expect(res.status).toBe(400)
})

describe('machine routes reject an oversized JSON body with 413', () => {
  test.each([
    ['/api/machine/poll', handler(PollRoute, 'POST')],
    ['/machine/report', handler(ReportRoute, 'POST')],
  ])('%s', async (url, h) => {
    const res = await h({ request: oversized(url) })
    expect(res.status).toBe(413)
  })

  test('/api/machine/cli allows file set payloads up to its 4 MB cap', async () => {
    const res = await handler(CliRoute, 'POST')({ request: oversized('/api/machine/cli', 'POST', 4 * 1024 * 1024) })
    expect(res.status).toBe(413)
  })
})

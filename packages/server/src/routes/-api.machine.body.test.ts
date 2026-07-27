/**
 * Machine-route body-size boundary. The gateway's per-field wire caps clip
 * strings AFTER parse; readJsonBody bounds the whole body at ingress so an
 * oversized POST is a clean 413 before any parse/boot work. Exercised on the
 * handlers directly for the paths that settle BEFORE the dynamic boot import
 * (so no DB is touched), plus unit coverage of the helper's result kinds.
 */
import { describe, expect, test } from 'vitest'

import { SYNC_BODY_CAP } from '../gateway/artifacts'
import { MACHINE_BODY_CAP, POLL_INFO_TEXT_CAP, POLL_VERSION_CAP, readJsonBody } from '../gateway/http'
import { gatewayPollRequest, parsePollBody, Route as PollRoute } from './api.machine.poll'
import { Route as ReportRoute } from './machine.report'
import { parseCliBody, Route as CliRoute } from './api.machine.cli'
import { Route as SyncRoute } from './api.machine.sync'

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

test('poll route forwards a completed recovery snapshot and constructs exact machine info', () => {
  expect(gatewayPollRequest({
    protocolVersion: 4,
    daemonInstanceId: 'daemon-new',
    recoveryComplete: true,
    currentRuns: [{ runId: 'run-1', stage: 'reporting' }],
    host: 'mac',
  })).toEqual({
    protocolVersion: 4,
    daemonInstanceId: 'daemon-new',
    recoveryComplete: true,
    currentRuns: [{ runId: 'run-1', stage: 'reporting' }],
    info: { host: 'mac', platform: undefined, arch: undefined, version: undefined },
  })
})

test('poll HTTP envelope has an exact, strictly typed field allowlist', () => {
  expect(parsePollBody({ protocolVersion: 4, recoveryComplete: true })).not.toBeNull()
  expect(parsePollBody({ protocolVersion: 4, recoveryComplete: true, unknown: true })).toBeNull()
  expect(parsePollBody({ host: 42 })).toBeNull()
  expect(parsePollBody({ platform: null })).toBeNull()
  expect(parsePollBody({ arch: ['arm64'] })).toBeNull()
  expect(parsePollBody({ version: { value: '2.4.0' } })).toBeNull()
  expect(parsePollBody({ host: 'mac\0forged' })).toBeNull()
  expect(parsePollBody({ host: 'h'.repeat(POLL_INFO_TEXT_CAP + 1) })).toBeNull()
  expect(parsePollBody({ version: 'v'.repeat(POLL_VERSION_CAP + 1) })).toBeNull()
  expect(parsePollBody([])).toBeNull()
  expect(parsePollBody(null)).toBeNull()
})

test.each([
  ['invalid JSON', 'not json'],
  ['an unknown field', JSON.stringify({ protocolVersion: 4, unknown: true })],
  ['a non-string host', JSON.stringify({ protocolVersion: 4, host: 42 })],
  ['a NUL-bearing platform', JSON.stringify({ protocolVersion: 4, platform: 'darwin\0x' })],
  ['an over-cap version', JSON.stringify({ protocolVersion: 4, version: 'v'.repeat(POLL_VERSION_CAP + 1) })],
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
  ['an unknown top-level field', '{"loopId":"loop-test","manifest":[],"blobs":[]}'],
  ['a missing manifest', '{"loopId":"loop-test"}'],
  ['a non-array manifest', '{"loopId":"loop-test","manifest":{}}'],
  ['an item with missing exact fields', '{"loopId":"loop-test","manifest":[{"path":"report.md","hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":1]}]}'],
])('sync route rejects %s with 400 before boot', async (_label, body) => {
  const h = handler(SyncRoute, 'POST')
  const res = await h({ request: new Request('http://localhost:3000/api/machine/sync', {
    method: 'POST',
    headers: { authorization: 'Bearer dev-token', 'content-type': 'application/json' },
    body,
  }) })
  expect(res.status).toBe(400)
})

test('sync route enforces its dedicated manifest body cap before boot', async () => {
  const h = handler(SyncRoute, 'POST')
  const res = await h({ request: new Request('http://localhost:3000/api/machine/sync', {
    method: 'POST',
    headers: {
      authorization: 'Bearer dev-token',
      'content-type': 'application/json',
      'content-length': String(SYNC_BODY_CAP + 1),
    },
    body: '{}',
  }) })
  expect(res.status).toBe(413)
})

test('CLI body parser accepts only the exact argv envelope', () => {
  expect(parseCliBody({ argv: [] })).toEqual({ argv: [] })
  expect(parseCliBody({ argv: ['loops', '--json'] })).toEqual({ argv: ['loops', '--json'] })
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
    ['/api/machine/cli', handler(CliRoute, 'POST')],
  ])('%s', async (url, h) => {
    const res = await h({ request: oversized(url) })
    expect(res.status).toBe(413)
  })
})

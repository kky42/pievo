import { createFileRoute } from '@tanstack/react-router'
import { readByteBody } from '../gateway/http'
import { safeDecode } from '../lib/url'

/**
 * GET|PUT /api/machine/run-files/:name — loop-file transfer for one run (Bearer
 * RUN token). GET returns the version the run starts from, with its sha256 in
 * `x-pievo-sha256`; PUT stores a version the run produced (the daemon sends the
 * expected sha256 in the same header). A PUT never changes the loop: only the
 * terminal report applies stored versions, under the loop lock.
 *
 * Not rate limited: a live run token is required and every body is bounded by
 * the per-file loop-file limit.
 */
function bearer(request: Request): string {
  const auth = request.headers.get('authorization') ?? ''
  return auth.startsWith('Bearer ') ? auth.slice(7) : ''
}

function fileName(request: Request): string | null {
  return safeDecode(new URL(request.url).pathname.split('/').pop() ?? '')
}

export const Route = createFileRoute('/api/machine/run-files/$name')({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const token = bearer(request)
        if (!token) return Response.json({ error: 'missing run token' }, { status: 401 })
        const name = fileName(request)
        if (name === null) return Response.json({ error: 'bad file name' }, { status: 400 })
        const { getGateway } = await import('../server/boot.js')
        const r = await (await getGateway()).readRunFile(token, name)
        if (r.status !== 200 || !r.bytes || !r.hash) return Response.json(r.body, { status: r.status })
        return new Response(new Uint8Array(r.bytes), {
          status: 200,
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': String(r.bytes.length),
            'x-pievo-sha256': r.hash,
            'cache-control': 'private, no-store',
          },
        })
      },
      PUT: async ({ request }: { request: Request }) => {
        const token = bearer(request)
        if (!token) return Response.json({ error: 'missing run token' }, { status: 401 })
        const name = fileName(request)
        if (name === null) return Response.json({ error: 'bad file name' }, { status: 400 })
        const { LOOP_FILE_BYTE_CAP } = await import('../gateway/loopFiles.js')
        const body = await readByteBody(request, LOOP_FILE_BYTE_CAP)
        if (body.kind === 'too-large') return Response.json({ error: 'file exceeds the loop-file size limit' }, { status: 413 })
        if (body.kind === 'invalid') return Response.json({ error: 'could not read file body' }, { status: 400 })
        const bytes = Buffer.from(body.bytes.buffer, body.bytes.byteOffset, body.bytes.byteLength)
        const { getGateway } = await import('../server/boot.js')
        const r = await (await getGateway()).storeRunFile(token, name, bytes, request.headers.get('x-pievo-sha256'))
        return Response.json(r.body, { status: r.status })
      },
    },
  },
})

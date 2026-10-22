import { createFileRoute } from '@tanstack/react-router'
import { safeDecode } from '../lib/url'
import { imageMime } from '../lib/artifactKind'

/**
 * GET /api/artifact/:loopId/:path streams one loop file. Default disposition is
 * `attachment`. `?view=inline` is honored only for the `imageMime` allowlist, and
 * is hardened against a direct navigation scripting the app origin:
 * `nosniff` pins the type and `Content-Security-Policy: sandbox` gives the
 * document an opaque origin, so an SVG opened directly cannot run script. The path
 * must match a stored file row exactly; blob keys are content hashes.
 */
const PREFIX = '/api/artifact/'

export const Route = createFileRoute('/api/artifact/$loopId/$')({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const pathname = new URL(request.url).pathname
        if (!pathname.startsWith(PREFIX)) return Response.json({ error: 'not found' }, { status: 404 })
        const after = pathname.slice(PREFIX.length)
        const slash = after.indexOf('/')
        if (slash < 0) return Response.json({ error: 'missing path' }, { status: 400 })
        const loopId = safeDecode(after.slice(0, slash))
        if (loopId === null) return Response.json({ error: 'bad loop id' }, { status: 400 })
        const segments = after
          .slice(slash + 1)
          .split('/')
          .map((s) => safeDecode(s))
        if (segments.some((s) => s === null)) return Response.json({ error: 'bad path' }, { status: 400 })
        const relPath = segments.join('/')

        const store = await import('../db/store.js')
        const loop = await store.getLoop(loopId)
        if (!loop) return Response.json({ error: 'not found' }, { status: 404 })

        const { readLoopArtifactBytes } = await import('../server/artifactFiles.js')
        const r = await readLoopArtifactBytes(loopId, relPath)
        if (r.status !== 200 || !r.bytes)
          return Response.json({ error: 'not found' }, { status: r.status })

        const filename = (r.filename || 'file').replace(/["\\\r\n]/g, '_')
        const inline = new URL(request.url).searchParams.get('view') === 'inline'
        const mime = inline ? imageMime(relPath) : null
        if (mime) {
          return new Response(new Uint8Array(r.bytes), {
            status: 200,
            headers: {
              'content-type': mime,
              'content-length': String(r.bytes.length),
              'content-disposition': `inline; filename="${filename}"`,
              // Pin the type + neuter any scripted document (SVG) served inline.
              'x-content-type-options': 'nosniff',
              'content-security-policy': 'sandbox',
              'cache-control': 'private, no-store',
            },
          })
        }
        return new Response(new Uint8Array(r.bytes), {
          status: 200,
          headers: {
            'content-type': r.binary ? 'application/octet-stream' : 'text/plain; charset=utf-8',
            'content-length': String(r.bytes.length),
            'content-disposition': `attachment; filename="${filename}"`,
            'cache-control': 'private, no-store',
          },
        })
      },
    },
  },
})

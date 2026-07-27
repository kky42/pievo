import { createFileRoute } from '@tanstack/react-router'

// The Pievo skill references are inlined at build time so they ship in the Nitro
// bundle. Normally an owner agent reads the user-scope installation; when that
// install is unavailable, `skill/bootstrap.md` (served at `/api/bootstrap`) links
// to these exact fallback documents.
import connect from '../skill/references/connect.md?raw'
import create from '../skill/references/create.md?raw'
import update from '../skill/references/update.md?raw'

const REFERENCES: Record<string, string> = {
  'connect.md': connect,
  'create.md': create,
  'update.md': update,
}

const PREFIX = '/api/skill/references/'

/**
 * GET /api/skill/references/:file — serve one pievo skill reference file. Path-safe:
 * only an exact, single-segment name from the static REFERENCES map resolves; anything
 * else (nested paths, traversal, unknown names) is 404. The server only reads bytes it
 * shipped — no filesystem access, no user input reaches disk (zero-exec invariant holds).
 */
export const Route = createFileRoute('/api/skill/references/$')({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) => {
        const pathname = new URL(request.url).pathname
        if (!pathname.startsWith(PREFIX)) return Response.json({ error: 'not found' }, { status: 404 })
        const name = pathname.slice(PREFIX.length)
        const body = Object.prototype.hasOwnProperty.call(REFERENCES, name) ? REFERENCES[name] : undefined
        if (body === undefined) return Response.json({ error: 'not found' }, { status: 404 })
        return new Response(body, {
          headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-cache' },
        })
      },
    },
  },
})

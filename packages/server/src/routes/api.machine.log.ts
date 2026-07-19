import { createFileRoute } from '@tanstack/react-router'
import { machineRouteLimit } from '../gateway/rateLimit'

/** GET /api/machine/log?loopId=<id>&limit=<n> — normalized recent run history
 *  for a loop bound to this machine (Bearer device token). */
export const Route = createFileRoute('/api/machine/log')({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const auth = request.headers.get('authorization') ?? ''
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
        const limited = machineRouteLimit(request, token || undefined)
        if (limited) return limited
        if (!token) return Response.json({ error: 'missing device token' }, { status: 401 })
        const url = new URL(request.url)
        const loopId = url.searchParams.get('loopId') ?? ''
        const limit = url.searchParams.get('limit') ?? undefined
        const { getGateway } = await import('../server/boot.js')
        const r = await (await getGateway()).loopLog(token, loopId, limit)
        return Response.json(r.body, { status: r.status })
      },
    },
  },
})

import { createFileRoute } from '@tanstack/react-router'
import { MACHINE_BODY_CAP, readJsonBody } from '../gateway/http'
import { machineRouteLimit } from '../gateway/rateLimit'

/** POST /agent-api/loop — the `pievo` shim's verbs (Bearer run token). */
export const Route = createFileRoute('/agent-api/loop')({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const auth = request.headers.get('authorization') ?? ''
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
        const limited = machineRouteLimit(request, token || undefined)
        if (limited) return limited
        if (!token) return Response.json({ text: 'pievo: missing token', exitCode: 1 }, { status: 401 })
        const parsed = await readJsonBody(request, MACHINE_BODY_CAP)
        if (parsed.kind === 'too-large')
          return Response.json({ text: 'pievo: body too large', exitCode: 1 }, { status: 413 })
        const body = (parsed.kind === 'ok' ? parsed.body : {}) as { argv?: string[] }
        const { getCliGateway } = await import('../server/boot.js')
        const r = await (await getCliGateway()).agentApi(token, Array.isArray(body.argv) ? body.argv : [])
        return Response.json(r.body, { status: r.status })
      },
    },
  },
})

import { createFileRoute } from '@tanstack/react-router'
import { MACHINE_BODY_CAP, readJsonBody } from '../gateway/http'
import { machineRouteLimit } from '../gateway/rateLimit'

type PollBody = {
  host?: string
  platform?: string
  arch?: string
  version?: string
  protocolVersion?: number
  currentRuns?: Array<{ runId: string; stage: 'executing' | 'reporting' }>
  daemonInstanceId?: string
  recoveryComplete?: boolean
  watchDigest?: string
}

/** Keep the HTTP adapter's protocol forwarding independently testable. */
export function gatewayPollRequest(body: PollBody) {
  return {
    protocolVersion: body.protocolVersion,
    currentRuns: body.currentRuns,
    daemonInstanceId: body.daemonInstanceId,
    recoveryComplete: body.recoveryComplete,
    watchDigest: typeof body.watchDigest === 'string' ? body.watchDigest : undefined,
    info: body,
  }
}

/** POST /api/machine/poll — daemon claims this machine's pending runs (Bearer device token). */
export const Route = createFileRoute('/api/machine/poll')({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const auth = request.headers.get('authorization') ?? ''
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
        const limited = machineRouteLimit(request, token || undefined)
        if (limited) return limited
        if (!token) return Response.json({ error: 'missing device token' }, { status: 401 })
        const parsed = await readJsonBody(request, MACHINE_BODY_CAP)
        if (parsed.kind === 'too-large') return Response.json({ error: 'body too large' }, { status: 413 })
        const body = (parsed.kind === 'ok' ? parsed.body : {}) as PollBody
        const { getGateway } = await import('../server/boot.js')
        const r = await (await getGateway()).pollV3Wait(token, gatewayPollRequest(body))
        return Response.json(r.body, { status: r.status })
      },
    },
  },
})

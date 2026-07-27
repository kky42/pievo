import { createFileRoute } from '@tanstack/react-router'
import { MACHINE_BODY_CAP, POLL_INFO_TEXT_CAP, POLL_VERSION_CAP, readJsonBody, validOptionalPollString } from '../gateway/http'
import { machineRouteLimit } from '../gateway/rateLimit'

export type PollBody = {
  host?: string
  platform?: string
  arch?: string
  version?: string
  protocolVersion?: number
  currentRuns?: Array<{ runId: string; stage: 'executing' | 'reporting' }>
  daemonInstanceId?: string
  recoveryComplete?: boolean
}

const POLL_BODY_FIELDS = new Set<keyof PollBody>([
  'host', 'platform', 'arch', 'version', 'protocolVersion',
  'currentRuns', 'daemonInstanceId', 'recoveryComplete',
])

const validWireId = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 200 && value.trim().length > 0 && !value.includes('\0')

const validCurrentRun = (value: unknown): value is NonNullable<PollBody['currentRuns']>[number] =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === 2
  && Object.prototype.hasOwnProperty.call(value, 'runId')
  && Object.prototype.hasOwnProperty.call(value, 'stage')
  && validWireId((value as { runId?: unknown }).runId)
  && ((value as { stage?: unknown }).stage === 'executing' || (value as { stage?: unknown }).stage === 'reporting')

/** Reject non-object bodies, additions, coercible types, over-cap strings, and
 * NUL-bearing text before the gateway is loaded or any state can mutate. */
export function parsePollBody(value: unknown): PollBody | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  if (Object.keys(value).some((key) => !POLL_BODY_FIELDS.has(key as keyof PollBody))) return null
  const body = value as Record<string, unknown>
  if (!validOptionalPollString(body.host, POLL_INFO_TEXT_CAP)
    || !validOptionalPollString(body.platform, POLL_INFO_TEXT_CAP)
    || !validOptionalPollString(body.arch, POLL_INFO_TEXT_CAP)
    || !validOptionalPollString(body.version, POLL_VERSION_CAP)) return null
  if (body.protocolVersion !== undefined && (typeof body.protocolVersion !== 'number' || !Number.isInteger(body.protocolVersion))) return null
  if (body.currentRuns !== undefined && (!Array.isArray(body.currentRuns) || body.currentRuns.some((run) => !validCurrentRun(run)))) return null
  if (body.daemonInstanceId !== undefined && !validWireId(body.daemonInstanceId)) return null
  if (body.recoveryComplete !== undefined && typeof body.recoveryComplete !== 'boolean') return null
  return body as PollBody
}

/** Keep the HTTP adapter's protocol forwarding independently testable. */
export function gatewayPollRequest(body: PollBody) {
  return {
    protocolVersion: body.protocolVersion,
    currentRuns: body.currentRuns,
    daemonInstanceId: body.daemonInstanceId,
    recoveryComplete: body.recoveryComplete,
    info: {
      host: body.host,
      platform: body.platform,
      arch: body.arch,
      version: body.version,
    },
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
        if (parsed.kind !== 'ok') return Response.json({ error: 'invalid JSON body' }, { status: 400 })
        const body = parsePollBody(parsed.body)
        if (!body) return Response.json({ error: 'unknown or invalid poll body fields' }, { status: 400 })
        const { getGateway } = await import('../server/boot.js')
        const r = await (await getGateway()).pollV4Wait(token, gatewayPollRequest(body))
        return Response.json(r.body, { status: r.status })
      },
    },
  },
})

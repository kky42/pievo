import { createFileRoute } from '@tanstack/react-router'
import { readJsonBody } from '../gateway/http'

/**
 * POST /api/machine/sync — exact artifact sync (Bearer DEVICE token). The daemon
 * posts the complete configured-path manifest after a run; the server reconciles
 * artifact_files and replies with needHashes for raw blob PUTs.
 * The manifest route retains its dedicated 32 MB JSON-body limit.
 *
 * This byte-ingress route is deliberately NOT rate limited (same rationale as the
 * blob PUT): it requires a valid registered device token (unknown ⇒ 401) and is
 * already bounded by the exact-path/hash handshake and 32MB sync-body cap, so a
 * limiter would only throttle a legitimate large sync.
 */
export const Route = createFileRoute('/api/machine/sync')({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const auth = request.headers.get('authorization') ?? ''
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
        if (!token) return Response.json({ error: 'missing device token' }, { status: 401 })
        const { SYNC_BODY_CAP, parseArtifactSyncBody } = await import('../gateway/artifacts.js')
        const parsed = await readJsonBody(request, SYNC_BODY_CAP)
        if (parsed.kind === 'too-large') return Response.json({ error: 'sync body too large' }, { status: 413 })
        if (parsed.kind === 'invalid') return Response.json({ error: 'invalid JSON' }, { status: 400 })
        const body = parseArtifactSyncBody(parsed.body)
        if (!body) return Response.json({ error: 'invalid sync body' }, { status: 400 })
        const { getArtifactSync } = await import('../server/boot.js')
        const r = await (await getArtifactSync()).sync(token, body)
        return Response.json(r.body, { status: r.status })
      },
    },
  },
})

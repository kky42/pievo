import { createFileRoute } from '@tanstack/react-router'
import { machineJsonRoute } from '../gateway/machineRoute'

export function parseCliBody(value: unknown): { argv: string[] } | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const body = value as Record<string, unknown>
  if (Object.keys(body).length !== 1 || !Object.prototype.hasOwnProperty.call(body, 'argv')) return null
  if (!Array.isArray(body.argv) || body.argv.some((entry) => typeof entry !== 'string')) return null
  return { argv: body.argv as string[] }
}

/**
 * POST /api/machine/cli — the ONE unified CLI dispatch (Bearer credential + `{argv}`).
 * `CliGateway.cli()` branches by credential type: a `dk_` device token takes owner
 * commands; an `rk_` run credential is rejected. The 4 MB body cap fits
 * `file set` carrying a 2 MB artifact as base64 (4/3 expansion) plus argv framing.
 */
const CLI_BODY_CAP = 4 * 1024 * 1024
export const Route = createFileRoute('/api/machine/cli')({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        return machineJsonRoute(request, {
          missingCredential: 'missing credential',
          maxBytes: CLI_BODY_CAP,
          invalidJsonError: 'body must be exactly {argv:string[]}',
          invalidBodyError: 'body must be exactly {argv:string[]}',
          parseBody: parseCliBody,
          handle: async (token, body) => {
            const { getCliGateway } = await import('../server/boot.js')
            const r = await (await getCliGateway()).cli(token, body.argv)
            return Response.json(r.body, { status: r.status })
          },
        })
      },
    },
  },
})

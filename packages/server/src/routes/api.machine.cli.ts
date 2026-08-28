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
 * commands, while an `rk_` run credential can only report its run. Uses the standard
 * 2MB machine JSON body cap.
 */
export const Route = createFileRoute('/api/machine/cli')({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        return machineJsonRoute(request, {
          missingCredential: 'missing credential',
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

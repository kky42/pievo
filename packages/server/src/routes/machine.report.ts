import { createFileRoute } from '@tanstack/react-router'
import { machineJsonRoute } from '../gateway/machineRoute'

export const Route = createFileRoute('/machine/report')({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        return machineJsonRoute(request, {
          missingCredential: 'missing token',
          invalidBody: {},
          parseBody: (value) => value && typeof value === 'object' ? value : {},
          handle: async (token, body) => {
            const { getGateway } = await import('../server/boot.js')
            const gw = await getGateway()
            const r = await gw.report(token, body as Parameters<typeof gw.report>[1])
            return Response.json(r.body, { status: r.status })
          },
        })
      },
    },
  },
})

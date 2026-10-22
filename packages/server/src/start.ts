import { createMiddleware, createStart } from '@tanstack/react-start'

/** Rejects requests from outside this machine, the LAN, and the tailnet. */
const networkAccess = createMiddleware().server(async ({ request, next }) => {
  const { isTrustedPeer } = await import('./server/networkAccess.js')
  const peer = (request as Request & { ip?: string }).ip
  if (!isTrustedPeer(peer)) {
    return new Response('Pievo only accepts connections from this machine, the local network, or Tailscale.', { status: 403 })
  }
  return next()
})

export const startInstance = createStart(() => ({ requestMiddleware: [networkAccess] }))

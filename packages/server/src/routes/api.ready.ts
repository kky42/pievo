import { createFileRoute } from '@tanstack/react-router'

import { ensureServer } from '../server/boot.js'

/**
 * Deep readiness for process launchers. Unlike /api/health, this waits for the
 * one-time backend boot (migrations, blob-store selection, and scheduler start).
 * The per-launch nonce lets a launcher reject a different process already bound
 * to the requested port.
 */
export async function readyResponse(
  ensure: typeof ensureServer = ensureServer,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Response> {
  await ensure()
  return Response.json({ ok: true, nonce: env.PIEVO_SERVER_LAUNCH_NONCE ?? null })
}

export const Route = createFileRoute('/api/ready')({
  server: {
    handlers: {
      GET: () => readyResponse(),
    },
  },
})

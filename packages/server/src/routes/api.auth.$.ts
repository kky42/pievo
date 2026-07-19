import { createFileRoute } from '@tanstack/react-router'

/** Better Auth handler — GET/POST /api/auth/* (OAuth callbacks, session, sign-out). */
export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => (await import('../auth.js')).auth.handler(request),
      POST: async ({ request }: { request: Request }) => (await import('../auth.js')).auth.handler(request),
    },
  },
})

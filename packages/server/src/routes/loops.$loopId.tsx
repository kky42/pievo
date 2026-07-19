import { createFileRoute } from '@tanstack/react-router'
import { getAuthState } from '../server/loopApi'
import { authClient, useSession } from '../lib/auth-client'
import { LoopDetailView } from '../components/LoopDetailView'
import { SignIn } from '../components/SignIn'

/**
 * Loop detail PAGE — `/loops/$loopId`. The dedicated page that replaced the old
 * dashboard modal: a loop header + action toolbar, the unified Files panel (task
 * file alongside synced artifacts), and the runs timeline. The view owns its own
 * data + self-poll (ssr:false so the session cookie rides along with its fetches,
 * like the dashboard loader). Run rows link on to `/loops/$loopId/runs/$runId`.
 *
 * Auth-gated exactly like the dashboard (`/`): the loader checks getAuthState +
 * the session so a logged-out/expired DEEP LINK shows the sign-in CTA instead of
 * a raw `loop not found` error from the ownership-blocked data fetch.
 */
export const Route = createFileRoute('/loops/$loopId')({
  ssr: false,
  loader: async () => {
    const auth = await getAuthState()
    if (auth.enabled) {
      const { data: session } = await authClient.getSession()
      if (!session) return { auth }
    }
    return { auth }
  },
  component: LoopDetailPage,
})

function LoopDetailPage() {
  const { loopId } = Route.useParams()
  const { auth } = Route.useLoaderData() ?? { auth: { enabled: false } }
  const { data: session, isPending } = useSession()
  if (auth?.enabled && !isPending && !session)
    return <SignIn callbackURL={`/loops/${loopId}`} />
  return <LoopDetailView id={loopId} />
}

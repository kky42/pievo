import { createFileRoute } from '@tanstack/react-router'
import { getAuthState } from '../server/loopApi'
import { useSession } from '../lib/auth-client'
import { LoopDetailView } from '../components/LoopDetailView'
import { SignIn } from '../components/SignIn'
import { OpenModeWarning } from '../components/OpenModeWarning'
import { Loading } from '../components/ui'

/**
 * Loop detail page — `/loops/$loopId`: a loop header and action toolbar, the
 * exact artifact Files panel, and the runs timeline. The view owns its own
 * data + self-poll (ssr:false so the session cookie rides along with its fetches,
 * like the dashboard loader). Run rows link on to `/loops/$loopId/runs/$runId`.
 *
 * Auth-gated exactly like the dashboard (`/`): Better Auth's session hook keeps a
 * logged-out or expired deep link from mounting the ownership-scoped data view.
 */
export const Route = createFileRoute('/loops/$loopId')({
  ssr: false,
  loader: async () => ({ auth: await getAuthState() }),
  component: LoopDetailPage,
})

function LoopDetailPage() {
  const { loopId } = Route.useParams()
  const { auth } = Route.useLoaderData() ?? { auth: { enabled: false } }
  const { data: session, isPending } = useSession()
  if (auth.enabled && isPending) {
    return <main className="mx-auto max-w-[1360px] px-8 pt-10"><Loading /></main>
  }
  if (auth.enabled && !session) return <SignIn callbackURL={`/loops/${loopId}`} />
  return (
    <>
      {!auth.enabled && <div className="mx-auto max-w-[1360px] px-8 pt-6"><OpenModeWarning /></div>}
      <LoopDetailView id={loopId} />
    </>
  )
}

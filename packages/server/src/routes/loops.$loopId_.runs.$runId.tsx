import { createFileRoute, Link } from '@tanstack/react-router'
import { getAuthState } from '../server/loopApi'
import { useSession } from '../lib/auth-client'
import { RunDetailView } from '../components/RunView'
import { SignIn } from '../components/SignIn'
import { OpenModeWarning } from '../components/OpenModeWarning'
import { Loading } from '../components/ui'

/**
 * Run detail PAGE — `/loops/$loopId/runs/$runId`. A standalone page (the trailing
 * `_` on the `$loopId` segment opts it out of the loop page's component so the run
 * gets its own full surface, deep-linkable + browser-back friendly) rather than a
 * modal or an inline panel. It resolves the run from the loop's detail payload
 * (reusing getLoopDetail) and the existing artifact diff.
 *
 * Auth-gated like the dashboard (`/`) so Better Auth's session hook keeps a
 * logged-out or expired deep link from mounting the run view.
 */
export const Route = createFileRoute('/loops/$loopId_/runs/$runId')({
  ssr: false,
  loader: async () => ({ auth: await getAuthState() }),
  component: RunDetailPage,
})

function RunDetailPage() {
  const { loopId, runId } = Route.useParams()
  const { auth } = Route.useLoaderData() ?? { auth: { enabled: false } }
  const { data: session, isPending } = useSession()
  if (auth.enabled && isPending) {
    return <main className="mx-auto max-w-[1360px] px-8 pt-10"><Loading /></main>
  }
  if (auth.enabled && !session) return <SignIn callbackURL={`/loops/${loopId}/runs/${runId}`} />
  return (
    <main className="mx-auto max-w-[1360px] px-8 pb-24 pt-6">
      {!auth.enabled && <OpenModeWarning className="mb-6" />}
      <div className="mb-5">
        <Link
          to="/loops/$loopId"
          params={{ loopId }}
          className="inline-flex items-center gap-1.5 text-label font-medium text-secondary transition-colors hover:text-display"
        >
          <span aria-hidden>←</span> Back to loop
        </Link>
      </div>
      <RunDetailView loopId={loopId} runId={runId} />
    </main>
  )
}

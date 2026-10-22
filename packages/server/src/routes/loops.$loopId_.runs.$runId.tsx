import { createFileRoute, Link } from '@tanstack/react-router'
import { RunDetailView } from '../components/RunView'

/**
 * Run detail PAGE — `/loops/$loopId/runs/$runId`. A standalone page (the trailing
 * `_` on the `$loopId` segment opts it out of the loop page's component so the run
 * gets its own full surface, deep-linkable + browser-back friendly) rather than a
 * modal or an inline panel. It resolves the run from the loop's detail payload
 * (reusing getLoopDetail) and the existing loop-file diff.
 */
export const Route = createFileRoute('/loops/$loopId_/runs/$runId')({
  ssr: false,
  component: RunDetailPage,
})

function RunDetailPage() {
  const { loopId, runId } = Route.useParams()
  return (
    <main className="mx-auto max-w-[1360px] px-8 pb-24 pt-6">
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

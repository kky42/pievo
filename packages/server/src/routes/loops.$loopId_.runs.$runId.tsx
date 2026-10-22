import { createFileRoute, Link } from '@tanstack/react-router'
import { RunDetailView } from '../components/RunView'

/** The trailing `_` on `$loopId` opts the run page out of the loop page's component,
 * so a run gets its own deep-linkable, back-button-friendly page. */
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

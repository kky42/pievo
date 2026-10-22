import { createFileRoute } from '@tanstack/react-router'
import { LoopDetailView } from '../components/LoopDetailView'

/**
 * Loop detail page — `/loops/$loopId`: a loop header and action toolbar, the
 * loop Files panel, and the runs timeline. The view owns its own data + self-poll.
 * Run rows link on to `/loops/$loopId/runs/$runId`.
 */
export const Route = createFileRoute('/loops/$loopId')({
  ssr: false,
  component: LoopDetailPage,
})

function LoopDetailPage() {
  const { loopId } = Route.useParams()
  return <LoopDetailView id={loopId} />
}

import { createFileRoute } from '@tanstack/react-router'
import { LoopDetailView } from '../components/LoopDetailView'

export const Route = createFileRoute('/loops/$loopId')({
  ssr: false,
  component: LoopDetailPage,
})

function LoopDetailPage() {
  const { loopId } = Route.useParams()
  return <LoopDetailView id={loopId} />
}

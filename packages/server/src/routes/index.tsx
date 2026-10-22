import { createFileRoute, useRouter } from '@tanstack/react-router'
import type { ErrorComponentProps } from '@tanstack/react-router'
import { DashboardView, fetchLiveData } from '../components/DashboardView'
import { LoadErrorCard } from '../components/actionUi'

export const Route = createFileRoute('/')({
  ssr: false,
  loader: () => fetchLiveData(),
  component: Home,
  errorComponent: LoadError,
})

/** First-load failure screen — a calm retry instead of the router's default
 *  error dump. Only the initial loader can land here; the in-page poll is
 *  fetch-then-set and keeps stale data on a transient blip. */
function LoadError({ error }: ErrorComponentProps) {
  const router = useRouter()
  return (
    <main className="mx-auto max-w-[1180px] px-8 pt-12">
      <LoadErrorCard title="Couldn't load the dashboard." detail={String(error)} onRetry={() => void router.invalidate()} />
    </main>
  )
}

function Home() {
  return <DashboardView initial={Route.useLoaderData()} />
}

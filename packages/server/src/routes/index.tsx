import { createFileRoute, useRouter } from '@tanstack/react-router'
import type { ErrorComponentProps } from '@tanstack/react-router'
import { getAuthState } from '../server/loopApi'
import { useSession } from '../lib/auth-client'
import { DashboardView, fetchLiveData, type DashboardData } from '../components/DashboardView'
import { SignIn } from '../components/SignIn'
import { LoadErrorCard } from '../components/actionUi'
import { Loading } from '../components/ui'

/** The dashboard route. Auth mode shows sign-in before loading owner-scoped data;
 * open mode renders the server's shared administrative workspace. */
export const Route = createFileRoute('/')({
  ssr: false,
  loader: async (): Promise<{ auth: { enabled: boolean }; initial: DashboardData }> => {
    const auth = await getAuthState()
    return { auth, initial: await fetchLiveData() }
  },
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
  const loaded = Route.useLoaderData()
  const { data: session, isPending } = useSession()
  if (loaded.auth.enabled && isPending) {
    return <main className="mx-auto max-w-[1180px] px-8 pt-12"><Loading /></main>
  }
  if (loaded.auth.enabled && !session) return <SignIn />
  return <DashboardView initial={loaded.initial} mode={loaded.auth.enabled ? 'auth' : 'open'} />
}

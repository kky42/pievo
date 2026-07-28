import { useEffect, useRef, useState } from 'react'
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import type { ErrorComponentProps } from '@tanstack/react-router'
import { getAuthState } from '../server/loopApi'
import { redeemTeamInvite } from '../server/teamFns'
import { authClient, useSession } from '../lib/auth-client'
import { SignIn } from '../components/SignIn'
import { LoadErrorCard } from '../components/actionUi'
import { setActiveTeamCookie } from '../lib/teamCookie'
import { btnPrimary } from '../components/ui'
import { PievoLogo } from '../components/PievoLogo'

/** Redeem a team invite after normal gated sign-in. Invites grant membership but
 * never bypass the login allowlist; open mode has no invite identity to redeem. */
export const Route = createFileRoute('/invite/$token')({
  ssr: false,
  loader: async ({ params }): Promise<{ auth: { enabled: boolean }; token: string; signedIn: boolean }> => {
    const auth = await getAuthState()
    let signedIn = false
    if (auth.enabled) {
      const { data: session } = await authClient.getSession()
      signedIn = !!session
    }
    return { auth, token: params.token, signedIn }
  },
  component: RedeemInvite,
  errorComponent: LoadError,
})

function LoadError({ error }: ErrorComponentProps) {
  const router = useRouter()
  return (
    <main className="mx-auto max-w-[1180px] px-8 pt-12">
      <LoadErrorCard title="Couldn't open this invite." detail={String(error)} onRetry={() => void router.invalidate()} />
    </main>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto mt-32 max-w-sm text-center">
      <PievoLogo size={52} />
      <h1 className="mt-4 text-2xl font-semibold tracking-tight text-display">Team invite</h1>
      {children}
    </div>
  )
}

function RedeemInvite() {
  const loaded = Route.useLoaderData()
  const { data: session, isPending } = useSession()
  const navigate = useNavigate()
  const [state, setState] = useState<'idle' | 'redeeming' | 'error'>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const ran = useRef(false)

  const gateOn = loaded.auth.enabled
  const signedIn = gateOn ? !!session : false

  useEffect(() => {
    // Redeem exactly once, only when signed in under the gate. Single-use: burning
    // the link is the intended effect, so the ran-once ref prevents a double fire.
    if (!gateOn || isPending || !signedIn || ran.current) return
    ran.current = true
    setState('redeeming')
    void (async () => {
      const r = await redeemTeamInvite({ data: loaded.token })
      if (r.ok) {
        setActiveTeamCookie(r.teamId)
        void navigate({ to: '/t/$teamId', params: { teamId: r.teamId } })
        return
      }
      setMessage(r.error)
      setState('error')
    })()
  }, [gateOn, isPending, signedIn, loaded.token, navigate])

  if (!gateOn) {
    return (
      <Shell>
        <p className="mt-2 text-sm text-secondary">
          This Pievo server runs in open mode (a single shared workspace), so team invites don't apply here.
        </p>
        <button className={`${btnPrimary} mt-6`} onClick={() => void navigate({ to: '/' })}>
          Go to the dashboard
        </button>
      </Shell>
    )
  }

  if (!isPending && !signedIn) {
    return <SignIn callbackURL={`/invite/${loaded.token}`} />
  }

  if (state === 'error') {
    return (
      <Shell>
        <p className="mt-3 text-sm text-accent">{message}</p>
        <button className={`${btnPrimary} mt-6`} onClick={() => void navigate({ to: '/' })}>
          Go to the dashboard
        </button>
      </Shell>
    )
  }

  return (
    <Shell>
      <p className="mt-2 text-sm text-secondary">Joining the team…</p>
    </Shell>
  )
}

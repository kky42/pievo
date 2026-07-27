import { signIn } from '../lib/auth-client'
import { PievoLogo } from './PievoLogo'
import { GITHUB_URL, GitHubIcon } from './SocialLinks'
import { btnPrimary } from './ui'

/**
 * Sign-in CTA — shown by the auth gate when a GitHub OAuth app is configured and
 * the visitor has no session. `callbackURL` returns the user to where they were
 * (the dashboard by default, or the deep-linked loop/run page) after the OAuth
 * round-trip, so a logged-out deep link lands back on the page it was for.
 *
 * This stays intentionally focused on authentication; signed-out product prose
 * belongs to the surrounding route.
 */
export function SignIn({ callbackURL = '/' }: { callbackURL?: string }) {
  return (
    <main className="mx-auto max-w-[1180px] px-8 pb-24">
      <div className="mx-auto mt-32 max-w-sm rounded-card p-6 text-center">
        <PievoLogo size={52} />
        <h1 className="mt-4 text-2xl font-semibold tracking-tight text-display">Pievo</h1>
        <p className="mt-2 text-sm text-secondary">Sign in to manage your scheduled agent loops.</p>
        <button
          className={`${btnPrimary} mt-6`}
          onClick={() => void signIn.social({ provider: 'github', callbackURL })}
        >
          Continue with GitHub
        </button>
        <div className="mt-5 flex items-center justify-center text-caption text-secondary">
          <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 transition-colors hover:text-display">
            <GitHubIcon className="size-4" /> Open source
          </a>
        </div>
      </div>
    </main>
  )
}

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Regression guard for the dashboard's poll resilience.
 *
 * The 3s/10s poll used to re-run the route loader via `router.invalidate()`;
 * the loader's Promise.all THROWS on any rejection, and with no errorComponent
 * a transient blip mid-poll swapped the dashboard for the router's default
 * error screen AND killed the polling interval (never self-heals). The poll
 * must be fetch-then-set with a catch (stale data survives a blip), and the
 * route must carry a retryable errorComponent for the first-load failure case.
 */
// The route file keeps only the loader + errorComponent; the dashboard BODY (poll,
// switcher, template fan) moved to the shared DashboardView (rendered by both `/`
// in open mode and `/t/$teamId`), so the body guards read from there.
const src = readFileSync(fileURLToPath(new URL('./index.tsx', import.meta.url)), 'utf8')
const teamRoute = readFileSync(fileURLToPath(new URL('./t.$teamId.tsx', import.meta.url)), 'utf8')
const view = readFileSync(
  fileURLToPath(new URL('../components/DashboardView.tsx', import.meta.url)),
  'utf8',
)
const switcher = readFileSync(
  fileURLToPath(new URL('../components/TeamSwitcher.tsx', import.meta.url)),
  'utf8',
)

describe('dashboard poll resilience', () => {
  it('registers a retryable errorComponent for first-load failures on both routes', () => {
    for (const s of [src, teamRoute]) {
      expect(s).toMatch(/errorComponent:\s*LoadError/)
      expect(s).toMatch(/function LoadError\b/)
      // The retry affordance lives in the shared LoadErrorCard.
      expect(s).toContain('LoadErrorCard')
      expect(s).toContain('onRetry=')
    }
  })

  it('polls fetch-then-set with a catch — never router.invalidate on a tick', () => {
    const refetch = /const refetch = useCallback\(async \(\) => \{[\s\S]*?\}, \[teamId\]\)/.exec(view)?.[0]
    expect(refetch, 'the refetch callback should exist').toBeTruthy()
    expect(refetch).toContain('catch')
    expect(refetch).toContain('setLive')
    // The interval tick calls refetch; the only invalidate left is the
    // errorComponent's explicit Retry (which re-runs the loader on purpose).
    const tick = /setInterval\(\s*\(\) => \{[\s\S]*?\},\s*anyRunning/.exec(view)?.[0]
    expect(tick, 'the poll interval should exist').toBeTruthy()
    expect(tick).toContain('void refetch()')
    expect(tick).not.toContain('invalidate')
  })

  it('team switch NAVIGATES to /t/<id>, never router.invalidate', () => {
    // The dashboard renders loader data until its first successful live fetch;
    // router.invalidate could still replace the whole page on a loader blip. Phase
    // 2: switching NAVIGATES to the team's explicit URL (the loader re-scopes),
    // and the /t/$teamId route resets live state via key={teamId}.
    expect(view).toContain('<TeamSwitcher data={teams} />')
    expect(teamRoute).toContain('key={loaded!.teamId}')
    expect(switcher).toContain("to: '/t/$teamId'")
    expect(switcher).not.toContain('useRouter')
    expect(switcher).not.toContain('invalidate()')
  })
})

describe('minimal dashboard creation entry', () => {
  it('has one blank-loop entry and no strategy-coupled template market', () => {
    expect(view).toContain('Start a new loop')
    expect(view).not.toContain('TemplateFan')
    expect(view).not.toContain('templates.map')
  })
})

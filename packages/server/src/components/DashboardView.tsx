import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Tooltip } from '@base-ui/react/tooltip'
import { listLoops, listMyTeams } from '../server/loopApi'
import { listMachines } from '../server/machineFns'
import type { LoopSummary, MachineSummary, RunSummary, TeamsView } from '../types'
import { LoopCard } from './LoopCard'
import { TeamSwitcher } from './TeamSwitcher'
import { MachinesModal } from './MachinesModal'
import { TeamsModal } from './TeamsModal'
import { ComposeModal } from './ComposeModal'
import { PievoLogo } from './PievoLogo'
import { GITHUB_URL, GitHubIcon } from './SocialLinks'

export interface DashboardData {
  loops: LoopSummary[]
  machines: MachineSummary[]
  teams: TeamsView | undefined
}

/** Loops, machines, and teams change between polls.
 *
 *  `teamId` (the `/t/<id>` route's team, in id form or undefined in open mode)
 *  scopes every list fn EXPLICITLY - so a tab on /t/A and one on /t/B show
 *  different teams simultaneously, independent of the shared last-used cookie. */
export async function fetchLiveData(teamId?: string) {
  const [loops, machines, teams] = await Promise.all([
    listLoops({ data: teamId }),
    listMachines({ data: teamId }),
    listMyTeams({ data: teamId }),
  ])
  return { loops, machines, teams }
}

/**
 * The dashboard body, shared by the `/` (open mode) and `/t/<teamId>` routes. It
 * renders from its own fetch-then-set poll state, seeded once from the route
 * loader's data, and scopes every fetch to `teamId` so the view is pinned to the
 * URL's team (multi-tab safe). The route mounts it with `key={teamId}` so a
 * team switch (a `/t/<id>` navigation) re-seeds state from the new loader data.
 */
export function DashboardView({ teamId, initial }: { teamId?: string; initial: DashboardData }) {
  // Render loader data until the first successful in-page refresh. This matters
  // when TanStack Router re-enters with cached data and then supplies its fresh
  // loader result: copying `initial` into a one-time state seed would ignore that
  // result and leave deleted loops visible until the next poll. Once fetched,
  // live data stays authoritative so an older loader result cannot roll it back.
  const [live, setLive] = useState<{
    loops: LoopSummary[]
    machines: MachineSummary[]
    teams: TeamsView | undefined
  } | null>(null)
  const { loops, machines, teams } = live ?? initial
  const online = machines.filter((m) => m.online).length
  const navigate = useNavigate()
  const [composeOpen, setComposeOpen] = useState(false)
  const [machinesOpen, setMachinesOpen] = useState(false)
  const [teamsOpen, setTeamsOpen] = useState(false)

  // Silent background refresh — fetch-then-set (like the detail pages), NOT
  // router.invalidate: invalidate re-runs the loader, whose Promise.all THROWS
  // on any rejection, swapping the whole dashboard for the error screen and
  // killing this interval (it never self-heals). A transient blip here just
  // keeps the stale data on screen; the next tick retries.
  const refetch = useCallback(async () => {
    try {
      setLive(await fetchLiveData(teamId))
    } catch {
      /* keep what we have; the next tick retries */
    }
  }, [teamId])

  // Poll, but never while a modal is open (avoid disrupting a compose in
  // progress). A ref keeps the interval reading current state. Speed up to 3s
  // while any loop is executing so its run block + Running badge surface (and
  // settle into a finished block) without a manual refresh.
  const openRef = useRef(false)
  openRef.current = composeOpen || machinesOpen || teamsOpen
  const anyRunning = loops.some((j) => j.running)
  useEffect(() => {
    const t = setInterval(
      () => {
        if (!openRef.current) void refetch()
      },
      anyRunning ? 3_000 : 10_000,
    )
    return () => clearInterval(t)
  }, [refetch, anyRunning])

  const activeCount = loops.filter((loop) => loop.enabled && !loop.deleteRequestedAt).length
  const pausedCount = loops.filter((loop) => !loop.enabled && !loop.deleteRequestedAt).length
  const deletingCount = loops.filter((loop) => Boolean(loop.deleteRequestedAt)).length
  const lifecycleCounts = [
    `${activeCount} active`,
    `${pausedCount} paused`,
    ...(deletingCount ? [`${deletingCount} deleting`] : []),
  ].join(' · ')

  const cardProps = () => ({
    onOpen: (id: string) => void navigate({ to: '/loops/$loopId', params: { loopId: id } }),
    onPickRun: (loopId: string, run: RunSummary) =>
      void navigate({ to: '/loops/$loopId/runs/$runId', params: { loopId: loopId, runId: run.id } }),
  })

  return (
    <Tooltip.Provider delay={120}>
      <header className="glass glass-bar sticky top-0 z-50">
        <div className="mx-auto flex max-w-[1180px] items-center gap-3 px-8 py-2.5">
          <PievoLogo size={30} />
          <span className="text-[18px] font-semibold tracking-[-0.015em] text-display">Pievo</span>
          <TeamSwitcher data={teams} />
          <div className="flex-1" />
          <a href={GITHUB_URL} target="_blank" rel="noreferrer" aria-label="GitHub repository" title="GitHub" className={headerIconBtn}>
            <GitHubIcon className="size-[17px]" />
          </a>
          {/* Team management is a gated feature (real identities) — the button
              shows only when the user actually has teams (gate on). */}
          {teams && teams.teams.length > 0 && (
            <button onClick={() => setTeamsOpen(true)} className={headerBtn}>
              Teams
            </button>
          )}
          <button onClick={() => setMachinesOpen(true)} className={`${headerBtn} gap-1.5`}>
            <span className={`inline-block size-1.5 rounded-full ${online ? 'bg-rubik-green' : 'bg-disabled'}`} />
            {online} {online === 1 ? 'machine' : 'machines'} online
          </button>
          <button
            onClick={() => setComposeOpen(true)}
            className="inline-flex shrink-0 cursor-pointer items-center rounded-full bg-display px-3.5 py-1.5 text-meta font-medium text-paper transition-opacity hover:opacity-85"
          >
            New Loop
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-[1180px] px-8 pb-24">
        <section className="pb-2 pt-14 text-center">
          <h1 className="font-pixel text-[clamp(28px,4.5vw,38px)] leading-[1.15] text-display">What should happen while you sleep?</h1>
          <div className="mt-7"><button onClick={() => setComposeOpen(true)} className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-display px-6 py-2.5 text-body font-medium text-paper transition-opacity hover:opacity-85">Start a new loop <span aria-hidden>→</span></button></div>
        </section>

        <div className="mb-5 mt-12 flex items-baseline gap-2.5">
          <h2 className="text-body font-semibold text-display">Loops</h2>
          <span className="text-label text-secondary">
            {loops.length ? lifecycleCounts : ''}
          </span>
        </div>

        {loops.length ? (
          loops.map((j) => <LoopCard loop={j} {...cardProps()} key={j.id} />)
        ) : (
          <div className="py-16 text-center">
            <div className="text-[15px] text-secondary">
              No loops yet
            </div>
            {!loops.length && (
              <div className="mt-1.5 text-body text-disabled">
                Create a scheduled prompt for a connected machine.
              </div>
            )}
          </div>
        )}
      </main>

      <ComposeModal
        open={composeOpen}
        teamId={teamId}
        onClose={() => setComposeOpen(false)}
      />

      <MachinesModal open={machinesOpen} onClose={() => setMachinesOpen(false)} teamId={teamId} />

      <TeamsModal open={teamsOpen} onClose={() => setTeamsOpen(false)} activeTeamId={teamId} />
    </Tooltip.Provider>
  )
}

const headerBtn =
  'inline-flex shrink-0 cursor-pointer items-center rounded-full px-3 py-1.5 text-meta font-medium text-secondary transition-colors hover:bg-raised hover:text-display'

const headerIconBtn =
  'inline-flex shrink-0 cursor-pointer items-center rounded-full p-1.5 text-secondary transition-colors hover:bg-raised hover:text-display'

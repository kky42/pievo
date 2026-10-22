import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Tooltip } from '@base-ui/react/tooltip'
import { listLoops } from '../server/loopApi'
import { listMachines } from '../server/machineFns'
import type { LoopSummary, MachineSummary, RunSummary } from '../types'
import { LoopCard } from './LoopCard'
import { LoopFilterBar } from './LoopFilterBar'
import { MachinesModal } from './MachinesModal'
import { ComposeModal } from './ComposeModal'
import { PievoLogo } from './PievoLogo'
import { GITHUB_URL, GitHubIcon } from './SocialLinks'
import { filterLoops, loopFilterKey, loopFilterOptions, type LoopFilter } from '../lib/loopFilters'

export interface DashboardData {
  loops: LoopSummary[]
  machines: MachineSummary[]
}

export async function fetchLiveData(): Promise<DashboardData> {
  const [loops, machines] = await Promise.all([listLoops(), listMachines()])
  return { loops, machines }
}

export function DashboardView({ initial }: { initial: DashboardData }) {
  // Render loader data until the first successful in-page refresh. This matters
  // when TanStack Router re-enters with cached data and then supplies its fresh
  // loader result: copying `initial` into a one-time state seed would ignore that
  // result and leave deleted loops visible until the next poll. Once fetched,
  // live data stays authoritative so an older loader result cannot roll it back.
  const [live, setLive] = useState<DashboardData | null>(null)
  const { loops, machines } = live ?? initial
  const online = machines.filter((m) => m.online).length
  const navigate = useNavigate()
  const [composeOpen, setComposeOpen] = useState(false)
  const [machinesOpen, setMachinesOpen] = useState(false)
  const [filter, setFilter] = useState<LoopFilter>({ kind: 'all' })

  // Silent background refresh — fetch-then-set (like the detail pages), NOT
  // router.invalidate: invalidate re-runs the loader, whose Promise.all THROWS
  // on any rejection, swapping the whole dashboard for the error screen and
  // killing this interval (it never self-heals). A transient blip here just
  // keeps the stale data on screen; the next tick retries.
  const refetch = useCallback(async () => {
    try {
      setLive(await fetchLiveData())
    } catch {
      /* keep what we have; the next tick retries */
    }
  }, [])

  // Poll, but never while a modal is open (avoid disrupting a compose in
  // progress). A ref keeps the interval reading current state. Speed up to 3s
  // while any loop is executing so its run block + Running badge surface (and
  // settle into a finished block) without a manual refresh.
  const openRef = useRef(false)
  openRef.current = composeOpen || machinesOpen
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

  const filterOptions = useMemo(() => loopFilterOptions(loops), [loops])
  const selectedFilterKey = loopFilterKey(filter)
  const filteredLoops = useMemo(() => filterLoops(loops, filter), [loops, filter])
  useEffect(() => {
    if (filter.kind === 'tag' && !filterOptions.some((option) => option.key === selectedFilterKey)) {
      setFilter({ kind: 'all' })
    }
  }, [filter, filterOptions, selectedFilterKey])

  const cardProps = () => ({
    onOpen: (id: string) => void navigate({ to: '/loops/$loopId', params: { loopId: id } }),
    onPickRun: (loopId: string, run: RunSummary) =>
      void navigate({ to: '/loops/$loopId/runs/$runId', params: { loopId: loopId, runId: run.id } }),
  })

  return (
    <Tooltip.Provider delay={120}>
      <header className="glass glass-bar sticky top-0 z-50">
        <div className="mx-auto flex max-w-[1180px] items-center gap-2 px-4 py-2.5 sm:gap-3 sm:px-8">
          <span className="shrink-0"><PievoLogo size={30} /></span>
          <span className="shrink-0 text-[18px] font-semibold tracking-[-0.015em] text-display">Pievo</span>
          <div className="flex-1" />
          <a href={GITHUB_URL} target="_blank" rel="noreferrer" aria-label="GitHub repository" title="GitHub" className={`${headerIconBtn} hidden sm:inline-flex`}>
            <GitHubIcon className="size-[17px]" />
          </a>
          <button onClick={() => setMachinesOpen(true)} aria-label={`${online} ${online === 1 ? 'machine' : 'machines'} online`} className={`${headerBtn} gap-1.5 px-2 sm:px-3`}>
            <span className={`inline-block size-1.5 rounded-full ${online ? 'bg-rubik-green' : 'bg-disabled'}`} />
            <span className="sm:hidden">{online}</span>
            <span className="hidden sm:inline">{online} {online === 1 ? 'machine' : 'machines'} online</span>
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

        <div className="mb-5 mt-12">
          <LoopFilterBar options={filterOptions} selectedKey={selectedFilterKey} onSelect={setFilter} />
          <div className="sr-only" aria-live="polite">Showing {filteredLoops.length} loops</div>
        </div>

        {filteredLoops.length ? (
          filteredLoops.map((j) => <LoopCard loop={j} {...cardProps()} key={j.id} />)
        ) : loops.length ? (
          <div className="py-16 text-center">
            <div className="text-[15px] text-secondary">No loops match this filter</div>
            <button type="button" onClick={() => setFilter({ kind: 'all' })} className="mt-2 text-body font-medium text-interactive hover:underline">
              Show all loops
            </button>
          </div>
        ) : (
          <div className="py-16 text-center">
            <div className="text-[15px] text-secondary">No loops yet</div>
            <div className="mt-1.5 text-body text-disabled">
              Create a scheduled prompt for a connected machine.
            </div>
          </div>
        )}
      </main>

      <ComposeModal open={composeOpen} onClose={() => setComposeOpen(false)} />

      <MachinesModal open={machinesOpen} onClose={() => setMachinesOpen(false)} />
    </Tooltip.Provider>
  )
}

const headerBtn =
  'inline-flex shrink-0 cursor-pointer items-center rounded-full px-3 py-1.5 text-meta font-medium text-secondary transition-colors hover:bg-raised hover:text-display'

const headerIconBtn =
  'shrink-0 cursor-pointer items-center rounded-full p-1.5 text-secondary transition-colors hover:bg-raised hover:text-display'

import type { CSSProperties } from 'react'
import type { LoopSchedule, LoopSummary, RunSummary } from '../types'

export const fmt = (t: string | null | undefined): string =>
  t ? new Date(t).toLocaleString() : '—'

export const rel = (t: string | null | undefined): string => {
  if (!t) return ''
  const s = Math.round((Date.now() - Date.parse(t)) / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * Humanize common crontab patterns ("m h dom mon dow") into a readable phrase —
 * "every 3h", "every 15m", "hourly :07", "daily 07:00", "Mon 09:00". Anything
 * outside these common shapes is labeled as a custom schedule; the literal cron
 * remains available on hover and in Configuration.
 */
function cronText(cron: string): string {
  const p = (cron || '').trim().split(/\s+/)
  if (p.length !== 5) return 'custom schedule'
  const [mi, ho, dom, mon, dow] = p as [string, string, string, string, string]
  const dateWild = dom === '*' && mon === '*'
  const everyH = ho.match(/^\*\/(\d+)$/)
  if (everyH && mi === '0' && dateWild && dow === '*') return `every ${everyH[1]}h`
  const everyM = mi.match(/^\*\/(\d+)$/)
  if (everyM && ho === '*' && dateWild && dow === '*') return `every ${everyM[1]}m`
  if (ho === '*' && /^\d+$/.test(mi) && dateWild && dow === '*')
    return `hourly :${mi.padStart(2, '0')}`
  if (/^\d+$/.test(mi) && /^\d+$/.test(ho) && dateWild) {
    const hhmm = `${ho.padStart(2, '0')}:${mi.padStart(2, '0')}`
    if (dow === '*') return `daily ${hhmm}`
    if (/^[0-6]$/.test(dow)) return `${DOW[Number(dow)]} ${hhmm}`
  }
  return 'custom schedule'
}

export function scheduleText(schedule: LoopSchedule): string {
  return schedule.mode === 'cron'
    ? `${cronText(schedule.cron)} · ${schedule.timezone} · overlap ${schedule.overlap}`
    : `continuous · ${schedule.delayMinutes}m after completion`
}

export const until = (t: string | null | undefined): string => {
  if (!t) return ''
  const s = Math.round((Date.parse(t) - Date.now()) / 1000)
  if (s <= 0) return 'due'
  const m = Math.round(s / 60)
  if (m < 60) return `in ${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `in ${h}h`
  return `in ${Math.round(h / 24)}d`
}

export const tsShort = (t: string | null | undefined): string => {
  if (!t) return '—'
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export const fnum = (n: number): string => {
  const abs = Math.abs(n)
  const [divisor, suffix] = abs >= 1_000_000_000
    ? [1_000_000_000, 'b']
    : abs >= 1_000_000
      ? [1_000_000, 'm']
      : abs >= 1_000
        ? [1_000, 'k']
        : [1, '']
  return `${Math.round((n / divisor) * 10) / 10}${suffix}`
}

export const dur = (ms: number | null | undefined): string => (ms ? `${Math.round(ms / 1000)}s` : '')

export function humanBytes(n: number): string {
  const abs = Math.abs(n)
  if (abs < 1024) return `${abs} B`
  if (abs < 1024 * 1024) return `${(abs / 1024).toFixed(1)} KB`
  return `${(abs / (1024 * 1024)).toFixed(1)} MB`
}

interface StatusMeta {
  c: string
  label: string
}

const ST = {
  ok: { c: 'var(--color-run-ok)', label: 'OK' },
  block: { c: 'var(--color-run-block)', label: 'Block' },
  error: { c: 'var(--color-run-error)', label: 'Error' },
  canceled: { c: 'var(--color-run-canceled)', label: 'Canceled' },
  queued: { c: 'var(--color-run-queued)', label: 'Queued' },
  reconciling: { c: 'var(--color-run-reconciling)', label: 'Reconciling…' },
  active: { c: 'var(--color-run-active)', label: 'Running…' },
} satisfies Record<string, StatusMeta>

/** The run's ink, for text and borders. Fills use `runSwatch`. */
export function dotColor(r: RunSummary): string {
  if (r.reconciliation) return ST.reconciling.c
  if (r.phase === 'running') return ST.active.c
  if (r.phase === 'error') return ST.error.c
  if (r.phase === 'pending') return ST.queued.c
  if (r.phase === 'canceled') return ST.canceled.c
  return r.status === 'block' ? ST.block.c : ST.ok.c
}

export const runPulseAnim = { animation: 'runPulse 1.1s ease-in-out infinite' } as const

/** Fill, outline, and motion for a run block or dot. */
export function runSwatch(r: RunSummary): CSSProperties {
  const ink = dotColor(r)
  if (r.reconciliation) {
    return { outline: `1.5px dashed ${ink}`, outlineOffset: '-1.5px', animation: 'runWait 2.4s ease-in-out infinite' }
  }
  if (r.phase === 'running') return { background: ink, ...runPulseAnim }
  if (r.phase === 'pending') return { boxShadow: `inset 0 0 0 1.5px ${ink}` }
  if (r.phase === 'canceled') return { background: ink, opacity: 0.5 }
  // 3px stripes stay readable from the 8px dots up to the 20px timeline block.
  if (r.phase === 'error') return { background: `repeating-linear-gradient(135deg, ${ink} 0 3px, var(--color-run-error-stripe) 3px 6px)` }
  return { background: ink }
}

export function dotLabel(r: RunSummary): string {
  if (r.reconciliation === 'blocking') return 'Waiting for machine recovery'
  if (r.reconciliation === 'report-only') return 'Awaiting late report'
  if (r.phase === 'pending') return ST.queued.label
  if (r.phase === 'running') return r.cancelRequested ? 'Stopping…' : ST.active.label
  if (r.phase === 'error') return r.cancelRequested ? 'Failed while stopping' : ST.error.label
  if (r.phase === 'canceled') return ST.canceled.label
  if (r.status === 'block') return ST.block.label
  return r.cancelRequested ? 'Succeeded while stopping' : ST.ok.label
}

/** The newest finished run, whose attention reason the loop card surfaces until a
 *  later run finishes without one. */
export const lastFinishedRun = (runs: RunSummary[]): RunSummary | undefined =>
  runs.findLast((r) => r.phase === 'done' || r.phase === 'error')

export const lastRunOf = (j: LoopSummary): RunSummary | null => {
  const a = j.runs ?? []
  return a.length ? a[a.length - 1]! : null
}

/**
 * Display helpers + the run-status palette, ported 1:1 from the original
 * self-contained UI page (src/scheduler/ui.ts). The six status colors encode
 * meaning and are reused by the timeline, chart, and A/B panel.
 */
import type { JobSummary, RunSummary } from '../types'

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
 * outside these common shapes falls back to the raw expression (shown verbatim,
 * with the literal cron always available on hover at the call site).
 */
export function cronText(cron: string): string {
  const p = (cron || '').trim().split(/\s+/)
  if (p.length !== 5) return cron
  const [mi, ho, dom, mon, dow] = p as [string, string, string, string, string]
  const dateWild = dom === '*' && mon === '*'
  const everyH = ho.match(/^\*\/(\d+)$/)
  if (everyH && dateWild && dow === '*') return `every ${everyH[1]}h`
  const everyM = mi.match(/^\*\/(\d+)$/)
  if (everyM && ho === '*' && dateWild && dow === '*') return `every ${everyM[1]}m`
  if (ho === '*' && /^\d+$/.test(mi) && dateWild && dow === '*')
    return `hourly :${mi.padStart(2, '0')}`
  if (/^\d+$/.test(mi) && /^\d+$/.test(ho) && dateWild) {
    const hhmm = `${ho.padStart(2, '0')}:${mi.padStart(2, '0')}`
    if (dow === '*') return `daily ${hhmm}`
    if (/^[0-6]$/.test(dow)) return `${DOW[Number(dow)]} ${hhmm}`
  }
  return cron
}

/** Compact time-until-future: "due" / "in 50m" / "in 2h" / "in 3d". */
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

export const md = (t: string | number): string => {
  const d = new Date(t)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** Compact run-log timestamp: "MM/DD HH:mm" (24h, zero-padded, local). */
export const tsShort = (t: string | null | undefined): string => {
  if (!t) return '—'
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export const fnum = (n: number): string =>
  Math.abs(n) >= 1000 ? `${Math.round(n / 100) / 10}k` : `${Math.round(n * 100) / 100}`

/** Duration in ms → "Ns" (empty for null/0). */
export const dur = (ms: number | null | undefined): string => (ms ? `${Math.round(ms / 1000)}s` : '')

/** Magnitude-formatted byte count — "240 B", "1.8 KB", "3.4 MB" (1024 thresholds). */
export function humanBytes(n: number): string {
  const abs = Math.abs(n)
  if (abs < 1024) return `${abs} B`
  if (abs < 1024 * 1024) return `${(abs / 1024).toFixed(1)} KB`
  return `${(abs / (1024 * 1024)).toFixed(1)} MB`
}

export interface StatusMeta {
  c: string
  label: string
}

/**
 * status key → color + label. Colors are CSS theme vars (Nothing semantic
 * palette, light/dark aware) — mostly monochrome, with green/amber/red reserved
 * for meaning. Mirrored by the --color-run-* tokens used in Tailwind classes.
 */
export const ST = {
  kept: { c: 'var(--color-run-kept)', label: 'Kept' },
  'no-change': { c: 'var(--color-run-no-change)', label: 'No change' },
  blocked: { c: 'var(--color-run-blocked)', label: 'Blocked' },
  error: { c: 'var(--color-run-error)', label: 'Error' },
  warning: { c: 'var(--color-run-warning)', label: 'Missing status' },
  canceled: { c: 'var(--color-run-canceled)', label: 'Canceled' },
  queued: { c: 'var(--color-run-queued)', label: 'Queued' },
  'active-exec': { c: 'var(--color-run-active-exec)', label: 'Running…' },
  'active-edit': { c: 'var(--color-run-active-edit)', label: 'Editing…' },
  'active-evolve': { c: 'var(--color-run-active-evolve)', label: 'Evolving…' },
} satisfies Record<string, StatusMeta>

const statusMeta = (k: string | null | undefined): StatusMeta | undefined =>
  k === 'kept' || k === 'no-change' || k === 'blocked' ? ST[k] : undefined

const roleWord = (r: RunSummary): 'exec' | 'edit' | 'evolve' =>
  r.role === 'edit' ? 'edit' : r.role === 'evolve' ? 'evolve' : 'exec'

const keptLabel = (r: RunSummary): string =>
  roleWord(r) === 'edit' ? 'Edited' : roleWord(r) === 'evolve' ? 'Improved' : 'Kept'

export function dotColor(r: RunSummary): string {
  if (r.running) return ST[`active-${roleWord(r)}`].c
  if (r.status === 'blocked') return ST.blocked.c
  if (r.queued) return ST.queued.c
  if (r.phase === 'error') return ST.error.c
  if (r.canceled || r.phase === 'canceled') return ST.canceled.c
  if (r.phase === 'done' && !statusMeta(r.status)) return ST.warning.c
  return (statusMeta(r.status) ?? ST['no-change']).c
}

export function dotOpacity(r: RunSummary): number {
  if (r.running || r.status === 'blocked' || r.phase === 'error') return 1
  if (r.queued) return 0.7
  if (r.canceled || r.phase === 'canceled') return 0.5
  if (r.phase === 'done' && !statusMeta(r.status)) return 0.9
  if (r.status === 'no-change') return 0.55
  return 1
}

export function dotLabel(r: RunSummary): string {
  if (r.queued) return ST.queued.label
  if (r.running) {
    if (r.cancelRequested) return 'Stopping…'
    return ST[`active-${roleWord(r)}`].label
  }
  // Blocked is actionability, so it outranks canceled/error visual labels.
  if (r.status === 'blocked') return ST.blocked.label
  if (r.phase === 'error') {
    if (r.cancelRequested) return 'Failed while stopping'
    return ST.error.label
  }
  if (r.canceled || r.phase === 'canceled') {
    if (r.error === 'stopped by user') return 'Canceled'
    return 'Canceled'
  }
  if (r.cancelRequested && r.phase === 'done') return 'Succeeded while stopping'
  if (r.status === 'kept') return keptLabel(r)
  if (r.status === 'no-change') return ST['no-change'].label
  if (r.phase === 'done') return ST.warning.label
  return ST['no-change'].label
}

export const lastRunOf = (j: JobSummary): RunSummary | null => {
  const a = j.runs ?? []
  return a.length ? a[a.length - 1]! : null
}

/**
 * Completed = the loop reached its goal and was stamped terminal (`completedAt`
 * set by `pievo finish`). This is now an explicit loop state, NOT the old
 * disabled+resolved heuristic — a merely paused loop (no completedAt) stays in
 * the active section with a "Paused" badge.
 */
export function isCompleted(j: JobSummary): boolean {
  return j.completedAt != null
}

/**
 * A CLOSED loop is one carrying a goal (setpoint). "Active closed" = closed but
 * not yet completed — the state that surfaces the quiet "Goal" chip + goal line.
 */
export function isClosed(j: JobSummary): boolean {
  return j.goal != null && j.goal !== ''
}

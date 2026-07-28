/** Display helpers and the semantic run-status palette. */
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
export function cronText(cron: string): string {
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

/** Human-readable schedule summary shared by dashboard and detail headers. */
export function scheduleText(schedule: LoopSchedule): string {
  return schedule.mode === 'cron'
    ? `${cronText(schedule.cron)} · ${schedule.timezone} · overlap ${schedule.overlap}`
    : `continuous · ${schedule.delayMinutes}m after completion`
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

/** Compact run-log timestamp: "MM/DD HH:mm" (24h, zero-padded, local). */
export const tsShort = (t: string | null | undefined): string => {
  if (!t) return '—'
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** Compact decimal magnitude — "1.2k", "3.4m", "5.6b". */
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
  keep: { c: 'var(--color-run-keep)', label: 'Keep' },
  'no-change': { c: 'var(--color-run-no-change)', label: 'No change' },
  block: { c: 'var(--color-run-block)', label: 'Block' },
  error: { c: 'var(--color-run-error)', label: 'Error' },
  warning: { c: 'var(--color-run-warning)', label: 'Missing status' },
  canceled: { c: 'var(--color-run-canceled)', label: 'Canceled' },
  queued: { c: 'var(--color-run-queued)', label: 'Queued' },
  reconciling: { c: 'var(--color-run-warning)', label: 'Reconciling…' },
  active: { c: 'var(--color-run-active)', label: 'Running…' },
} satisfies Record<string, StatusMeta>

const statusMeta = (k: string | null | undefined): StatusMeta | undefined =>
  k === 'keep' || k === 'no-change' || k === 'block' ? ST[k] : undefined

export function dotColor(r: RunSummary): string {
  if (r.reconciliation) return ST.reconciling.c
  if (r.phase === 'running') return ST.active.c
  if (r.phase === 'error') return ST.error.c
  if (r.status === 'block') return ST.block.c
  if (r.phase === 'pending') return ST.queued.c
  if (r.phase === 'canceled') return ST.canceled.c
  if (r.phase === 'done' && !statusMeta(r.status)) return ST.warning.c
  return (statusMeta(r.status) ?? ST['no-change']).c
}

export function dotOpacity(r: RunSummary): number {
  if (r.reconciliation || r.phase === 'running' || r.status === 'block' || r.phase === 'error') return 1
  if (r.phase === 'pending') return 0.7
  if (r.phase === 'canceled') return 0.5
  if (r.phase === 'done' && !statusMeta(r.status)) return 0.9
  if (r.status === 'no-change') return 0.55
  return 1
}

export function dotLabel(r: RunSummary): string {
  if (r.reconciliation === 'blocking') return 'Waiting for machine recovery'
  if (r.reconciliation === 'report-only') return 'Awaiting late report'
  if (r.phase === 'pending') return ST.queued.label
  if (r.phase === 'running') {
    if (r.cancelRequested) return 'Stopping…'
    return ST.active.label
  }
  if (r.phase === 'error') {
    if (r.cancelRequested) return 'Failed while stopping'
    return ST.error.label
  }
  if (r.status === 'block') return ST.block.label
  if (r.phase === 'canceled') {
    if (r.error === 'stopped by user') return 'Canceled'
    return 'Canceled'
  }
  if (r.cancelRequested && r.phase === 'done') return 'Succeeded while stopping'
  if (r.status === 'keep') return ST.keep.label
  if (r.status === 'no-change') return ST['no-change'].label
  if (r.phase === 'done') return ST.warning.label
  return ST['no-change'].label
}

export const lastRunOf = (j: LoopSummary): RunSummary | null => {
  const a = j.runs ?? []
  return a.length ? a[a.length - 1]! : null
}

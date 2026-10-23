import type { ReactNode } from 'react'
import { useSyncExternalStore } from 'react'
import type { RunSummary } from '../types'
import { dotColor, dotLabel, runPulseAnim, runSwatch } from '../lib/format'

/*
 * Hydration gate. `fmt`/`rel`/`until` (lib/format) read the wall clock and the
 * runtime locale — toLocaleString() renders in the server's timezone (UTC) and
 * Date.now() differs between the SSR instant and the hydration instant, so any
 * time string baked into the server HTML mismatches the client and React warns.
 * Gate those renders behind this: server + first client paint both yield the
 * stable fallback (no mismatch), then the post-mount snapshot flips to true and
 * the real local/relative time renders. useSyncExternalStore needs no effect
 * and never subscribes (the value only flips once, at mount).
 */
const noopSubscribe = () => () => {}
export const useHydrated = (): boolean =>
  useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  )

export const focusRing = 'focus-visible:outline-none focus-visible:shadow-focus'
const btnBase = `inline-flex cursor-pointer items-center gap-1.5 rounded-control px-4 py-2 text-body font-medium transition-colors duration-150 disabled:cursor-default disabled:opacity-40 ${focusRing}`
export const btn = `${btnBase} border border-wire bg-surface text-primary hover:bg-raised`
export const btnPrimary = `${btnBase} border border-display bg-display text-paper hover:opacity-85`
export const btnDanger = `${btnBase} border border-transparent bg-rubik-red text-white hover:opacity-85`
// Compact control - its own padding/size base (NOT btnBase) so it can't lose
// the px/text tug-of-war on CSS source-order. For inline affordances like Copy
// that sit next to dense content rather than anchoring a dialog.
export const btnSm = `inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-full border border-wire bg-surface px-3 py-1 text-label font-medium text-primary transition-colors duration-150 hover:bg-raised disabled:cursor-default disabled:opacity-40 ${focusRing}`
export const btnQuiet =
  'inline-flex cursor-pointer items-center gap-1.5 border-none bg-transparent p-0 text-meta font-medium text-secondary transition-colors hover:text-display'

export const sectionHeadCls = 'text-label font-semibold text-secondary'

export const labelCls = 'mb-1.5 mt-3 block text-label font-medium text-secondary'
export const inputCls = `w-full rounded-control border border-wire bg-surface px-3 py-2.5 text-sm text-primary outline-none transition-shadow focus:border-transparent focus:shadow-focus`
export const selectCls = `${inputCls} lp-select cursor-pointer`

/** The live "running" indicator outside the timeline: the same ink fill and
 *  `runPulse` breath as the in-flight run block. Spread into a `style` prop. */
export const runPulseStyle = {
  background: 'var(--color-run-active)',
  ...runPulseAnim,
} as const

export function ErrorBanner({
  message,
  onDismiss,
  className = 'mb-2',
}: {
  message: string
  onDismiss?: () => void
  className?: string
}) {
  return (
    <div className={`flex items-start gap-2 text-body text-accent ${className}`}>
      <span className="mt-[5px] size-2 shrink-0 rounded-full bg-rubik-red" aria-hidden />
      <span>{message}</span>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="ml-auto shrink-0 cursor-pointer border-none bg-transparent p-0 text-label text-secondary transition-colors hover:text-display"
        >
          Dismiss
        </button>
      )}
    </div>
  )
}

const PILL_TONES = {
  neutral: 'bg-raised text-secondary',
  ink: 'bg-raised text-primary',
  outline: 'border border-hairline text-secondary',
  attention: 'bg-attention-soft text-attention',
  success: 'bg-success-soft text-success',
  accent: 'bg-accent-soft text-accent',
  warn: 'bg-warn-soft text-warn',
} as const

export function Pill({
  tone = 'neutral',
  title,
  className = '',
  children,
}: {
  tone?: keyof typeof PILL_TONES
  title?: string
  className?: string
  children: ReactNode
}) {
  return (
    <span
      title={title}
      className={`inline-flex h-[22px] items-center gap-1.5 rounded-full px-2.5 text-caption font-medium ${PILL_TONES[tone]} ${className}`}
    >
      {children}
    </span>
  )
}

export function Loading({ className = '' }: { className?: string }) {
  return <div className={`text-body text-disabled ${className}`}>Loading…</div>
}

/** Yellow "!" for a run that asked for owner attention. It overlays the status
 *  color instead of replacing it because attention is independent of status; the
 *  dark outline keeps yellow legible on green, red, and grey blocks. */
export function AttentionMark() {
  return (
    <span
      aria-hidden
      className="pointer-events-none select-none text-[14px] font-black leading-none text-run-attention"
      style={{ WebkitTextStroke: '3px rgba(0,0,0,0.55)', paintOrder: 'stroke fill' }}
    >
      !
    </span>
  )
}

export function StatusPill({ run, colorText }: { run: RunSummary; colorText?: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 font-medium"
      style={colorText ? { color: dotColor(run) } : undefined}
    >
      <span className="size-2 rounded-full" style={runSwatch(run)} />
      {dotLabel(run)}
    </span>
  )
}

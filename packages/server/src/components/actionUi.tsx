import { useEffect, useRef, useState } from 'react'
import { btn, btnDanger, btnPrimary } from './ui'

/**
 * Shared building blocks for high-stakes action rows (loop detail, run view, …).
 * The point of this file: a caller toggles ONE piece of state (`confirming`) or
 * calls ONE handler (`arm`) — all the fiddly focus / keyboard / aria / timer
 * bookkeeping lives here, not inlined as a pile of hooks in every screen.
 */

export type Flash = { label: string; tone?: 'ok' | 'gone'; undo?: () => void; hold?: number }

/**
 * First-load failure card — the calm "couldn't load X" + Retry the dashboard,
 * loop page, and run page all show instead of a raw error dump. One shared
 * markup so the three screens can't drift.
 */
export function LoadErrorCard({ title, detail, onRetry }: { title: string; detail?: string | null; onRetry: () => void }) {
  return (
    <div className="rounded-card border border-hairline bg-surface px-6 py-8 shadow-card">
      <div className="text-[14px] text-accent">{title}</div>
      {detail && <div className="mt-1 text-meta text-secondary">{detail}</div>}
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 cursor-pointer border-none bg-transparent p-0 text-label font-medium text-interactive underline underline-offset-2 hover:text-display"
      >
        Retry
      </button>
    </div>
  )
}

/**
 * In-panel guard — the Nothing-styled stand-in for native confirm(). Owns its
 * own a11y so the caller just renders it when armed: focus lands on the CTA,
 * Esc cancels, Enter (CTA focused) confirms. Render with `key={kind}` so it
 * remounts (and re-focuses) per guard.
 */
export function ConfirmBar({
  prompt,
  note,
  cta,
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  prompt: string
  note?: string
  cta: string
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const ctaRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    ctaRef.current?.focus()
  }, [])
  return (
    <div
      role="group"
      aria-label={prompt}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !busy) onCancel()
      }}
      className="flex flex-wrap items-center gap-x-4 gap-y-2.5 rounded-control border border-hairline bg-raised px-4 py-3"
    >
      <div className="min-w-0">
        <div className="text-body font-medium text-display">{prompt}</div>
        {note && <div className="mt-0.5 text-meta text-secondary">{note}</div>}
      </div>
      <div className="ml-auto flex items-center gap-2.5">
        <button ref={ctaRef} className={danger ? btnDanger : btnPrimary} disabled={busy} onClick={onConfirm}>
          {busy ? 'Working…' : cta}
        </button>
        <button className={btn} disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

/**
 * Transient peak-end acknowledgement (✓ done / ✕ gone), announced to AT via
 * aria-live. Self-clearing is the caller's concern (see `useFlash`); this is
 * pure presentation. No outer margin — wrap at the call site for spacing.
 */
export function FlashLine({ label, tone = 'ok', onUndo }: { label: string; tone?: 'ok' | 'gone'; onUndo?: () => void }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="inline-flex items-center gap-2 text-label font-medium text-secondary"
      style={{ animation: 'fadeIn 0.2s ease-out' }}
    >
      <span aria-hidden className={tone === 'gone' ? 'text-accent' : 'text-success'}>
        {tone === 'gone' ? '✕' : '✓'}
      </span>
      {label}
      {onUndo && (
        <button
          type="button"
          onClick={onUndo}
          className="cursor-pointer border-none bg-transparent p-0 text-label font-medium text-interactive underline underline-offset-2 transition-colors hover:text-display"
        >
          Undo
        </button>
      )}
    </div>
  )
}

/**
 * Flash state + its self-clear timer in one unit. `hold` wins; else an Undo
 * flash lingers ~6s (reachable), a bare "done" fades after ~2.2s. Fade, don't
 * slide.
 */
export function useFlash() {
  const [flash, setFlash] = useState<Flash | null>(null)
  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(null), flash.hold ?? (flash.undo ? 6000 : 2200))
    return () => clearTimeout(t)
  }, [flash])
  return [flash, setFlash] as const
}

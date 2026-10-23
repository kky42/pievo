import { useId } from 'react'
import type { RunSummary } from '../types'
import { runTokens } from '../lib/format'

/** Timeline geometry: an 18px block plus a 3px gap. Keep in step with Timeline. */
export const SLOT = 21
const BLOCK = 18
const HEIGHT = 22
/** Inset so a 1.25px stroke at the extremes is not clipped by the SVG edge. */
const PAD = 2.5

type Point = { x: number; y: number }

/**
 * Monotone cubic (Fritsch–Carlson) path through the points: smooth like a
 * spline, but it never overshoots between runs, so a dip or peak is a real run.
 */
function smoothPath(points: Point[]): string {
  const n = points.length
  if (n === 1) return `M${points[0]!.x - 3},${points[0]!.y}H${points[0]!.x + 3}`
  const dx: number[] = []
  const slope: number[] = []
  for (let i = 0; i < n - 1; i++) {
    dx.push(points[i + 1]!.x - points[i]!.x)
    slope.push((points[i + 1]!.y - points[i]!.y) / dx[i]!)
  }
  const tangent = points.map((_, i) => {
    if (i === 0) return slope[0]!
    if (i === n - 1) return slope[n - 2]!
    const a = slope[i - 1]!
    const b = slope[i]!
    return a * b <= 0 ? 0 : (3 * (dx[i - 1]! + dx[i]!)) / ((2 * dx[i]! + dx[i - 1]!) / a + (dx[i]! + 2 * dx[i - 1]!) / b)
  })
  let d = `M${points[0]!.x},${points[0]!.y}`
  for (let i = 0; i < n - 1; i++) {
    const p = points[i]!
    const q = points[i + 1]!
    const h = dx[i]! / 3
    d += `C${p.x + h},${p.y + tangent[i]! * h} ${q.x - h},${q.y - tangent[i + 1]! * h} ${q.x},${q.y}`
  }
  return d
}

/**
 * Relative token use of the visible runs, drawn under their blocks: no axis and
 * no numbers (the run tooltip and run page carry those). Runs that reported no
 * usage (queued, running, canceled) are skipped and the curve bridges them.
 */
export function TokenCurve({ runs, offset }: { runs: RunSummary[]; offset: number }) {
  // useId output contains characters that break inside url(#…).
  const gradient = `tc${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const usage = runs.map(runTokens)
  const max = Math.max(0, ...usage.map((t) => t ?? 0))
  if (max === 0) return null
  const points = usage.flatMap((tokens, i) =>
    tokens == null ? [] : [{ x: (offset + i) * SLOT + BLOCK / 2, y: HEIGHT - PAD - (tokens / max) * (HEIGHT - 2 * PAD) }],
  )
  const width = (offset + runs.length) * SLOT
  const line = smoothPath(points)
  const area = points.length > 1 ? `${line}L${points.at(-1)!.x},${HEIGHT}L${points[0]!.x},${HEIGHT}Z` : null
  return (
    <svg aria-hidden width={width} height={HEIGHT} className="mt-1 block shrink-0 overflow-visible text-secondary">
      <defs>
        <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.16" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      {area && <path d={area} fill={`url(#${gradient})`} />}
      <path d={line} fill="none" stroke="currentColor" strokeOpacity="0.55" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

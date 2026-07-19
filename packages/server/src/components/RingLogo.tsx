/**
 * Shared Pievo mark geometry: eight durable steps form a cycle and the
 * interactive-blue runner marks the next scheduled pass.
 *
 * Variants are props on one geometry (styles in app.css):
 * - `plate`    - dark tile behind the steps (favicon / app-icon contexts);
 *                without it the steps inherit currentColor (inline contexts).
 * - `trail`    - two fading steps behind the runner, so a static rendering
 *                still reads as motion (print / social cards).
 * - `animated` - the runner advances around the cycle; reduced-motion users
 *                see the canonical static first frame.
 */

// Ring positions in sticker-chase order (clockwise from top-left); rc0 is
// the runner, rc7/rc6 sit just behind it and carry the trail.
const RING: Array<[number, number]> = [
  [9, 9],
  [37, 9],
  [65, 9],
  [65, 37],
  [65, 65],
  [37, 65],
  [9, 65],
  [9, 37],
]

export function RingLogo({
  size = 24,
  plate = false,
  trail = false,
  animated = false,
}: {
  size?: number
  plate?: boolean
  trail?: boolean
  animated?: boolean
}) {
  const cellClass = (i: number) => {
    const parts = ['ring-cell', `rc${i}`]
    if (i === 0) parts.push('ring-runner')
    else if (trail && i === 7) parts.push('ring-trail-1')
    else if (trail && i === 6) parts.push('ring-trail-2')
    return parts.join(' ')
  }
  const rootClass = [
    'ring-logo',
    plate && 'ring-logo-plate',
    animated && 'ring-logo-animated',
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 96 96"
      role="img"
      aria-label="Pievo"
      className={rootClass}
    >
      {/* Concentric corners: plate rx = sticker rx (6) + edge gap (9). */}
      {plate && <rect width="96" height="96" rx="15" fill="#0b0b0b" />}
      {RING.map(([x, y], i) => (
        <rect key={i} x={x} y={y} width={22} height={22} rx={6} className={cellClass(i)} />
      ))}
    </svg>
  )
}

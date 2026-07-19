import { RingLogo } from './RingLogo'

/**
 * Pievo's primary product mark: one scheduled pass moving around a durable ring.
 * It reuses the same geometry as the favicon and README asset; animation is a
 * progressive enhancement and parks on the canonical first frame when reduced
 * motion is requested.
 */
export function PievoLogo({ size = 56 }: { size?: number }) {
  return <RingLogo size={size} plate animated />
}

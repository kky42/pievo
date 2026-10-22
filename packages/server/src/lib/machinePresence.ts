/**
 * Three-state machine presence shared by server projections and the UI:
 *   - `online`:  polled within MACHINE_ONLINE_TTL_MS;
 *   - `asleep`:  not online but seen within MACHINE_ASLEEP_TTL_MS. A laptop that
 *                slept or dropped its network usually resumes on its own, so this
 *                is deliberately calm rather than an alarm;
 *   - `offline`: never seen, or last seen beyond the asleep window.
 */

export const MACHINE_ONLINE_TTL_MS = 30_000;

/**
 * How long after its last heartbeat a machine still reads as merely "asleep"
 * rather than "offline". Six hours comfortably covers an overnight-ish sleep or a
 * lunch-break lid-close without alarming the user; past it, the machine has been
 * gone long enough that "offline" is the honest label.
 */
export const MACHINE_ASLEEP_TTL_MS = 6 * 60 * 60 * 1000;

export type MachinePresence = 'online' | 'asleep' | 'offline';

/**
 * Derive a machine's presence from its stored `online` flag + `lastSeen` stamp.
 * `online` requires BOTH the flag and a fresh stamp (the stored flag lags the
 * sweep by up to one interval); everything else keys off how stale `lastSeen` is.
 */
export function machinePresence(
  online: boolean | null | undefined,
  lastSeen: string | null | undefined,
  now: number = Date.now(),
): MachinePresence {
  const seenAt = lastSeen ? Date.parse(lastSeen) : NaN;
  if (!Number.isFinite(seenAt)) return 'offline';
  const age = now - seenAt;
  if (!!online && age < MACHINE_ONLINE_TTL_MS) return 'online';
  if (age < MACHINE_ASLEEP_TTL_MS) return 'asleep';
  return 'offline';
}

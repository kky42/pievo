/** Framework-free machine authorization decisions shared by machine server functions. */
import type { Machine } from '../db/schema.js'
import type { RequestScope } from '../auth.js'

/** Open mode sees every machine; auth mode sees only the signed-in owner's rows. */
export function machineInScope(
  machine: Pick<Machine, 'userId'>,
  scope: Pick<RequestScope, 'enforce' | 'userId'>,
): boolean {
  return !scope.enforce || (!!scope.userId && machine.userId === scope.userId)
}

/** A device token fully impersonates its machine, so auth mode keeps it owner-only. */
export function tokenVisibleTo(
  machine: Pick<Machine, 'userId'>,
  scope: Pick<RequestScope, 'enforce' | 'userId'>,
): boolean {
  return machineInScope(machine, scope)
}

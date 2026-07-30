/**
 * The GitHub login-gate condition, in one leaf module. `auth.ts` derives its
 * load-time `authEnabled` value from this, and server boot calls it before any
 * migration or scheduler work.
 *
 * The gate is ON exactly when a complete GitHub OAuth app is configured. Open
 * mode requires both values to be absent; a partial configuration fails closed.
 */
export function loginGateEnabled(): boolean {
  const hasClientId = !!process.env.GITHUB_CLIENT_ID?.trim();
  const hasClientSecret = !!process.env.GITHUB_CLIENT_SECRET?.trim();
  if (hasClientId !== hasClientSecret) {
    throw new Error(
      "incomplete GitHub auth configuration: set both GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET, or unset both for open mode",
    );
  }
  return hasClientId;
}

/**
 * The GitHub login-gate condition, in ONE place. `auth.ts` derives its load-time
 * `authEnabled` const from this; the machine-enrollment guard (`gateway/index.ts`
 * `poll`) calls it LIVE so the gated-vs-open behavior can be exercised in a test
 * (which sets the env vars per-case) without pulling betterAuth into the machine
 * hot path. Leaf module — no imports, no side effects.
 *
 * The gate is ON exactly when a GitHub OAuth app is configured (both id + secret).
 * OFF ⇒ open/dev mode (single shared workspace, anonymous self-registration).
 */
export function loginGateEnabled(): boolean {
  return !!(process.env.GITHUB_CLIENT_ID?.trim() && process.env.GITHUB_CLIENT_SECRET?.trim());
}

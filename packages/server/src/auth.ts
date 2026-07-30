/**
 * Better Auth with GitHub social login. Supplying GitHub OAuth credentials
 * enables authentication; `PIEVO_ALLOWED_LOGINS` optionally narrows who may
 * sign in. Auth mode isolates data by signed-in user. Without GitHub
 * credentials, the server is one shared open-mode workspace.
 */
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import { db } from "./db/index.js";
import { loginGateEnabled } from "./lib/loginGate.js";

const clientId = process.env.GITHUB_CLIENT_ID?.trim();
const clientSecret = process.env.GITHUB_CLIENT_SECRET?.trim();

/** Keep the web-session gate and machine-enrollment gate on one live condition. */
export const authEnabled = loginGateEnabled();

// A public fallback would let callers forge auth-mode sessions. Open mode has
// no login sessions and retains the fallback for zero-config local operation.
const authSecret = process.env.PIEVO_AUTH_SECRET?.trim();
if (authEnabled && !authSecret) {
  throw new Error(
    "PIEVO_AUTH_SECRET must be set when the GitHub login gate is enabled (GITHUB_CLIENT_ID/SECRET present) — refusing to fall back to the public dev secret.",
  );
}

/**
 * An empty allowlist permits any GitHub-authenticated user. Entries may be full
 * email addresses or domain wildcards (`@example.com` or `*@example.com`).
 */
export function emailAllowed(email: string | null | undefined): boolean {
  const allowlist = (process.env.PIEVO_ALLOWED_LOGINS || "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (!allowlist.length) return true;
  const e = (email || "").toLowerCase();
  const at = e.indexOf("@");
  if (at < 0) return false;
  const domain = e.slice(at);
  return allowlist.some(
    (entry) => entry === e || entry === domain || (entry.startsWith("*@") && entry.slice(1) === domain),
  );
}

function rejectDisallowedEmail(email: string | null | undefined): never {
  const normalized = (email || "").trim().toLowerCase();
  throw new APIError("FORBIDDEN", {
    message: `${normalized || "this account"} is not on the Pievo allowlist`,
  });
}

/** The Better Auth user for the current server request, or null without a session. */
export async function currentUser(): Promise<{ id: string; email: string | null } | null> {
  const { getRequest } = await import("@tanstack/react-start/server");
  const session = await auth.api.getSession({ headers: getRequest().headers });
  const user = session?.user;
  return user ? { id: user.id, email: user.email ?? null } : null;
}

export async function currentUserId(): Promise<string | null> {
  return (await currentUser())?.id ?? null;
}

export interface RequestScope {
  enforce: boolean;
  userId: string | null;
}

/**
 * Auth mode uses the signed-in user as the sole tenant boundary. Open mode is
 * intentionally unscoped and does not perform a session lookup.
 */
export async function requestScope(): Promise<RequestScope> {
  if (!authEnabled) return { enforce: false, userId: null };
  return { enforce: true, userId: await currentUserId() };
}

/**
 * Shared loop authorization used by server functions and raw artifact serving.
 * A denied loop and an absent loop must remain externally indistinguishable.
 */
export function canAccessLoop(
  loopUserId: string | null | undefined,
  scope: Pick<RequestScope, "enforce" | "userId">,
): boolean {
  return !scope.enforce || (!!scope.userId && loopUserId === scope.userId);
}

export const auth = betterAuth({
  baseURL: process.env.PIEVO_BASE_URL || "http://127.0.0.1:3000",
  secret: authSecret || "dev-insecure-secret-change-in-prod",
  database: drizzleAdapter(db, { provider: "pg" }),
  socialProviders: authEnabled
    ? { github: { clientId: clientId!, clientSecret: clientSecret! } }
    : {},
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          if (!emailAllowed(user.email)) rejectDisallowedEmail(user.email);
          return { data: user };
        },
      },
    },
  },
});

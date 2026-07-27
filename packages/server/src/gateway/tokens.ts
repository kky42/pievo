/**
 * Machine + run credential helpers. Device tokens (`dk_…`) identify a machine
 * (its id is derived from the token: `m-sha256(token)[:16]`). A run
 * LEASE (`rk_…`) is minted per delivery, bound to one run, and carries the
 * run's least-privilege caps — the CLI dispatch authorizes the `pievo` shim
 * against it. Its lifecycle is a small state machine (`active` →
 * `terminal-grace` → `reconciliation-only`/`retired`), not a mint→revoke pair;
 * see `RunLease` below.
 *
 * Leases and connect-key bindings are DURABLE (run_leases / connect_keys
 * tables): they must survive a deploy, or every restart 401s the in-flight
 * runs' callbacks/finalize and silently mis-files a post-restart create into the
 * machine's home team. The 15-minute `new` idempotency window stays in-process;
 * losing it only degrades retry deduplication, never persisted data.
 */
import { createHash, randomBytes } from "node:crypto";

import { and, eq, inArray, isNotNull, lt } from "drizzle-orm";

import { db } from "../db/index.js";
import { connectKeys, runLeases } from "../db/schema.js";

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Mint a fresh device token (`dk_…`) — the one wire format `machineIdFromToken` consumes. */
export function mintDeviceToken(): string {
  return `dk_${randomBytes(15).toString("hex")}`;
}

/** Derive the stable machine id from its device token. */
export function machineIdFromToken(token: string): string {
  return `m-${sha256(token).slice(0, 16)}`;
}

/**
 * Whether a string has the one current device-token wire shape. This malformed-input
 * filter runs before enrollment lookup; the connect-key gate remains the auth boundary.
 */
const DEVICE_TOKEN_RE = /^dk_[0-9a-f]{30}$/;
export function isDeviceTokenShape(token: string): boolean {
  return DEVICE_TOKEN_RE.test(token);
}

// ---- connect keys (minted device token → owner + team binding, durable) ----
// A connect-key/claim is minted from a SPECIFIC team's dashboard session; we bind
// the minter and the VALIDATED active team to the key so (a) the daemon's first
// poll self-registers the machine under the minting user, and (b) `createLoop`
// lands the loop in that team — this is what lets ONE machine/daemon serve MANY
// teams. The teamId is captured server-side from the authenticated session (never
// from client input); the gateway re-validates membership at create time.
//
// Bindings are keyed by the derived machine id, so the key itself is never stored.
// They are not single-read: one paste may create several loops, and enrollment
// reads the binding too.

export interface ClaimIntent {
  /** The user who minted the key (the authenticated dashboard session). */
  userId: string;
  /** The validated active team the key was minted under. */
  teamId: string;
}

/** Keep bindings long enough for a leisurely paste, then drop (bounded table). */
export const CONNECT_KEY_TTL_MS = 24 * 60 * 60 * 1000;

function connectKeyFresh(mintedAt: string, now: number): boolean {
  return now - Date.parse(mintedAt) <= CONNECT_KEY_TTL_MS;
}

/** Bind a freshly-minted connect-key to its minter and validated team.
 *  Prunes expired rows on write. */
export async function rememberConnectKey(connectKey: string, intent: ClaimIntent): Promise<void> {
  const now = new Date();
  await db.delete(connectKeys).where(lt(connectKeys.mintedAt, new Date(now.getTime() - CONNECT_KEY_TTL_MS).toISOString()));
  const row = {
    machineId: machineIdFromToken(connectKey),
    userId: intent.userId,
    teamId: intent.teamId,
    mintedAt: now.toISOString(),
  };
  await db.insert(connectKeys).values(row).onConflictDoUpdate({ target: connectKeys.machineId, set: row });
}

/** Peek (NON-evicting) the team/minter a connect-key was minted under, if still live. */
export async function readClaimIntent(connectKey: string | null | undefined, now: number = Date.now()): Promise<ClaimIntent | undefined> {
  if (!connectKey) return undefined;
  const row = (await db.select().from(connectKeys).where(eq(connectKeys.machineId, machineIdFromToken(connectKey))))[0];
  if (!row || !connectKeyFresh(row.mintedAt, now)) return undefined;
  return { userId: row.userId, teamId: row.teamId };
}

/** The remembered owner of a self-registering machine, if any (still-live key). */
export async function getDeviceOwner(machineId: string, now: number = Date.now()): Promise<string | undefined> {
  const row = (await db.select().from(connectKeys).where(eq(connectKeys.machineId, machineId)))[0];
  if (!row || !connectKeyFresh(row.mintedAt, now)) return undefined;
  return row.userId;
}

/** Identity needed to seed a report-only lease outside the atomic claim path. */
export interface RunLeaseRegistration {
  runId: string;
  loopId: string;
  machineId: string;
}

/**
 * A run lease: the per-run credential and its lifecycle state machine.
 *
 *   active ──[normal report / canceled]──────────────────────────▶ deleted
 *      │
 *      └────[sweep reclaim]───▶ terminal-grace ──[reconcile]─────▶ deleted
 *                                      │
 *                                      ├──[daemon disavows]──▶ reconciliation-only ──[reconcile]──▶ deleted
 *                                      └──[expiry]────────────▶ retired ──[410 receipt]──────────▶ deleted
 *
 * `terminal-grace` marks terminal-report-only authority for a swept run awaiting
 * reconciliation. Non-report CLI verbs are refused; only the single final report
 * is honored. A
 * lease past `expiresAt` loses reconciliation authority and becomes durable
 * `retired`; it is deleted only when a matching 410 receipt commits.
 */
export interface RunLease {
  runId: string;
  loopId: string;
  machineId: string;
  state: "active" | "terminal-grace" | "reconciliation-only" | "retired";
  /** Absolute expiry (ms epoch). `Infinity` for active and retired rows;
   *  both reconciliation states carry the same late-report deadline. */
  expiresAt: number;
}

/** How long a terminal-grace lease stays alive to accept one late wake-report.
 *  A laptop can sleep overnight or across a weekend before the daemon resumes. */
export const TERMINAL_GRACE_MS = 24 * 60 * 60 * 1000;

/** Leases live in the `run_leases` table, keyed by sha256(full `rk_…` wire
 * token), so a deploy is invisible to an in-flight run and a DB leak never hands
 * out live credentials. In rows, `expiresAt` null encodes `Infinity`. */
function leaseFromRow(row: typeof runLeases.$inferSelect): RunLease {
  return {
    runId: row.runId,
    loopId: row.loopId,
    machineId: row.machineId,
    state: row.state,
    expiresAt: row.expiresAt == null ? Number.POSITIVE_INFINITY : Date.parse(row.expiresAt),
  };
}

/** Mint a fresh run lease and return its wire token (`rk_…`, so the unified CLI
 *  dispatch can tell a run credential from a device `dk_…` in O(1) before any
 *  lookup). Starts `active` with no expiry. */
const RUN_TOKEN_RE = /^rk_[0-9a-f]{32}$/;
export function isRunTokenShape(token: string): boolean {
  return RUN_TOKEN_RE.test(token);
}

export async function registerRunLease(caps: RunLeaseRegistration): Promise<string> {
  const token = `rk_${randomBytes(16).toString("hex")}`;
  await db.insert(runLeases).values({
    tokenHash: sha256(token),
    runId: caps.runId,
    loopId: caps.loopId,
    machineId: caps.machineId,
    createdAt: new Date().toISOString(),
  });
  return token;
}

/** Resolve a run lease. An elapsed reconciliation window is atomically reduced
 * to durable, non-authorizing retired evidence rather than deleted. */
export async function resolveLease(token: string, now: number = Date.now()): Promise<RunLease | undefined> {
  if (!isRunTokenShape(token)) return undefined;
  const tokenHash = sha256(token);
  let row = (await db.select().from(runLeases).where(eq(runLeases.tokenHash, tokenHash)))[0];
  if (!row) return undefined;
  if ((row.state === "terminal-grace" || row.state === "reconciliation-only") && row.expiresAt != null && now > Date.parse(row.expiresAt)) {
    row = (await db.update(runLeases)
      .set({ state: "retired", expiresAt: null })
      .where(and(eq(runLeases.tokenHash, tokenHash), inArray(runLeases.state, ["terminal-grace", "reconciliation-only"]), isNotNull(runLeases.expiresAt), lt(runLeases.expiresAt, new Date(now).toISOString())))
      .returning())[0] ?? (await db.select().from(runLeases).where(eq(runLeases.tokenHash, tokenHash)))[0];
    if (!row) return undefined;
  }
  return leaseFromRow(row);
}

/** Terminalize the lease(s) for `runId`: flip `active` → `terminal-grace`, opening
 *  the reconcile grace window (`TERMINAL_GRACE_MS`). This is the ONE transition the
 *  sweep uses when it reclaims a stuck run as a false failure — the lease survives
 *  so exactly ONE late wake-report can reconcile the run if the machine was merely
 *  asleep (see gateway `report()`). Idempotent: only an `active` lease flips (a
 *  re-terminalize keeps the first window), and it's a no-op for a run with no lease
 *  (e.g. a still-pending run). */
export async function terminalizeLease(runId: string, now: number = Date.now()): Promise<void> {
  await db
    .update(runLeases)
    .set({ state: "terminal-grace", expiresAt: new Date(now + TERMINAL_GRACE_MS).toISOString() })
    .where(and(eq(runLeases.runId, runId), eq(runLeases.state, "active")));
}

/** Retire a lease outside a terminal write transaction (canceled/losing report
 * cleanup and expiry paths). Normal finalize and reclaimed-run
 * reconcile consume the row inside their store transaction so run+loop+lease are
 * one single-shot commit. */
export async function retireLease(token: string): Promise<void> {
  await db.delete(runLeases).where(eq(runLeases.tokenHash, sha256(token)));
}

/** State-aware lease maintenance. Expired reconciliation authority becomes a
 * durable retired tombstone. Active and already-retired rows are never age-pruned. */
export async function pruneExpiredLeases(now: number = Date.now()): Promise<void> {
  await db.update(runLeases)
    .set({ state: "retired", expiresAt: null })
    .where(and(inArray(runLeases.state, ["terminal-grace", "reconciliation-only"]), isNotNull(runLeases.expiresAt), lt(runLeases.expiresAt, new Date(now).toISOString())));
}

// ---- `new` idempotency (content-hash → the loop it created) ----
// A create with no dedupe makes a fresh loop every call. The daemon sends a stable
// content key over the machine id and canonical config; this bounded in-memory map
// returns the existing loop for retries within the window. A server restart loses
// this best-effort dedupe, never persisted loop data.

export interface NewIdempotencyRecord {
  loopId: string;
  /** The machine the key created the loop on — the read guard rechecks it so a
   *  (hypothetical) cross-machine key can never replay another machine's loop. */
  machineId: string;
  /** Record time (ms) — drives the TTL prune so the map stays bounded. */
  at: number;
}

const newIdempotency = new Map<string, NewIdempotencyRecord>();
/** Long enough to swallow a timed-out retry without collapsing later creates. */
export const NEW_IDEMPOTENCY_TTL_MS = 15 * 60 * 1000;

function pruneNewIdempotency(now: number): void {
  for (const [key, rec] of newIdempotency) {
    if (now - rec.at > NEW_IDEMPOTENCY_TTL_MS) newIdempotency.delete(key);
  }
}

/** Remember that `key` (from THIS machine) created `loopId`. Pruned on write. */
export function recordNewIdempotency(key: string, machineId: string, loopId: string, now: number = Date.now()): void {
  pruneNewIdempotency(now);
  newIdempotency.set(key, { loopId, machineId, at: now });
}

/** The loop a still-live key already created for THIS machine, or undefined (a miss,
 *  an expired key — dropped here — or a cross-machine record). NON-evicting on a hit:
 *  a genuine retry may arrive more than once within the window. */
export function readNewIdempotency(key: string, machineId: string, now: number = Date.now()): string | undefined {
  const rec = newIdempotency.get(key);
  if (!rec) return undefined;
  if (now - rec.at > NEW_IDEMPOTENCY_TTL_MS) {
    newIdempotency.delete(key);
    return undefined;
  }
  if (rec.machineId !== machineId) return undefined;
  return rec.loopId;
}

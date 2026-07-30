import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

let tmp: string;
let tokens: typeof import("./tokens.js");
let db: typeof import("../db/index.js");

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-tokens-"));
  process.env.PIEVO_DATA_DIR = tmp;
  process.env.PIEVO_LOG_LEVEL = "silent";
  db = await import("../db/index.js");
  await db.runMigrations();
  tokens = await import("./tokens.js");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

let seq = 0;
/** A distinct run each call so leases never collide across tests (shared table). */
function caps(over: Partial<import("./tokens.js").RunLeaseRegistration> = {}): import("./tokens.js").RunLeaseRegistration {
  seq += 1;
  return { runId: `run-${seq}`, loopId: `loop-${seq}`, machineId: `m-${seq}`, ...over };
}

test("registerRunLease mints an rk_-prefixed token and an active, non-expiring lease", async () => {
  const c = caps();
  const token = await tokens.registerRunLease(c);
  expect(token.startsWith("rk_")).toBe(true);
  const lease = await tokens.resolveLease(token);
  expect(lease?.state).toBe("active");
  expect(lease?.expiresAt).toBe(Number.POSITIVE_INFINITY);
  expect(lease?.runId).toBe(c.runId);
  // An active lease never lazily expires, no matter how far the clock advances.
  expect((await tokens.resolveLease(token, Date.now() + 10 * tokens.TERMINAL_GRACE_MS))?.state).toBe("active");
});

test("a lease row stores only the token HASH — never the wire token", async () => {
  // The durability fix must not turn a DB leak into a live-credential leak: the
  // table is keyed by sha256(token), and no column carries the token itself.
  const token = await tokens.registerRunLease(caps());
  const { runLeases } = await import("../db/schema.js");
  const { eq } = await import("drizzle-orm");
  const byHash = await db.db.select().from(runLeases).where(eq(runLeases.tokenHash, tokens.sha256(token)));
  expect(byHash).toHaveLength(1);
  expect(JSON.stringify(byHash[0])).not.toContain(token);
});

test("resolveLease rejects malformed and unknown tokens", async () => {
  expect(await tokens.resolveLease("00000000-0000-0000-0000-000000000000")).toBeUndefined();
  expect(await tokens.resolveLease("rk_does-not-exist")).toBeUndefined();
});

test("terminalizeLease flips active → terminal-grace with a bounded expiry", async () => {
  const token = await tokens.registerRunLease(caps());
  const at = 1_000_000;
  await tokens.terminalizeLease((await tokens.resolveLease(token))!.runId, at);
  const lease = (await tokens.resolveLease(token, at))!;
  expect(lease.state).toBe("terminal-grace");
  expect(lease.expiresAt).toBe(at + tokens.TERMINAL_GRACE_MS);
});

test("an expired terminal-grace lease becomes a durable retired tombstone", async () => {
  const token = await tokens.registerRunLease(caps());
  const at = 2_000_000;
  await tokens.terminalizeLease((await tokens.resolveLease(token))!.runId, at);
  expect((await tokens.resolveLease(token, at + tokens.TERMINAL_GRACE_MS))?.state).toBe("terminal-grace");
  const retired = await tokens.resolveLease(token, at + tokens.TERMINAL_GRACE_MS + 1);
  expect(retired?.state).toBe("retired");
  expect(retired?.expiresAt).toBe(Number.POSITIVE_INFINITY);
  expect((await tokens.resolveLease(token))?.state).toBe("retired");
});

test("a reconciliation-only lease keeps the same deadline and expires to retired", async () => {
  const c = caps();
  const token = await tokens.registerRunLease(c);
  const at = Date.now();
  await tokens.terminalizeLease(c.runId, at);
  const store = await import("../db/store.js");
  await store.releaseAbsentReconciliations(c.machineId, [], new Date(at).toISOString());
  expect((await tokens.resolveLease(token, at))?.state).toBe("reconciliation-only");
  expect((await tokens.resolveLease(token, at + tokens.TERMINAL_GRACE_MS + 1))?.state).toBe("retired");
});

test("terminalizeLease is idempotent — a second call keeps the FIRST grace window", async () => {
  const token = await tokens.registerRunLease(caps());
  const runId = (await tokens.resolveLease(token))!.runId;
  await tokens.terminalizeLease(runId, 5_000_000);
  await tokens.terminalizeLease(runId, 9_000_000); // must NOT extend the window
  expect((await tokens.resolveLease(token, 5_000_000))!.expiresAt).toBe(5_000_000 + tokens.TERMINAL_GRACE_MS);
});

test("terminalizeLease is a no-op for a runId with no lease (still-pending run)", async () => {
  await expect(tokens.terminalizeLease("run-with-no-lease")).resolves.toBeUndefined();
});

test("retireLease deletes the lease single-shot (a second resolve is undefined)", async () => {
  const token = await tokens.registerRunLease(caps());
  expect(await tokens.resolveLease(token)).toBeTruthy();
  await tokens.retireLease(token);
  expect(await tokens.resolveLease(token)).toBeUndefined();
});

test("pruneExpiredLeases retires expired grace while preserving active, in-window, and retired leases", async () => {
  const active = await tokens.registerRunLease(caps());
  const inWindow = await tokens.registerRunLease(caps());
  const expired = await tokens.registerRunLease(caps());
  const alreadyRetired = await tokens.registerRunLease(caps());
  const now = Date.now();
  await tokens.terminalizeLease((await tokens.resolveLease(inWindow))!.runId, now);
  await tokens.terminalizeLease((await tokens.resolveLease(expired))!.runId, now - 2 * tokens.TERMINAL_GRACE_MS);
  await tokens.terminalizeLease((await tokens.resolveLease(alreadyRetired))!.runId, now - 2 * tokens.TERMINAL_GRACE_MS);
  await tokens.pruneExpiredLeases(now);

  expect((await tokens.resolveLease(active, now))?.state).toBe("active");
  expect((await tokens.resolveLease(inWindow, now))?.state).toBe("terminal-grace");
  expect((await tokens.resolveLease(expired, now))?.state).toBe("retired");
  await tokens.pruneExpiredLeases(now + tokens.TERMINAL_GRACE_MS);
  expect((await tokens.resolveLease(alreadyRetired))?.state).toBe("retired");
});

test("rememberConnectKey durably binds only the machine owner", async () => {
  const key = tokens.mintDeviceToken();
  await tokens.rememberConnectKey(key, { userId: "u-mint" });
  expect(await tokens.readConnectKeyBinding(key)).toEqual({ userId: "u-mint" });
  expect(await tokens.readConnectKeyBinding(key)).toEqual({ userId: "u-mint" });

  const { connectKeys } = await import("../db/schema.js");
  const { eq } = await import("drizzle-orm");
  const row = (await db.db.select().from(connectKeys)
    .where(eq(connectKeys.machineId, tokens.machineIdFromToken(key))))[0];
  expect(row).toEqual({
    machineId: tokens.machineIdFromToken(key),
    userId: "u-mint",
    mintedAt: expect.any(String),
  });
});

test("connect-key bindings expire after the TTL (lazy on read)", async () => {
  const key = tokens.mintDeviceToken();
  await tokens.rememberConnectKey(key, { userId: "u-ttl" });
  const past = Date.now() + tokens.CONNECT_KEY_TTL_MS + 1;
  expect(await tokens.readConnectKeyBinding(key, past)).toBeUndefined();
});

test("readConnectKeyBinding tolerates an absent or unknown key", async () => {
  expect(await tokens.readConnectKeyBinding(null)).toBeUndefined();
  expect(await tokens.readConnectKeyBinding(undefined)).toBeUndefined();
  expect(await tokens.readConnectKeyBinding("never-minted-key")).toBeUndefined();
});

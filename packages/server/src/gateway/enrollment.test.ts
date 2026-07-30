/**
 * Machine ENROLLMENT hardening (audit H-01 / M2). The poll route is the ONE
 * surface that self-registers a machine on first contact; before this fix it
 * minted a "shared" machine for ANY bearer string even under the GitHub login
 * gate, letting an unauthenticated caller create unbounded machine/loop rows.
 *
 * These tests reproduce the audit's poll enrollment path, prove unknown keys are
 * rejected in every mode, and cover expiry plus the `dk_` shape filter. Requiring
 * a remembered key also makes machine deletion durable: an old daemon cannot
 * recreate the row after its enrollment binding is revoked.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";

let tmp: string;
let db: typeof import("../db/index.js");
let store: typeof import("../db/store.js");
let gatewayMod: typeof import("./index.js");
let tokens: typeof import("./tokens.js");

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-enroll-"));
  process.env.PIEVO_DATA_DIR = tmp;
  process.env.PIEVO_LOG_LEVEL = "silent";
  db = await import("../db/index.js");
  await db.runMigrations();
  store = await import("../db/store.js");
  gatewayMod = await import("./index.js");
  tokens = await import("./tokens.js");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  await (db.client as any).exec("DELETE FROM run_leases; DELETE FROM connect_keys; DELETE FROM runs; DELETE FROM loops; DELETE FROM machines;");
});

/** Restore the gate env after every case so it can't leak between tests. */
afterEach(() => {
  delete process.env.GITHUB_CLIENT_ID;
  delete process.env.GITHUB_CLIENT_SECRET;
});

function enableGate(): void {
  process.env.GITHUB_CLIENT_ID = "gh-client-id";
  process.env.GITHUB_CLIENT_SECRET = "gh-client-secret";
}

function gateway() {
  return new gatewayMod.MachineGateway(
    {
      advanceDueSchedules(): never[] { return []; },
      enqueueInitialExec(): void {},
      addLoop(): void {},
      removeLoop(): void {},
      runNow(): void {},
    } as any,
    undefined,
  );
}

function pollV4(
  gw: InstanceType<typeof gatewayMod.MachineGateway>,
  token: string,
  info?: { host?: string; platform?: string; arch?: string; version?: string },
) {
  return gw.pollV4(token, {
    protocolVersion: 4,
    daemonInstanceId: "test-daemon",
    recoveryComplete: true,
    currentRuns: [],
    info: { version: "2.4.0", ...info },
  });
}

test("gated mode: a forged bearer token cannot self-register via poll", async () => {
  enableGate();
  const gw = gateway();
  const forged = "dk_unauthenticated_gated_repro"; // the audit's exact repro token
  const res = await pollV4(gw, forged, { host: "attacker-gated" });
  expect(res.status).toBe(401);
  expect(await store.getMachine(tokens.machineIdFromToken(forged))).toBeUndefined();
});

test("gated mode: an EXPIRED connect-key does not enroll", async () => {
  enableGate();
  const gw = gateway();
  const deviceToken = tokens.mintDeviceToken();
  await tokens.rememberConnectKey(deviceToken, { userId: "u1" });
  await (db.client as any).exec(
    `UPDATE connect_keys SET minted_at = '${new Date(Date.now() - tokens.CONNECT_KEY_TTL_MS - 1000).toISOString()}'`,
  );
  const res = await pollV4(gw, deviceToken, { host: "late" });
  expect(res.status).toBe(401);
  expect(await store.getMachine(tokens.machineIdFromToken(deviceToken))).toBeUndefined();
});

test("malformed device tokens are rejected early with 401", async () => {
  const gw = gateway();
  for (const bad of ["", "no-prefix", "dk_", "dk_x", "Bearer dk_abc", "dk_has space"]) {
    const res = await pollV4(gw, bad);
    expect(res.status, `token ${JSON.stringify(bad)}`).toBe(401);
    expect((res.body as { error: string }).error).toMatch(/invalid device token/);
  }
});

test("open mode: an unknown dk_ token cannot self-register", async () => {
  const gw = gateway();
  const token = tokens.mintDeviceToken();
  const res = await pollV4(gw, token, { host: "dev-box" });
  expect(res.status).toBe(401);
  expect(await store.getMachine(tokens.machineIdFromToken(token))).toBeUndefined();
});

test("a remembered connect key enrolls a machine for its bound user", async () => {
  const gw = gateway();
  const token = tokens.mintDeviceToken();
  await tokens.rememberConnectKey(token, { userId: "u1" });
  const res = await pollV4(gw, token, { host: "dev-box" });
  expect(res.status).toBe(200);
  const machine = await store.getMachine(tokens.machineIdFromToken(token));
  expect(machine).toMatchObject({ userId: "u1", name: "dev-box" });
  expect(machine).not.toHaveProperty("teamId");
});

test("a deleted machine cannot recreate itself with its revoked token", async () => {
  const gw = gateway();
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await tokens.rememberConnectKey(token, { userId: "shared" });
  expect((await pollV4(gw, token, { host: "dev-box" })).status).toBe(200);
  expect((await store.forceDeleteMachine(machineId)).state).toBe("deleted");
  expect((await pollV4(gw, token, { host: "dev-box" })).status).toBe(401);
  expect(await store.getMachine(machineId)).toBeUndefined();
});

test("a token whose id collides with a registered machine but whose hash differs is rejected", async () => {
  const gw = gateway();
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  // A pre-existing machine on that id, but registered under a DIFFERENT token hash.
  await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: "some-other-hash", online: true });
  const res = await pollV4(gw, token, { host: "x" });
  expect(res.status).toBe(401);
  expect((res.body as { error: string }).error).toMatch(/mismatch/);
});

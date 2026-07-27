import * as store from "../db/store.js";
import type { Machine } from "../db/schema.js";
import type { HttpResult } from "./http.js";
import { isDeviceTokenShape, machineIdFromToken, sha256 } from "./tokens.js";

export interface AuthenticatedDevice {
  machineId: string;
  machine: Machine;
}

export type DeviceAuthResult =
  | { ok: true; machineId: string; machine: Machine | undefined }
  | { ok: false; reason: "invalid" | "unknown" | "mismatch"; response: HttpResult };

/**
 * Resolve a device credential and verify the complete token hash stored on the
 * machine row. The derived, truncated machine id is only a lookup key; it is
 * never sufficient authentication.
 *
 * Enrollment/status/home may allow a genuinely unknown token, but a token that
 * collides with an existing machine id still fails the full-hash check.
 */
export async function authenticateDeviceToken(
  deviceToken: string,
  options: { allowUnknown?: boolean } = {},
): Promise<DeviceAuthResult> {
  if (!isDeviceTokenShape(deviceToken)) {
    return { ok: false, reason: "invalid", response: { status: 401, body: { error: "invalid device token" } } };
  }
  const machineId = machineIdFromToken(deviceToken);
  const machine = await store.getMachine(machineId);
  if (!machine) {
    return options.allowUnknown
      ? { ok: true, machineId, machine: undefined }
      : { ok: false, reason: "unknown", response: { status: 401, body: { error: "unknown machine (token not registered)" } } };
  }
  if (!machine.tokenHash || machine.tokenHash !== sha256(deviceToken)) {
    return { ok: false, reason: "mismatch", response: { status: 401, body: { error: "device token mismatch" } } };
  }
  return { ok: true, machineId, machine };
}

/**
 * The canonical CLI transport client. Both CLI
 * worlds — the in-run callback (`pievo report …`, run token) and the owner's
 * out-of-run verbs (`pievo loops`/`edit`/`log`/`new`, device token) — use this
 * module to pick the active credential and POST `{argv}` to
 * `/api/machine/cli`.
 */

import { DEVICE_FILE, readStored, resolveServerUrl } from "./config.js";

/** A server reply. A non-JSON body is represented as an empty object and rejected
 *  by the caller because canonical CLI responses require `text`. */
export interface CliResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface PostCliDeps {
  fetchImpl?: typeof fetch;
  /** Env carrying the run token (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Test override for the persisted device token (else readStored(DEVICE_FILE)). */
  deviceToken?: string | undefined;
  /** Fully-resolved server url override (tests) — bypasses resolveServerUrl. */
  server?: string;
  /** A `--server-url` flag value the caller extracted from its argv, if any. */
  serverFlag?: string | undefined;
}

export type PostCliResult =
  | { kind: "ok"; status: number; body: Record<string, unknown> }
  | { kind: "not-configured" }
  | { kind: "network-error"; message: string };

/**
 * Resolve the credential: the in-run run token wins, otherwise use the persisted
 * device token. Undefined means neither is available.
 */
export function resolveCredential(deps: PostCliDeps = {}): { token: string } | undefined {
  const env = deps.env ?? process.env;
  const runToken = env.PIEVO_RUN_TOKEN;
  if (runToken) return { token: runToken };
  const device = "deviceToken" in deps ? deps.deviceToken : readStored(DEVICE_FILE);
  if (device) return { token: device };
  return undefined;
}

/**
 * POST `{argv}` to the unified `/api/machine/cli` with whatever credential the env
 * carries. Never throws — a missing credential/server and a network fault map to
 * distinct results so callers render their own message.
 */
export async function postCli(argv: string[], deps: PostCliDeps = {}): Promise<PostCliResult> {
  const cred = resolveCredential(deps);
  const server = "server" in deps ? (deps.server ?? "") : resolveServerUrl(deps.serverFlag);
  if (!cred || !server) return { kind: "not-configured" };
  const fetchImpl = deps.fetchImpl ?? fetch;

  try {
    const res = await fetchImpl(`${server}/api/machine/cli`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cred.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ argv }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { kind: "ok", status: res.status, body };
  } catch (err) {
    return { kind: "network-error", message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The text-sink primary path: print the server's pre-rendered `text` and return its
 * `exitCode`. The server owns the render and the daemon is a dumb sink. Returns
 * null when the response violates the current transport contract. Never used for the
 * not-configured/network-error results (those carry no server body) —
 * callers handle those first.
 */
export function printText(
  body: Record<string, unknown>,
  status: number,
  out: (s: string) => void,
): number | null {
  const text = body.text;
  if (typeof text === "string" && text.length > 0) {
    out(text.endsWith("\n") ? text : text + "\n");
    return typeof body.exitCode === "number" ? body.exitCode : status >= 200 && status < 300 ? 0 : 1;
  }
  return null;
}

/** Print a canonical server render or fail loudly on an invalid response. */
export function printCliResponse(
  body: Record<string, unknown>,
  status: number,
  out: (s: string) => void,
): number {
  const code = printText(body, status, out);
  if (code !== null) return code;
  out(
    `error: ${JSON.stringify(
      "invalid Pievo server response: missing rendered `text`",
    )}\ncode: INVALID_SERVER_RESPONSE\n`,
  );
  return 1;
}

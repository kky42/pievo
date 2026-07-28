import { activeConnection, connectionFor, resolveServerUrl } from "./config.js";
import { boundedFetch } from "./http.js";

const CLI_TIMEOUT_MS = 30_000;

/** A server reply. A non-JSON body is represented as an empty object and rejected
 *  by the caller because canonical CLI responses require `text`. */
export interface CliResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface PostCliDeps {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  deviceToken?: string | undefined;
  server?: string;
  serverFlag?: string | undefined;
}

export type PostCliResult =
  | { kind: "ok"; status: number; body: Record<string, unknown> }
  | { kind: "not-configured" }
  | { kind: "network-error"; message: string };

export function resolveCredential(deps: PostCliDeps = {}, server?: string): { token: string } | undefined {
  const env = deps.env ?? process.env;
  const runToken = env.PIEVO_RUN_TOKEN;
  if (runToken) return { token: runToken };
  const device = "deviceToken" in deps
    ? deps.deviceToken
    : (server ? connectionFor(server)?.deviceToken : activeConnection()?.deviceToken);
  if (device) return { token: device };
  return undefined;
}

export async function postCli(argv: string[], deps: PostCliDeps = {}): Promise<PostCliResult> {
  const server = "server" in deps ? (deps.server ?? "") : resolveServerUrl(deps.serverFlag);
  const cred = resolveCredential(deps, server);
  if (!cred || !server) return { kind: "not-configured" };
  const fetchImpl = deps.fetchImpl ?? ((url: string, init: RequestInit) => boundedFetch(url, init, CLI_TIMEOUT_MS));

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

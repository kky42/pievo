/**
 * Machine-route ingress: read + parse a JSON request body under a hard size cap.
 * The gateway's per-field wire caps (WIRE_TEXT_CAP etc.) clip individual strings
 * AFTER parse — without this, an unbounded `request.json()` still buffers an
 * arbitrarily large body first. Framework-free (plain Request) so any machine
 * route can share it.
 */

/**
 * Body cap for the standard machine routes (poll / report / loop / agent-api).
 * 2MB — generously above the largest legitimate body: a report can carry a
 * 512KB taskFileContent + 512KB finalText + a 256KB cursor; an editLoop/agent-api
 * payload maxes out around one or two 512KB content fields. The sync route has
 * its own, larger cap (SYNC_BODY_CAP — it inlines blob bytes).
 */
export const MACHINE_BODY_CAP = 2 * 1024 * 1024;

export type JsonBodyResult =
  | { kind: "ok"; body: unknown }
  | { kind: "too-large" }
  | { kind: "invalid" };

/**
 * Read + parse a JSON body under an actual byte cap. The declared content-length
 * is a cheap early reject; chunked/lying clients are bounded while streaming, and
 * the reader is canceled immediately once the accumulated UTF-8 bytes cross the
 * cap. An unreadable or empty body parses as `{}` (matching the old
 * `request.json().catch(() => ({}))`); parse failures remain `invalid`.
 */
export async function readJsonBody(request: Request, maxBytes: number): Promise<JsonBodyResult> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return { kind: "too-large" };
  if (!request.body) return { kind: "ok", body: {} };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        // Initiate cancellation but do not let a slow underlying cancel hook delay
        // the 413 result; the reader has already stopped consuming chunks.
        void reader.cancel("request body exceeds byte cap").catch(() => undefined);
        return { kind: "too-large" };
      }
      chunks.push(value);
    }
  } catch {
    // Preserve the old `request.text().catch(() => "")` empty-body behavior.
    return { kind: "ok", body: {} };
  } finally {
    reader.releaseLock();
  }

  if (bytes === 0) return { kind: "ok", body: {} };
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(body);
  if (!text) return { kind: "ok", body: {} };
  try {
    return { kind: "ok", body: JSON.parse(text) };
  } catch {
    return { kind: "invalid" };
  }
}

// ---- shared wire-egress shape + string discipline ----
// Generic plumbing shared by every gateway module (index / cli / sync). It lives
// here - a leaf module with no gateway imports - so index.ts stays pure
// run-lifecycle core instead of doubling as the toolbox (pinned by layout.test.ts).

/** Transport-free HTTP result: gateway methods decide status + body; the thin
 *  route shells just `Response.json(r.body, { status: r.status })`. */
export interface HttpResult {
  status: number;
  body: unknown;
}

/** Cap for free-text wire fields (task / workflow / taskFileContent) — one shared
 *  clipping discipline for every large string the daemon can send. */
export const WIRE_TEXT_CAP = 512 * 1024;

export function nowIso(): string {
  return new Date().toISOString();
}

/** Strip NUL (U+0000) from a wire string: Postgres text/jsonb columns REJECT the
 *  NUL byte (SQLite tolerated it), so a daemon-supplied string carrying one would
 *  throw mid-finalize on the DB write. The single sanitizing primitive behind
 *  `clipText` and index.ts's `str`/`stripNulDeep` - and used directly by `cli.ts`
 *  (parseFlags/validateState, the same one-chokepoint discipline). */
export function stripNul(s: string): string {
  return s.replace(/\u0000/g, "");
}

/** Clip a free-text wire field to its byte-budget cap AND strip NUL — the shared
 *  chokepoint for every capped daemon string (message / finalText / taskFileContent
 *  / sessionId / error / …). Caps are unchanged; NUL is removed so the DB write can't
 *  throw. */
export function clipText(s: string, cap: number): string {
  return stripNul(s.slice(0, cap));
}

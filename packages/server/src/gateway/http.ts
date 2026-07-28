/**
 * Machine-route ingress: read + parse a JSON request body under a hard size cap.
 * The gateway's per-field wire caps (WIRE_TEXT_CAP etc.) clip individual strings
 * AFTER parse — without this, an unbounded `request.json()` still buffers an
 * arbitrarily large body first. Framework-free (plain Request) so any machine
 * route can share it.
 */

/**
 * Body cap for standard machine routes (poll / report / CLI).
 * 2MB — generously above the largest legitimate terminal report or loop edit.
 * The exact-manifest sync route has its own 32 MB JSON-body cap.
 */
export const MACHINE_BODY_CAP = 2 * 1024 * 1024;

export type ByteBodyResult =
  | { kind: "ok"; bytes: Uint8Array }
  | { kind: "too-large" }
  | { kind: "invalid" };

export type JsonBodyResult =
  | { kind: "ok"; body: unknown }
  | { kind: "too-large" }
  | { kind: "invalid" };

/** Read raw request bytes under a hard cap. Declared oversize requests fail
 * before reading; chunked/lying streams are canceled on the first chunk that
 * takes the observed count over the cap. */
export async function readByteBody(request: Request, maxBytes: number): Promise<ByteBodyResult> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return { kind: "too-large" };
  if (!request.body) return { kind: "ok", bytes: new Uint8Array() };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        // Do not await a potentially slow source cancel hook: consumption has
        // already stopped and the caller can return 413 immediately.
        void reader.cancel("request body exceeds byte cap").catch(() => undefined);
        return { kind: "too-large" };
      }
      chunks.push(value);
    }
  } catch {
    return { kind: "invalid" };
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: "ok", bytes };
}

/**
 * Read + parse a JSON body under an actual byte cap. An empty body parses as
 * `{}`; unreadable streams and parse failures are invalid.
 */
export async function readJsonBody(request: Request, maxBytes: number): Promise<JsonBodyResult> {
  const read = await readByteBody(request, maxBytes);
  if (read.kind !== "ok") return read;
  if (read.bytes.byteLength === 0) return { kind: "ok", body: {} };
  const text = new TextDecoder().decode(read.bytes);
  if (!text) return { kind: "ok", body: {} };
  try {
    return { kind: "ok", body: JSON.parse(text) };
  } catch {
    return { kind: "invalid" };
  }
}

// Generic plumbing shared by every gateway module (index / cli / sync). It lives
// here - a leaf module with no gateway imports - so index.ts stays pure
// run-lifecycle core instead of doubling as the toolbox (pinned by layout.test.ts).

/** Transport-free HTTP result: gateway methods decide status + body; the thin
 *  route shells just `Response.json(r.body, { status: r.status })`. */
export interface HttpResult {
  status: number;
  body: unknown;
}

export const WIRE_TEXT_CAP = 512 * 1024;
/** Poll identity strings use the normal wire-text budget; package versions have
 * a tighter existing budget because canonical SemVer is necessarily short. */
export const POLL_INFO_TEXT_CAP = WIRE_TEXT_CAP;
export const POLL_VERSION_CAP = 64;

/** Validate an optional poll string without coercion, clipping, or NUL removal. */
export function validOptionalPollString(value: unknown, cap: number): value is string | undefined {
  return value === undefined || (typeof value === "string" && value.length <= cap && !value.includes("\0"));
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Strip NUL (U+0000) from a wire string: Postgres text/jsonb columns REJECT the
 *  NUL byte (SQLite tolerated it), so a daemon-supplied string carrying one would
 *  throw mid-finalize on the DB write. The single sanitizing primitive behind
 *  `clipText` and index.ts's `str` - and used directly by `cli.ts`
 *  (parseFlags/validateState, the same one-chokepoint discipline). */
export function stripNul(s: string): string {
  return s.replace(/\u0000/g, "");
}

export function clipText(s: string, cap: number): string {
  return stripNul(s.slice(0, cap));
}

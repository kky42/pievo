/**
 * Hand-rolled subset front-matter parser for loop products — ZERO deps (repo
 * precedent: `parseUnifiedDiff` in `runDiff.ts` deliberately avoided a diff lib;
 * this deliberately avoids a YAML lib). A markdown product MAY open with a fenced
 * `---` block of simple top-level `key: value` scalars; this reads that block and
 * nothing else.
 *
 * The convention is SOFT — prompt + UI incentive, never a sync/storage gate. So
 * this parser is forgiving by construction: it only attempts when the content
 * opens with a `---` fence, bounds the scanned block (a few KB), skips any line it
 * can't read as a top-level scalar, and returns null/partial on ANY malformation —
 * it NEVER throws. A file that isn't fronted, or whose block is broken, is simply
 * untyped (meta null), which is exactly how old blobs behave.
 *
 * Pure string work (no bytes interpreted, no execution) so the server's zero-exec
 * invariant holds; the ingress points decode a non-binary blob to utf8 and hand
 * the text here.
 */

/** The indexed subset of a product's front matter — every field OPTIONAL.
 *  Presence of `date` marks a dated product; its absence marks a living doc.
 *  `type` is an open, per-loop classification label; `title` a display title. */
export interface ArtifactMeta {
  type?: string;
  title?: string;
  date?: string;
}

/** Don't scan past this many bytes for the closing fence — a real front-matter
 *  block is a handful of short lines; anything larger is not front matter and we
 *  refuse to walk a whole multi-MB file looking for a `---`. */
const MAX_BLOCK_BYTES = 8 * 1024;
/** A scalar value longer than this is clipped — the meta row is an index, not a
 *  content store (the body already lives in the blob). */
const MAX_VALUE_LEN = 500;
/** A key must be a short identifier-ish token; anything else isn't a scalar line. */
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Strip one layer of matching surrounding quotes (single or double). */
function unquote(v: string): string {
  if (v.length >= 2) {
    const q = v[0];
    if ((q === '"' || q === "'") && v[v.length - 1] === q) return v.slice(1, -1);
  }
  return v;
}

/**
 * Parse the top-level `key: value` scalars from a leading `---` front-matter
 * block. Returns the full scalar map (unknown keys KEPT — the convention tolerates
 * them), or null when there's no opening fence / no closing fence within the
 * bound / no scalar lines at all. Never throws.
 */
export function parseFrontMatter(content: string): Record<string, string> | null {
  if (typeof content !== "string") return null;
  // Tolerate a leading BOM, but the very first meaningful chars must be the fence.
  let text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  // Only attempt when the content OPENS with a `---` fence line (nothing before it).
  const openMatch = /^---[ \t]*\r?\n/.exec(text);
  if (!openMatch) return null;

  // Bound the region we scan for the closing fence.
  const region = text.slice(openMatch[0].length, openMatch[0].length + MAX_BLOCK_BYTES);
  const lines = region.split("\n");

  const out: Record<string, string> = {};
  let closed = false;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");
    // Closing fence — a line that is exactly `---` (trailing spaces tolerated).
    if (/^---[ \t]*$/.test(line)) {
      closed = true;
      break;
    }
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue; // blank / comment → skip
    const colon = line.indexOf(":");
    if (colon <= 0) continue; // not a `key: value` line (list item, prose, …) → skip
    // Top-level only: an indented line is nested structure, not a scalar we index.
    if (/^\s/.test(line)) continue;
    const key = line.slice(0, colon).trim();
    if (!KEY_RE.test(key)) continue; // not a simple scalar key → skip
    let value = line.slice(colon + 1).trim();
    if (!value) continue; // `key:` with no scalar (a nested block follows) → skip
    value = unquote(value).slice(0, MAX_VALUE_LEN);
    if (!value) continue; // empty after unquoting
    if (!(key in out)) out[key] = value; // first wins (a dup key is malformed-ish)
  }

  if (!closed) return null; // no closing fence within the bound → not front matter
  return Object.keys(out).length ? out : null;
}

/**
 * The indexed subset — `{type?, title?, date?}` — for a non-binary product's text,
 * or null when the file has no usable front matter. This is what the blob row
 * stores; unknown scalar fields are dropped here (kept by the parser, ignored by
 * storage + UI). `date` is stored RAW (validity is the consumer's concern — the
 * calendar decides whether it's a real day).
 */
export function artifactMeta(content: string): ArtifactMeta | null {
  const fm = parseFrontMatter(content);
  if (!fm) return null;
  const meta: ArtifactMeta = {};
  if (fm.type) meta.type = fm.type;
  if (fm.title) meta.title = fm.title;
  if (fm.date) meta.date = fm.date;
  return Object.keys(meta).length ? meta : null;
}

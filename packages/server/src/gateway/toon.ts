/** Pure TOON rendering for `/api/machine/cli` response text. Braces, commas,
 * and quotes are omitted where unambiguous; every helper is deterministic. */

export type Scalar = string | number | boolean | null | undefined;

/** Placeholder for an absent value. */
export const ABSENT = "—";

/** Whether a token needs quoting inside a key/value line or comma-delimited row. */
export function needsQuote(s: string): boolean {
  return s === "" || /[\s,:"]/.test(s);
}

/** Quote and escape a string so it remains on one line. */
export function quote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n")}"`;
}

/** Render one scalar the TOON way: a finite number / boolean bare, null|undefined as
 *  the em-dash placeholder, a string bare unless it needs quoting. */
export function scalar(v: Scalar): string {
  if (v === null || v === undefined) return ABSENT;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : ABSENT;
  if (typeof v === "boolean") return v ? "true" : "false";
  return needsQuote(v) ? quote(v) : v;
}

/** A single top-level `key: value` line (value scalar-rendered). */
export function kvLine(key: string, v: Scalar): string {
  return `${key}: ${scalar(v)}`;
}

/**
 * A detail block: a top key, then each field indented two spaces as `key: value`.
 * The value may be a pre-rendered raw string (pass a `{ raw }`) so composite values
 * (e.g. a size hint or an already-quoted body) render verbatim.
 *
 *   topKey:
 *     name: "Docs Sweep"
 *     cron: "0 6 * * 1"
 */
export function detailBlock(topKey: string, rows: Array<[string, Scalar | { raw: string }]>): string {
  const lines = [`${topKey}:`];
  for (const [k, v] of rows) {
    const rendered = v !== null && typeof v === "object" && "raw" in v ? v.raw : scalar(v);
    lines.push(`  ${k}: ${rendered}`);
  }
  return lines.join("\n");
}

/** Render a count, optionally with total or displayed-window context. */
export function countLine(count: number, opts: { total?: number; showing?: number } = {}): string {
  if (opts.total !== undefined) return `count: ${count} of ${opts.total} total`;
  if (opts.showing !== undefined) return `count: ${count} (showing first ${opts.showing})`;
  return `count: ${count}`;
}

/**
 * A typed list block: the header row `name[N]{f1,f2}:` then each record as an
 * indented comma row (cells scalar-rendered, quoted only when needed). Does NOT emit
 * the `count:` line — compose it with `countLine` so the caller controls the
 * aggregate flavor.
 *
 *   loops[2]{id,name,cron,enabled}:
 *     loop-abc,"Docs Sweep","0 6 * * 1",on
 */
export function listBlock(name: string, fields: string[], rows: Scalar[][]): string {
  const lines = [`${name}[${rows.length}]{${fields.join(",")}}:`];
  for (const row of rows) lines.push(`  ${row.map(scalar).join(",")}`);
  return lines.join("\n");
}

/** Render an empty named collection. */
export function emptyList(name: string): string {
  return `${name}: []`;
}

/** Render command templates as an indented help block. */
export function helpBlock(lines: string[]): string {
  return [`help[${lines.length}]:`, ...lines.map((l) => `  ${l}`)].join("\n");
}

/**
 * Render a quoted error plus a machine-readable code.
 *
 *   error: "status must be keep|no-change|block (got \"wibble\")"
 *   code: VALIDATION_ERROR
 */
export function errorBlock(message: string, code: string): string {
  return `error: ${quote(message)}\ncode: ${code}`;
}

/** Map an HTTP status to its CLI error code. */
export function codeForStatus(status: number): string {
  switch (status) {
    case 400:
      return "VALIDATION_ERROR";
    case 401:
      return "UNAUTHORIZED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    case 429:
      return "RATE_LIMITED";
    default:
      return "ERROR";
  }
}

/** Clip content at `cap` and append its original size plus recovery hint. */
export function truncate(
  text: string,
  cap: number,
  tail = "use --full to see complete body",
): { value: string; truncated: boolean } {
  if (text.length <= cap) return { value: text, truncated: false };
  return {
    value: `${text.slice(0, cap)} (truncated, ${text.length} chars total — ${tail})`,
    truncated: true,
  };
}

/** Join document sections with a single newline, dropping empty/blank sections so a
 *  missing optional block (e.g. no rejections) leaves no stray blank line. */
export function doc(...sections: Array<string | null | undefined | false>): string {
  return sections.filter((s): s is string => typeof s === "string" && s.length > 0).join("\n");
}

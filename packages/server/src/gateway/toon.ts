export type Scalar = string | number | boolean | null | undefined;

export const ABSENT = "—";

export function needsQuote(s: string): boolean {
  return s === "" || /[\s,:"]/.test(s);
}

export function quote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n")}"`;
}

export function scalar(v: Scalar): string {
  if (v === null || v === undefined) return ABSENT;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : ABSENT;
  if (typeof v === "boolean") return v ? "true" : "false";
  return needsQuote(v) ? quote(v) : v;
}

export function kvLine(key: string, v: Scalar): string {
  return `${key}: ${scalar(v)}`;
}

export function detailBlock(topKey: string, rows: Array<[string, Scalar | { raw: string }]>): string {
  const lines = [`${topKey}:`];
  for (const [k, v] of rows) {
    const rendered = v !== null && typeof v === "object" && "raw" in v ? v.raw : scalar(v);
    lines.push(`  ${k}: ${rendered}`);
  }
  return lines.join("\n");
}

export function countLine(count: number, opts: { total?: number; showing?: number } = {}): string {
  if (opts.total !== undefined) return `count: ${count} of ${opts.total} total`;
  if (opts.showing !== undefined) return `count: ${count} (showing first ${opts.showing})`;
  return `count: ${count}`;
}

export function listBlock(name: string, fields: string[], rows: Scalar[][]): string {
  const lines = [`${name}[${rows.length}]{${fields.join(",")}}:`];
  for (const row of rows) lines.push(`  ${row.map(scalar).join(",")}`);
  return lines.join("\n");
}

export function emptyList(name: string): string {
  return `${name}: []`;
}

export function helpBlock(lines: string[]): string {
  return [`help[${lines.length}]:`, ...lines.map((l) => `  ${l}`)].join("\n");
}

export function errorBlock(message: string, code: string): string {
  return `error: ${quote(message)}\ncode: ${code}`;
}

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

export function doc(...sections: Array<string | null | undefined | false>): string {
  return sections.filter((s): s is string => typeof s === "string" && s.length > 0).join("\n");
}

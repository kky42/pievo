/**
 * Content-field validators/normalizers for a loop's ui / metricSchema.
 *
 * ANTI-DRIFT INVARIANT: the owner device-token edit surface (`createLoop`/
 * `editLoop` in `gateway/index.ts`) and the run-token `set-ui`/`set-schema`
 * surface (`applySet*` in `gateway/cli.ts`) MUST validate
 * identically - both import this ONE module, so the two write paths cannot
 * drift. Each validator returns a normalized value ready to feed
 * `store.updateLoop`, or a `{ ok: false, detail }` the caller maps to a
 * 400/rejection.
 */
import * as store from "../db/store.js";
import type { MetricField } from "../db/schema.js";
import { stripNul, WIRE_TEXT_CAP } from "./http.js";

/** Normalize an optional provider-owned setting without validating its vocabulary.
 * Pievo deliberately treats model ids and reasoning efforts as opaque text; null or
 * blank delegates selection to the coding-agent CLI. */
export function normalizeProviderSetting(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const value = input.replaceAll("\0", "").trim();
  return value || null;
}

/** Validate the authoritative owner instruction shared by the web and device
 * steer surfaces. Reject rather than clip so the owner never believes a partial
 * instruction was applied. */
export function validateSteerInstruction(input: unknown): { ok: true; value: string } | { ok: false; detail: string } {
  if (typeof input !== "string") return { ok: false, detail: "describe what to change" };
  const value = stripNul(input).trim();
  if (!value) return { ok: false, detail: "describe what to change" };
  if (value.length > WIRE_TEXT_CAP) {
    return { ok: false, detail: `steer instruction exceeds ${WIRE_TEXT_CAP} characters` };
  }
  return { ok: true, value };
}

/** Sanitize/normalize dashboard HTML → the stored value (or null to clear).
 * Reject custom primitives that would render as silent empty/error panels after
 * DOMPurify strips invented attributes. Ordinary HTML remains intentionally loose. */
export function validateUi(html: string): { ok: true; value: string | null } | { ok: false; detail: string } {
  const trimmed = html.trim();
  if (trimmed.length > store.UI_MAX_LEN) {
    return { ok: false, detail: `dashboard UI exceeds ${store.UI_MAX_LEN} characters` };
  }
  const value = store.coerceUi(trimmed) ?? null;
  if (!value) return { ok: true, value: null };
  const required = [
    { tag: "loop-chart", attrs: ["series"] },
    { tag: "loop-embed", attrs: ["file", "match"] },
    { tag: "loop-kanban", attrs: ["columns"] },
  ] as const;
  for (const { tag, attrs } of required) {
    for (const match of value.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, "gi"))) {
      const rawAttrs = match[1] ?? "";
      const present = attrs.some((attr) => new RegExp(`(?:^|\\s)${attr}\\s*=\\s*["'][^"']+`, "i").test(rawAttrs));
      if (!present) {
        const need = attrs.length === 1 ? `${attrs[0]}="…"` : `${attrs.join('="…" or ')}="…"`;
        return { ok: false, detail: `<${tag}> requires ${need}` };
      }
    }
  }
  return { ok: true, value };
}

/** Validate a metric schema. Accepts a JSON string (run-token path) or an
 *  already-parsed value (an `editLoop` JSON patch may carry the array inline).
 *  Enforces the additive rule: keys still bound by the UI or reported by
 *  recent runs may not be dropped. */
export async function validateSchema(loopId: string, input: unknown): Promise<{ ok: true; value: MetricField[] } | { ok: false; detail: string }> {
  if (!(await store.getLoop(loopId))) return { ok: false, detail: "loop not found" };
  let parsed: unknown = input;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input);
    } catch {
      return { ok: false, detail: 'schema must be JSON, e.g. [{"key":"mrr","label":"MRR","unit":"$"}]' };
    }
  }
  const result = store.parseMetricSchema(parsed);
  if (!result.ok) return result;
  const schema = result.value;
  const have = new Set(schema.map((f) => f.key));
  const dropped = (await schemaKeysInUse(loopId)).filter((k) => !have.has(k));
  if (dropped.length) {
    return {
      ok: false,
      detail: `schema changes are additive — keep keys still in use: ${dropped.join(", ")} (bound by the UI or reported by recent runs).`,
    };
  }
  return { ok: true, value: schema };
}

async function schemaKeysInUse(loopId: string): Promise<string[]> {
  const keys = new Set<string>();
  const loop = await store.getLoop(loopId);
  if (loop?.ui) {
    for (const m of loop.ui.matchAll(/\{\{\s*latest\.([a-zA-Z0-9_-]+)[^}]*\}\}/g)) keys.add(m[1]!);
    for (const m of loop.ui.matchAll(/(?:series|key)=["']([^"']+)["']/g)) {
      for (const part of m[1]!.split(",")) {
        const key = part.trim().split(":")[0]?.trim();
        if (key) keys.add(key);
      }
    }
  }
  for (const run of await store.listRuns(loopId, 100)) {
    if (!run.metrics || typeof run.metrics !== "object") continue;
    for (const key of Object.keys(run.metrics as Record<string, unknown>)) keys.add(key);
  }
  return [...keys];
}

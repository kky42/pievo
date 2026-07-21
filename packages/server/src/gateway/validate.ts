/**
 * Content-field validators/normalizers for a loop's ui / stateSchema.
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
import type { StateField } from "../db/schema.js";

/** Normalize an optional provider-owned setting without validating its vocabulary.
 * Pievo deliberately treats model ids and reasoning efforts as opaque text; null or
 * blank delegates selection to the coding-agent CLI. */
export function normalizeProviderSetting(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const value = input.replaceAll("\0", "").trim();
  return value || null;
}

/** Sanitize/normalize dashboard HTML → the stored value (or null to clear). */
export function validateUi(html: string): { ok: true; value: string | null } {
  return { ok: true, value: store.coerceUi(html) ?? null };
}

/** Validate a state schema. Accepts a JSON string (run-token path) or an
 *  already-parsed value (an `editLoop` JSON patch may carry the array inline).
 *  Enforces the additive rule: keys still bound by the UI or reported by
 *  recent runs may not be dropped. */
export async function validateSchema(loopId: string, input: unknown): Promise<{ ok: true; value: StateField[] } | { ok: false; detail: string }> {
  if (!(await store.getLoop(loopId))) return { ok: false, detail: "loop not found" };
  let parsed: unknown = input;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input);
    } catch {
      return { ok: false, detail: 'schema must be JSON, e.g. [{"key":"mrr","label":"MRR","unit":"$"}]' };
    }
  }
  const schema = store.coerceStateSchema(parsed);
  if (!schema) return { ok: false, detail: "schema must be a non-empty array of {key, label?, unit?}" };
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
    for (const m of loop.ui.matchAll(/\{\{\s*(?:latest|state)\.([a-zA-Z0-9_-]+)[^}]*\}\}/g)) keys.add(m[1]!);
    for (const m of loop.ui.matchAll(/(?:series|key)=["']([^"']+)["']/g)) {
      for (const part of m[1]!.split(",")) {
        const key = part.trim().split(":")[0]?.trim();
        if (key) keys.add(key);
      }
    }
  }
  for (const run of await store.listRuns(loopId, 100)) {
    if (!run.state || typeof run.state !== "object") continue;
    for (const key of Object.keys(run.state as Record<string, unknown>)) keys.add(key);
  }
  return [...keys];
}

/**
 * Build the live data-binding context for a loop's generative-UI template and
 * resolve `{{ ... }}` scalar tokens against it. The template is static (authored
 * once on the Job); these bindings inject the CURRENT run data at render time.
 *
 * Supported tokens:
 *   {{latest.<key>}}            newest value of a state metric (number → fnum, string verbatim)
 *
 * The loop reports whatever it wants to surface as plain metrics each run (incl.
 * anything it computed itself — win-prob, lift, a verbal verdict); the template
 * just binds them by key. There is no domain-specific stats machinery here.
 */
import type { Json, RunSummary, StateField } from '../types'
import { fnum } from './format'

/** Parse a `<loop-chart series="key:label:unit, ...">` attribute into StateField[]. */
export function parseSeries(attr?: string): StateField[] {
  if (!attr) return []
  return attr
    .split(',')
    .map((s) => {
      const [key, label, unit] = s.split(':').map((x) => x.trim())
      return { key: key ?? '', ...(label ? { label } : {}), ...(unit ? { unit } : {}) }
    })
    .filter((f) => f.key)
}

export interface BindingContext {
  latest: Record<string, string>
}

export function buildBindingContext(runs: RunSummary[]): BindingContext {
  // `runs` is newest-first (detail order) — take the first occurrence of each key.
  const latest: Record<string, string> = {}
  for (const r of runs) {
    if (r.state && typeof r.state === 'object' && !Array.isArray(r.state)) {
      for (const k in r.state) {
        if (!(k in latest)) {
          const v = (r.state as Record<string, Json>)[k]
          if (typeof v === 'number') latest[k] = fnum(v)
          else if (typeof v === 'string') latest[k] = v
        }
      }
    }
  }
  return { latest }
}

const TOKEN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

/** Interpolate `{{...}}` tokens. Values are HTML-escaped (they are agent-controlled data). */
export function resolveBindings(html: string, ctx: BindingContext): string {
  return html.replace(TOKEN, (_m, path: string) => {
    const v = lookup(ctx, path)
    return v == null ? '—' : escapeHtml(v)
  })
}

function lookup(ctx: BindingContext, path: string): string | undefined {
  const parts = path.split('.')
  if (parts[0] === 'latest' && parts[1]) return ctx.latest[parts[1]]
  return undefined
}

import { useState } from 'react'
import { setLoopMemory } from '../server/loopApi'
import { MarkdownView } from './MarkdownView'
import { btn, btnPrimary, btnQuiet, ErrorBanner, inputCls, sectionHeadCls } from './ui'

/** Mirrors gateway/memory.ts MEMORY_CHAR_CAP; the server enforces it on save. */
const MEMORY_CHAR_CAP = 8000

/**
 * The loop's MEMORY.md: lessons its runs learned the hard way. A thin meter shows
 * how full it is; the owner can edit it in place.
 */
export function MemoryPanel({ loopId, memory, onSaved }: { loopId: string; memory: string; onSaved: () => Promise<void> }) {
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const chars = Array.from(draft ?? memory).length

  async function save() {
    if (draft == null) return
    setSaving(true)
    setError(null)
    try {
      const result = await setLoopMemory({ data: { id: loopId, memory: draft } })
      if (result.error) return setError(result.error)
      setDraft(null)
      await onSaved()
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="min-w-0">
      <div className="mb-2.5 flex items-center gap-3 border-b border-hairline pb-1.5">
        <h2 className={sectionHeadCls}>Memory</h2>
        <span
          className="h-1 w-16 overflow-hidden rounded-full bg-raised"
          title={`${chars} of ${MEMORY_CHAR_CAP} characters`}
          aria-label={`${chars} of ${MEMORY_CHAR_CAP} characters`}
        >
          <span
            className={`block h-full rounded-full ${chars > MEMORY_CHAR_CAP ? 'bg-rubik-red' : 'bg-secondary'}`}
            style={{ width: `${Math.min(100, (chars / MEMORY_CHAR_CAP) * 100)}%` }}
          />
        </span>
        {draft == null && <button type="button" className={`${btnQuiet} ml-auto`} onClick={() => setDraft(memory)}>Edit</button>}
      </div>
      <div className="rounded-card border border-hairline bg-surface shadow-card">
        {draft != null ? (
          <div className="p-4">
            <textarea
              className={`${inputCls} min-h-[260px] font-mono text-label`}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              aria-label="Memory"
            />
            {error && <ErrorBanner message={error} onDismiss={() => setError(null)} className="mt-2" />}
            <div className="mt-3 flex gap-2.5">
              <button type="button" className={btnPrimary} disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</button>
              <button type="button" className={btn} disabled={saving} onClick={() => { setDraft(null); setError(null) }}>Cancel</button>
            </div>
          </div>
        ) : memory.trim() ? (
          <div className="max-h-[420px] overflow-auto text-body"><MarkdownView content={memory} /></div>
        ) : (
          <div className="px-5 py-8 text-center text-body text-disabled">No lessons yet. Runs add one when they learn something the hard way.</div>
        )}
      </div>
    </section>
  )
}

import { forwardRef, useId, useImperativeHandle, useRef, useState } from 'react'
import type { CodingAgent, LoopPayload, LoopSchedule, StatusDefinitions } from '../types'
import { CODING_AGENTS, MAX_LOOP_TAGS } from '../types'
import { validateLoopTags } from '../lib/loopTags'
import { focusRing, inputCls, labelCls, sectionHeadCls, selectCls } from './ui'

export interface LoopFormHandle {
  read: () => LoopPayload | null
}

export interface LoopFormSeed {
  name?: string
  tags?: string[]
  schedule?: LoopSchedule
  workdir?: string
  agent?: CodingAgent
  model?: string | null
  reasoningEffort?: string | null
  prompt?: string
  statusDefinitions?: StatusDefinitions
  artifacts?: string[]
  enabled?: boolean
}

interface FormState {
  name: string
  tags: string[]
  tagDraft: string
  mode: 'cron' | 'continuous'
  cron: string
  timezone: string
  overlap: 'skip' | 'queue-one'
  delayMinutes: string
  workdir: string
  agent: CodingAgent
  model: string
  reasoningEffort: string
  prompt: string
  keep: string
  noChange: string
  block: string
  artifacts: string
}

const AGENT_LABEL: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', pi: 'Pi' }
const hintCls = 'mt-1 text-caption leading-snug text-disabled'

function initState(initial?: LoopFormSeed): FormState {
  const schedule = initial?.schedule
  return {
    name: initial?.name ?? '',
    tags: initial?.tags ?? [],
    tagDraft: '',
    mode: schedule?.mode ?? 'cron',
    cron: schedule?.mode === 'cron' ? schedule.cron : '0 */3 * * *',
    timezone: schedule?.mode === 'cron' ? schedule.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    overlap: schedule?.mode === 'cron' ? schedule.overlap : 'queue-one',
    delayMinutes: String(schedule?.mode === 'continuous' ? schedule.delayMinutes : 1),
    workdir: initial?.workdir ?? '',
    agent: initial?.agent ?? 'claude-code',
    model: initial?.model ?? '',
    reasoningEffort: initial?.reasoningEffort ?? '',
    prompt: initial?.prompt ?? '',
    keep: initial?.statusDefinitions?.keep ?? '',
    noChange: initial?.statusDefinitions?.noChange ?? '',
    block: initial?.statusDefinitions?.block ?? '',
    artifacts: (initial?.artifacts ?? []).join('\n'),
  }
}

function Section({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mb-3 mt-7 border-b border-hairline pb-1.5 first:mt-2">
      <h2 className={sectionHeadCls}>{title}</h2>
      {hint && <div className="mt-0.5 text-caption text-disabled">{hint}</div>}
    </div>
  )
}

function TextField({ label, value, onChange, mono, hint, placeholder }: { label: string; value: string; onChange: (value: string) => void; mono?: boolean; hint?: string; placeholder?: string }) {
  const id = useId()
  return (
    <div className="min-w-0">
      <label htmlFor={id} className={labelCls}>{label}</label>
      <input id={id} className={`${inputCls} ${mono ? 'font-mono' : ''}`} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
      {hint && <div className={hintCls}>{hint}</div>}
    </div>
  )
}

function TextArea({ label, value, onChange, rows = 4, mono, hint }: { label: string; value: string; onChange: (value: string) => void; rows?: number; mono?: boolean; hint?: string }) {
  const id = useId()
  return (
    <div className="min-w-0">
      <label htmlFor={id} className={labelCls}>{label}</label>
      <textarea id={id} rows={rows} className={`${inputCls} h-auto resize-y ${mono ? 'font-mono' : ''}`} value={value} onChange={(event) => onChange(event.target.value)} />
      {hint && <div className={hintCls}>{hint}</div>}
    </div>
  )
}

export const LoopForm = forwardRef<LoopFormHandle, { initial?: LoopFormSeed }>(function LoopForm({ initial }, ref) {
  const [form, setForm] = useState<FormState>(() => initState(initial))
  const [error, setError] = useState<string | null>(null)
  const [tagError, setTagError] = useState<string | null>(null)
  const tagsLabelId = useId()
  const tagsHintId = useId()
  const tagsErrorId = useId()
  const tagGroupRef = useRef<HTMLDivElement>(null)
  const tagInputRef = useRef<HTMLInputElement>(null)
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((current) => ({ ...current, [key]: value }))

  const commitTagDraft = () => {
    const additions = form.tagDraft.trim() ? [form.tagDraft] : []
    if (!additions.length) {
      set('tagDraft', '')
      return
    }
    const result = validateLoopTags([...form.tags, ...additions])
    if (!result.ok) {
      setTagError(result.detail)
      return
    }
    setForm((current) => ({ ...current, tags: result.value, tagDraft: '' }))
    setTagError(null)
    if (result.value.length === MAX_LOOP_TAGS) {
      requestAnimationFrame(() => {
        if (document.activeElement === document.body) tagGroupRef.current?.focus()
      })
    }
  }

  useImperativeHandle(ref, () => ({
    read(): LoopPayload | null {
      const required = [
        ['Name', form.name], ['Working directory', form.workdir], ['Prompt', form.prompt],
        ['Keep definition', form.keep], ['No-change definition', form.noChange], ['Block definition', form.block],
      ] as const
      const missing = required.find(([, value]) => !value.trim())
      if (missing) {
        setError(`${missing[0]} is required.`)
        return null
      }
      const tagResult = validateLoopTags([
        ...form.tags,
        ...(form.tagDraft.trim() ? [form.tagDraft] : []),
      ])
      if (!tagResult.ok) {
        setTagError(tagResult.detail)
        setError(null)
        return null
      }
      const delayMinutes = Number(form.delayMinutes)
      if (form.mode === 'continuous' && (!Number.isInteger(delayMinutes) || delayMinutes < 1)) {
        setError('Continuous delay must be an integer of at least 1 minute.')
        return null
      }
      const schedule: LoopSchedule = form.mode === 'cron'
        ? { mode: 'cron', cron: form.cron.trim(), timezone: form.timezone.trim(), overlap: form.overlap }
        : { mode: 'continuous', delayMinutes }
      setError(null)
      setTagError(null)
      return {
        name: form.name.trim(),
        tags: tagResult.value,
        schedule,
        workdir: form.workdir.trim(),
        agent: form.agent,
        model: form.model.trim() || null,
        reasoningEffort: form.reasoningEffort.trim() || null,
        prompt: form.prompt,
        statusDefinitions: { keep: form.keep, noChange: form.noChange, block: form.block },
        artifacts: form.artifacts.split(/\r?\n/).filter((path) => path.length > 0),
      }
    },
  }))

  return (
    <div className="grid gap-x-10 lg:grid-cols-[minmax(300px,380px)_minmax(0,1fr)]">
      <div className="min-w-0">
        <Section title="Basics" />
        <TextField label="Name" value={form.name} onChange={(value) => set('name', value)} />
        <div className="min-w-0">
          <div id={tagsLabelId} className={labelCls}>Tags</div>
          <div
            ref={tagGroupRef}
            role="group"
            tabIndex={-1}
            aria-labelledby={tagsLabelId}
            aria-describedby={`${tagsHintId}${tagError ? ` ${tagsErrorId}` : ''}`}
            aria-invalid={tagError ? 'true' : undefined}
            className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-control border border-wire bg-surface px-2.5 py-1.5 outline-none transition-shadow focus-within:border-transparent focus-within:shadow-focus"
          >
            {form.tags.map((tag) => (
              <span key={tag} className="inline-flex h-6 max-w-full items-center gap-1 rounded-full bg-raised px-2.5 text-caption font-medium text-secondary">
                <span className="max-w-52 truncate" title={tag}>{tag}</span>
                <button
                  type="button"
                  aria-label={`Remove tag ${tag}`}
                  onClick={() => {
                    set('tags', form.tags.filter((value) => value !== tag))
                    setTagError(null)
                    requestAnimationFrame(() => (tagInputRef.current ?? tagGroupRef.current)?.focus())
                  }}
                  className={`-mr-1 inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-disabled transition-colors hover:bg-surface hover:text-primary ${focusRing}`}
                >
                  <span aria-hidden>×</span>
                </button>
              </span>
            ))}
            {form.tags.length < MAX_LOOP_TAGS && (
              <input
                ref={tagInputRef}
                aria-label="Add tag"
                value={form.tagDraft}
                placeholder={form.tags.length ? 'Add another…' : 'Add a tag…'}
                onChange={(event) => {
                  set('tagDraft', event.target.value)
                  setTagError(null)
                }}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    commitTagDraft()
                  } else if (event.key === 'Backspace' && !form.tagDraft && form.tags.length) {
                    set('tags', form.tags.slice(0, -1))
                  }
                }}
                onBlur={commitTagDraft}
                className="h-6 min-w-28 flex-1 bg-transparent px-1 text-sm text-primary outline-none placeholder:text-disabled"
              />
            )}
          </div>
          <div id={tagsHintId} className={hintCls}>Up to {MAX_LOOP_TAGS}. Press Enter to add.</div>
          {tagError && <div id={tagsErrorId} role="alert" className="mt-1 text-caption text-accent">{tagError}</div>}
        </div>
        <div className="min-w-0">
          <label className={labelCls}>Schedule</label>
          <select aria-label="Schedule" className={selectCls} value={form.mode} onChange={(event) => set('mode', event.target.value as FormState['mode'])}>
            <option value="cron">Cron</option>
            <option value="continuous">Continuous</option>
          </select>
        </div>
        {form.mode === 'cron' ? (
          <>
            <TextField label="Cron expression" value={form.cron} onChange={(value) => set('cron', value)} mono />
            <TextField label="Timezone" value={form.timezone} onChange={(value) => set('timezone', value)} mono hint="IANA timezone, for example America/Los_Angeles." />
            <div className="min-w-0">
              <label className={labelCls}>Cron overlap</label>
              <select aria-label="Cron overlap" className={selectCls} value={form.overlap} onChange={(event) => set('overlap', event.target.value as FormState['overlap'])}>
                <option value="skip">Skip occurrence</option>
                <option value="queue-one">Queue one follow-up</option>
              </select>
              <div className={hintCls}>Applies only when a cron occurrence is due while a run is still open.</div>
            </div>
          </>
        ) : (
          <TextField label="Delay after terminal run (minutes)" value={form.delayMinutes} onChange={(value) => set('delayMinutes', value)} mono />
        )}

        <Section title="Execution" />
        <TextField label="Working directory" value={form.workdir} onChange={(value) => set('workdir', value)} mono placeholder="/Users/you/project" />
        <div className="min-w-0">
          <label className={labelCls}>Coding agent</label>
          <select aria-label="Coding agent" className={selectCls} value={form.agent} onChange={(event) => set('agent', event.target.value as CodingAgent)}>
            {CODING_AGENTS.map((agent) => <option key={agent} value={agent}>{AGENT_LABEL[agent] ?? agent}</option>)}
          </select>
        </div>
        <TextField label="Model" value={form.model} onChange={(value) => set('model', value)} placeholder="default" hint="Optional. Empty uses the agent default." />
        <TextField label="Reasoning effort" value={form.reasoningEffort} onChange={(value) => set('reasoningEffort', value)} placeholder="default" hint="Optional. Empty uses the agent default." />
      </div>

      <div className="min-w-0">
        <Section title="Prompt" hint="Sent unchanged before Pievo appends the report contract." />
        <TextArea label="User prompt" value={form.prompt} onChange={(value) => set('prompt', value)} rows={10} />
        <Section title="Status definitions" hint="All three definitions are required and are appended to every run." />
        <TextArea label="keep" value={form.keep} onChange={(value) => set('keep', value)} rows={2} />
        <TextArea label="no-change" value={form.noChange} onChange={(value) => set('noChange', value)} rows={2} />
        <TextArea label="block" value={form.block} onChange={(value) => set('block', value)} rows={2} />
        <Section title="Artifacts" hint="Optional exact paths relative to the working directory. One path per line; globs are not supported." />
        <TextArea label="Artifact paths" value={form.artifacts} onChange={(value) => set('artifacts', value)} rows={6} mono />
        {error && <div className="mt-4 text-body text-accent">{error}</div>}
      </div>
    </div>
  )
})

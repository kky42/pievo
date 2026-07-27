import { forwardRef, useId, useImperativeHandle, useState } from 'react'
import type { CodingAgent, LoopPayload, LoopSchedule, StatusDefinitions } from '../types'
import { CODING_AGENTS } from '../types'
import { inputCls, labelCls, sectionHeadCls, selectCls } from './ui'

export interface LoopFormHandle {
  read: () => LoopPayload | null
}

export interface LoopFormSeed {
  name?: string
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

const AGENT_LABEL: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex' }
const hintCls = 'mt-1 text-caption leading-snug text-disabled'

function initState(initial?: LoopFormSeed): FormState {
  const schedule = initial?.schedule
  return {
    name: initial?.name ?? '',
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
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((current) => ({ ...current, [key]: value }))

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
      const delayMinutes = Number(form.delayMinutes)
      if (form.mode === 'continuous' && (!Number.isInteger(delayMinutes) || delayMinutes < 1)) {
        setError('Continuous delay must be an integer of at least 1 minute.')
        return null
      }
      const schedule: LoopSchedule = form.mode === 'cron'
        ? { mode: 'cron', cron: form.cron.trim(), timezone: form.timezone.trim(), overlap: form.overlap }
        : { mode: 'continuous', delayMinutes }
      setError(null)
      return {
        name: form.name.trim(),
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

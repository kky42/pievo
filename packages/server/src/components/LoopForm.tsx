import { forwardRef, lazy, Suspense, useEffect, useId, useImperativeHandle, useState } from 'react'
import type { ChannelSummary, CodingAgent, ExecPayload, JobPayload, MetricField } from '../types'
import { CODING_AGENTS } from '../types'
import { listChannels } from '../server/notifyFns'
import { cronText } from '../lib/format'
import { inputCls, labelCls, sectionHeadCls, selectCls } from './ui'

/**
 * Build the exec slice of a manual form save.
 *
 * Always emits so model / reasoningEffort / allowControl ride with Save even
 * when workdir is empty. Empty strings
 * stay defined so patchJob can clear stored execution settings via `trim() || null` -
 * do not coerce cleared fields to `undefined` or gate the whole object on workdir.
 */
export function buildFormExec(f: {
  workdir: string
  model: string
  reasoningEffort: string
  allowControl: boolean
}): ExecPayload {
  return {
    executor: 'claude',
    workdir: f.workdir.trim(),
    model: f.model.trim(),
    reasoningEffort: f.reasoningEffort.trim(),
    allowControl: f.allowControl,
  }
}

// CodeMirror rides in its own lazy chunk (heavy) - the manual form is a
// rarely-entered mode, so the editors load on demand and stay out of the
// base client bundle (same discipline as the recharts-bearing LoopView).
const CodeField = lazy(() => import('./CodeField'))

export interface LoopFormHandle {
  /** Build the payload, or null if a field is invalid (the form shows the error inline). */
  read: () => JobPayload | null
}

/** Loose seed accepted by the form — a full job (edit) or a partial draft (create). */
export interface LoopFormSeed {
  name?: string
  cron?: string
  scheduleMode?: 'cron' | 'continuous'
  continuousDelayMinutes?: number
  taskFile?: string
  notify?: string
  channelId?: string | null
  metricSchema?: MetricField[]
  ui?: string
  agent?: CodingAgent
  exec?: { workdir?: string; model?: string; reasoningEffort?: string; allowControl?: boolean }
}

interface FormState {
  name: string
  cron: string
  scheduleMode: 'cron' | 'continuous'
  continuousDelayMinutes: string
  taskFile: string
  notify: string
  channelId: string
  metricSchema: string
  ui: string
  agent: CodingAgent
  workdir: string
  model: string
  reasoningEffort: string
  allowControl: boolean
}

function initState(initial?: LoopFormSeed): FormState {
  const e = initial?.exec
  return {
    name: initial?.name ?? '',
    cron: initial?.cron ?? '0 */3 * * *',
    scheduleMode: initial?.scheduleMode ?? 'cron',
    continuousDelayMinutes: String(initial?.continuousDelayMinutes ?? 1),
    taskFile: initial?.taskFile ?? '',
    notify: initial?.notify ?? 'auto',
    channelId: initial?.channelId ?? '',
    metricSchema: initial?.metricSchema ? JSON.stringify(initial.metricSchema) : '',
    ui: initial?.ui ?? '',
    agent: initial?.agent ?? 'claude-code',
    workdir: e?.workdir ?? '',
    model: e?.model ?? '',
    reasoningEffort: e?.reasoningEffort ?? '',
    allowControl: !!e?.allowControl,
  }
}

/** Quiet helper line under a field - guidance, not chrome. */
const hintCls = 'mt-1 text-caption leading-snug text-disabled'

/** Display labels for the known agents; an unknown/widened value falls back to its
 *  raw enum token so a newly-added agent still renders. */
const AGENT_LABEL: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex' }

// Module-level so identity is stable across renders (an inner component would
// remount on each keystroke and drop input focus).
function TextField({
  label,
  value,
  onChange,
  mono,
  ph,
  hint,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  mono?: boolean
  ph?: string
  hint?: string
}) {
  const id = useId()
  return (
    <div className="min-w-0">
      <label htmlFor={id} className={labelCls}>{label}</label>
      <input
        id={id}
        type="text"
        className={mono ? `${inputCls} font-mono` : inputCls}
        value={value}
        placeholder={ph}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <div className={hintCls}>{hint}</div>}
    </div>
  )
}

/** Section divider - same recipe as ModalSection, local so the form owns its rhythm. */
function Section({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mb-1 mt-7 border-b border-hairline pb-1.5">
      <h2 className={sectionHeadCls}>{title}</h2>
      {hint && <div className="mt-0.5 text-caption text-disabled">{hint}</div>}
    </div>
  )
}

/** Chunk-load placeholder that holds the editor's footprint (no layout jump). */
function EditorFallback({ minHeight }: { minHeight: string }) {
  return <div className="rounded-control border border-wire bg-raised" style={{ minHeight }} />
}

export const LoopForm = forwardRef<LoopFormHandle, { initial?: LoopFormSeed; channels?: ChannelSummary[] }>(
  function LoopForm({ initial, channels: channelsProp }, ref) {
    const [f, setF] = useState<FormState>(() => initState(initial))
    const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }))
    // Inline validation for the one client-parsed field (everything else is
    // validated server-side); shown under the field, never an alert().
    const [schemaErr, setSchemaErr] = useState<string | null>(null)
    // The parent (LoopDetailView) already holds the team's channel list — reuse it
    // when handed down, and only self-fetch when rendered standalone.
    const [fetched, setFetched] = useState<ChannelSummary[]>([])
    const channels = channelsProp ?? fetched
    useEffect(() => {
      if (channelsProp) return
      void listChannels()
        .then(setFetched)
        .catch(() => {})
    }, [channelsProp])

    useImperativeHandle(ref, () => ({
      read(): JobPayload | null {
        let metricSchema: MetricField[] | undefined
        const ss = f.metricSchema.trim()
        if (ss) {
          try {
            metricSchema = JSON.parse(ss)
          } catch {
            setSchemaErr('Not valid JSON - expected an array like [{"key":"mrr","label":"MRR","unit":"$"}]')
            return null
          }
        }
        return {
          name: f.name.trim(),
          cron: f.cron.trim(),
          scheduleMode: f.scheduleMode,
          continuousDelayMinutes: Math.max(1, Number.parseInt(f.continuousDelayMinutes, 10) || 1),
          taskFile: f.taskFile.trim(),
          notify: f.notify,
          channelId: f.channelId || null,
          ui: f.ui.trim() || undefined,
          agent: f.agent,
          exec: buildFormExec(f),
          metricSchema,
        }
      },
    }))

    // Two panes on lg: a narrow settings rail (the small fields) and a wide
    // content pane where the three code editors get the width they deserve.
    // `minmax(0,1fr)` + min-w-0 keep a long code line scrolling INSIDE its
    // editor, never widening the page. Collapses to one column below lg.
    return (
      <div className="grid gap-x-10 lg:grid-cols-[minmax(300px,380px)_minmax(0,1fr)]">
        {/* settings rail */}
        <div className="min-w-0">
          <Section title="Basics" />
          <TextField label="Name" value={f.name} onChange={(v) => set('name', v)} />
          <div className="min-w-0">
            <label className={labelCls}>Schedule mode</label>
            <select
              aria-label="Schedule mode"
              className={selectCls}
              value={f.scheduleMode}
              onChange={(e) => set('scheduleMode', e.target.value as 'cron' | 'continuous')}
            >
              <option value="cron">Cron</option>
              <option value="continuous">Continuous</option>
            </select>
            {f.scheduleMode === 'cron' ? (
              <div
                className={`${inputCls} flex cursor-default select-none items-center justify-between gap-2 bg-raised`}
                title={f.cron}
              >
                <span className="truncate text-primary">{cronText(f.cron)}</span>
                <span className="shrink-0 font-mono text-caption text-secondary">{f.cron}</span>
              </div>
            ) : (
              <TextField
                label="Delay after each exec (minutes)"
                value={f.continuousDelayMinutes}
                onChange={(v) => set('continuousDelayMinutes', v)}
                mono
                hint="At least 1 minute. Done and error continue; canceled runs do not."
              />
            )}
            <div className={hintCls}>Cron is retained while continuous mode is active, so switching back restores it.</div>
          </div>
          <TextField
            label="Task file"
            value={f.taskFile}
            onChange={(v) => set('taskFile', v)}
            mono
            hint="Path of the markdown file this loop tracks/maintains on the machine (optional)."
          />

          <Section title="Notifications" />
          <div className="min-w-0">
            <label className={labelCls}>Notify</label>
            <select aria-label="Notify" className={selectCls} value={f.notify} onChange={(e) => set('notify', e.target.value)}>
              {['auto', 'always', 'never'].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
            <div className={hintCls}>auto pushes only when a run found something; never silences everything.</div>
          </div>
          <div className="min-w-0">
            <label className={labelCls}>Push channel</label>
            <select aria-label="Push channel" className={selectCls} value={f.channelId} onChange={(e) => set('channelId', e.target.value)}>
              <option value="">none (dashboard only)</option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <Section title="Execution" hint="Which coding agent on the machine runs this loop." />
          <div className="min-w-0">
            <label className={labelCls}>Coding agent</label>
            <select aria-label="Coding agent" className={selectCls} value={f.agent} onChange={(e) => set('agent', e.target.value as CodingAgent)}>
              {CODING_AGENTS.map((a) => (
                <option key={a} value={a}>
                  {AGENT_LABEL[a] ?? a}
                </option>
              ))}
            </select>
            <div className={hintCls}>Which coding agent executes this loop on the bound machine.</div>
          </div>
          <TextField
            label="Working directory"
            value={f.workdir}
            onChange={(v) => set('workdir', v)}
            mono
            ph="/Users/you/Workspace/project"
            hint="Project root on the machine. Empty lets the daemon use a scratch directory."
          />
          <TextField
            label="Model"
            value={f.model}
            onChange={(v) => set('model', v)}
            ph="default"
            hint="Optional arbitrary model id. Empty uses the coding-agent CLI default."
          />
          <TextField
            label="Reasoning effort"
            value={f.reasoningEffort}
            onChange={(v) => set('reasoningEffort', v)}
            ph="default"
            hint="Optional arbitrary effort value. Empty uses the coding-agent CLI default."
          />
          <label className="mt-4 flex cursor-pointer items-center gap-2 text-body text-primary">
            <input
              type="checkbox"
              className="accent-[color:var(--color-display)]"
              checked={f.allowControl}
              onChange={(e) => set('allowControl', e.target.checked)}
            />
            Allow self-rescheduling
          </label>
        </div>

        {/* content pane - the agent-authored artifacts, in real editors */}
        <div className="min-w-0">
          <Section
            title="Agent-authored content"
            hint="Metrics and dashboard - usually written by evolve passes; edit by hand here when you know exactly what you want."
          />

          <label className={labelCls}>Metrics schema · JSON array</label>
          <Suspense fallback={<EditorFallback minHeight="90px" />}>
            <CodeField
              lang="json"
              value={f.metricSchema}
              onChange={(v) => {
                set('metricSchema', v)
                setSchemaErr(null)
              }}
              minHeight="90px"
              invalid={!!schemaErr}
              placeholder='[{"key":"mrr","label":"MRR","unit":"$"},{"key":"paid"}]'
            />
          </Suspense>
          {schemaErr ? (
            <div className="mt-1 text-caption leading-snug text-accent">{schemaErr}</div>
          ) : (
            <div className={hintCls}>Per-run metrics the agent reports; they feed the dashboard charts.</div>
          )}

          <label className={labelCls}>Dashboard template · HTML</label>
          <Suspense fallback={<EditorFallback minHeight="240px" />}>
            <CodeField
              lang="html"
              value={f.ui}
              onChange={(v) => set('ui', v)}
              minHeight="240px"
              placeholder={'<h3>{{latest.mrr}}$</h3>\n<loop-chart series="mrr:MRR:$"></loop-chart>'}
            />
          </Suspense>
          <div className={hintCls}>
            Agent-authored HTML with {'{{bindings}}'} and loop-chart / loop-embed / loop-calendar / loop-kanban elements.
          </div>
        </div>
      </div>
    )
  },
)

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildFormExec } from './LoopForm'

const formSrc = readFileSync(fileURLToPath(new URL('./LoopForm.tsx', import.meta.url)), 'utf8')

/**
 * Manual Edit → Model used to no-op when workdir was empty: read() only built
 * `exec` when workdir was non-empty, and patchJob only writes model via
 * `p.exec?.model`. Clearing model was also broken (empty coerced to undefined).
 */
describe('LoopForm.read exec wiring', () => {
  it('always builds exec via buildFormExec (not gated on workdir)', () => {
    // The old bug: `const exec = f.workdir.trim() ? { ... model } : undefined`
    expect(formSrc).not.toMatch(/const exec = f\.workdir\.trim\(\)\s*\?/)
    expect(formSrc).toMatch(/exec:\s*buildFormExec\(f\)/)
    // Cleared execution settings must stay defined strings, never `|| undefined`.
    const helper = formSrc.slice(formSrc.indexOf('export function buildFormExec'))
    const body = helper.slice(0, helper.indexOf('export interface') > 0 ? helper.indexOf('export interface') : 500)
    expect(body).not.toMatch(/model:.*\|\|\s*undefined/)
    expect(body).not.toMatch(/reasoningEffort:.*\|\|\s*undefined/)
    expect(formSrc).toContain('label="Reasoning effort"')
    expect(formSrc).toContain('ph="default"')
  })
})

describe('buildFormExec (manual form save payload)', () => {
  it('emits model and reasoning effort when workdir is empty so execution edits still patch', () => {
    const exec = buildFormExec({
      workdir: '',
      model: 'claude-opus-4-20250514',
      reasoningEffort: 'high',
      allowControl: true,
    })
    expect(exec).toEqual({
      executor: 'claude',
      workdir: '',
      model: 'claude-opus-4-20250514',
      reasoningEffort: 'high',
      allowControl: true,
    })
    expect(exec.model).toBeDefined()
    expect(exec.reasoningEffort).toBeDefined()
  })

  it('emits defined empty strings so clearing model and reasoning effort is patchable', () => {
    const exec = buildFormExec({
      workdir: '/tmp/proj',
      model: '   ',
      reasoningEffort: '   ',
      allowControl: false,
    })
    expect(exec.model).toBe('')
    expect(exec.model).toBeDefined()
    expect(exec.reasoningEffort).toBe('')
    expect(exec.reasoningEffort).toBeDefined()
    expect(exec.workdir).toBe('/tmp/proj')
    expect(exec.allowControl).toBe(false)
  })

  it('trims workdir, model, and reasoning effort but never drops the exec object', () => {
    const exec = buildFormExec({
      workdir: '  /home/me/app  ',
      model: '  sonnet  ',
      reasoningEffort: '  custom-max  ',
      allowControl: true,
    })
    expect(exec.workdir).toBe('/home/me/app')
    expect(exec.model).toBe('sonnet')
    expect(exec.reasoningEffort).toBe('custom-max')
    expect(exec.executor).toBe('claude')
  })

  it('still carries allowControl with empty workdir and default execution settings', () => {
    const exec = buildFormExec({ workdir: '', model: '', reasoningEffort: '', allowControl: false })
    expect(exec).toEqual({
      executor: 'claude',
      workdir: '',
      model: '',
      reasoningEffort: '',
      allowControl: false,
    })
  })
})

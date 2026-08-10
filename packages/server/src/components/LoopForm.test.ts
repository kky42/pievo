// @vitest-environment jsdom
import { act, createElement, createRef, type RefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test } from 'vitest'
import type { LoopPayload } from '../types'
import { LoopForm, type LoopFormHandle } from './LoopForm'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement | null = null
let root: Root | null = null

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  host = null
  root = null
})

async function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function readForm(ref: RefObject<LoopFormHandle | null>): Promise<LoopPayload | null> {
  let value: LoopPayload | null = null
  await act(async () => { value = ref.current!.read() })
  return value as LoopPayload | null
}

async function mountForm(tags: string[]) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const ref = createRef<LoopFormHandle>()
  await act(async () => {
    root!.render(createElement(LoopForm, {
      ref,
      initial: {
        name: 'Tagged loop',
        tags,
        schedule: { mode: 'cron', cron: '0 6 * * *', timezone: 'UTC', overlap: 'skip' },
        workdir: '/tmp/project',
        agent: 'claude-code',
        prompt: 'Do the work.',
        statusDefinitions: { keep: 'done', noChange: 'none', block: 'blocked' },
        artifacts: [],
      },
    }))
  })
  return ref
}

test('edits a normalized set of at most four loop tags', async () => {
  const ref = await mountForm(['daily'])
  const page = host!

  const group = page.querySelector<HTMLDivElement>('[role="group"][aria-labelledby]')!
  expect(group.getAttribute('aria-describedby')).toBeTruthy()
  const add = page.querySelector<HTMLInputElement>('input[aria-label="Add tag"]')!
  await setInput(add, '中文')
  await act(async () => { add.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true })) })
  expect(page.querySelector('button[aria-label="Remove tag 中文"]')).toBeNull()
  expect(add.value).toBe('中文')

  await setInput(add, ' Project ')
  await act(async () => { add.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  expect((await readForm(ref))?.tags).toEqual(['daily', 'project'])
  expect(page.textContent).toContain('project')

  await act(async () => {
    page.querySelector<HTMLButtonElement>('button[aria-label="Remove tag daily"]')!.click()
  })
  expect((await readForm(ref))?.tags).toEqual(['project'])

  const next = page.querySelector<HTMLInputElement>('input[aria-label="Add tag"]')!
  await setInput(next, 'active')
  await act(async () => { next.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  expect(page.querySelector('[role="alert"]')?.textContent).toBe('reserved tag: active')
  expect(group.getAttribute('aria-invalid')).toBe('true')
  expect(await readForm(ref)).toBeNull()
})

test('commits a fourth tag on blur without stealing focus from the next field', async () => {
  const ref = await mountForm(['alpha', 'beta', 'gamma'])
  const add = host!.querySelector<HTMLInputElement>('input[aria-label="Add tag"]')!
  const schedule = host!.querySelector<HTMLSelectElement>('select[aria-label="Schedule"]')!
  await act(async () => { add.focus() })
  await setInput(add, 'Fourth')
  await act(async () => {
    schedule.focus()
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })

  expect(document.activeElement).toBe(schedule)
  expect(host!.querySelector('input[aria-label="Add tag"]')).toBeNull()
  expect((await readForm(ref))?.tags).toEqual(['alpha', 'beta', 'fourth', 'gamma'])
})

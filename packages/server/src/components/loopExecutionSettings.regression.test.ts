import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const cardSrc = readFileSync(fileURLToPath(new URL('./LoopCard.tsx', import.meta.url)), 'utf8')
const detailSrc = readFileSync(fileURLToPath(new URL('./LoopDetailView.tsx', import.meta.url)), 'utf8')
const formSrc = readFileSync(fileURLToPath(new URL('./LoopForm.tsx', import.meta.url)), 'utf8')

describe('model and reasoning-effort dashboard surfaces', () => {
  it('shows both settings on dashboard cards and the loop detail header, including CLI defaults', () => {
    expect(cardSrc).toContain("Model: {job.model || 'default'}")
    expect(cardSrc).toContain("Reasoning: {job.reasoningEffort || 'default'}")
    expect(detailSrc).toContain("const modelLabel = job.exec?.model?.trim() || 'default'")
    expect(detailSrc).toContain("const reasoningEffortLabel = job.exec?.reasoningEffort?.trim() || 'default'")
    expect(detailSrc).toContain('Model: {modelLabel}')
    expect(detailSrc).toContain('Reasoning: {reasoningEffortLabel}')
  })

  it('offers arbitrary-text fields whose empty state is labeled default', () => {
    expect(formSrc).toContain('label="Model"')
    expect(formSrc).toContain('label="Reasoning effort"')
    expect(formSrc.match(/ph="default"/g)).toHaveLength(2)
    expect(formSrc).toContain("set('reasoningEffort', v)")
  })
})

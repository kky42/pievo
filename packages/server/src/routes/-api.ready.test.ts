import { describe, expect, test, vi } from 'vitest'

import { readyResponse } from './api.ready'

describe('/api/ready', () => {
  test('waits for full server boot and returns the process launch nonce', async () => {
    let finishBoot!: () => void
    const boot = new Promise<void>((resolve) => { finishBoot = resolve })
    const ensure = vi.fn(() => boot) as any
    let settled = false

    const responsePromise = readyResponse(ensure, { PIEVO_SERVER_LAUNCH_NONCE: 'launch-123' })
      .then((response) => {
        settled = true
        return response
      })
    await Promise.resolve()

    expect(ensure).toHaveBeenCalledOnce()
    expect(settled).toBe(false)

    finishBoot()
    const response = await responsePromise
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, nonce: 'launch-123' })
  })

  test('uses a null nonce outside the managed launcher', async () => {
    const response = await readyResponse(vi.fn(async () => undefined) as any, {})
    expect(await response.json()).toEqual({ ok: true, nonce: null })
  })
})

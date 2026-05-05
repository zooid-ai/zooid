import { describe, expect, it, vi } from 'vitest'
import { buildShutdown } from './dev-cascade.js'

describe('buildShutdown', () => {
  it('stops in order: ui → daemon → tuwunel and is idempotent', async () => {
    const calls: string[] = []
    const stopUi = vi.fn(async () => {
      calls.push('ui')
    })
    const stopDaemon = vi.fn(async () => {
      calls.push('daemon')
    })
    const stopTuwunel = vi.fn(async () => {
      calls.push('tuwunel')
    })

    const shutdown = buildShutdown({ stopUi, stopDaemon, stopTuwunel })
    await shutdown()
    expect(calls).toEqual(['ui', 'daemon', 'tuwunel'])

    await shutdown()
    expect(stopUi).toHaveBeenCalledTimes(1)
    expect(stopDaemon).toHaveBeenCalledTimes(1)
    expect(stopTuwunel).toHaveBeenCalledTimes(1)
  })

  it('continues stopping later layers even if an earlier one throws', async () => {
    const stopUi = vi.fn(async () => {
      throw new Error('ui boom')
    })
    const stopDaemon = vi.fn(async () => {})
    const stopTuwunel = vi.fn(async () => {})
    const shutdown = buildShutdown({ stopUi, stopDaemon, stopTuwunel })
    await shutdown()
    expect(stopDaemon).toHaveBeenCalled()
    expect(stopTuwunel).toHaveBeenCalled()
  })
})

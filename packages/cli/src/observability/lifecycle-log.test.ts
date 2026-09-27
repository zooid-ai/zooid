import { describe, expect, it, vi } from 'vitest'
import type { SessionLifecycleEvent } from '@zooid/core'
import { formatLifecycleLine, logLifecycle } from './lifecycle-log.js'

const base = { agentId: 'architect', sessionKey: '$root', sessionId: 's-1' }

function sink() {
  return { log: vi.fn(), error: vi.fn() }
}

describe('lifecycle log', () => {
  it('formats closes with reason and outcome', () => {
    expect(formatLifecycleLine('architect', { ...base, reason: 'idle', outcome: 'closed' })).toBe(
      '[lifecycle] architect key=$root session=s-1 idle → closed',
    )
    expect(formatLifecycleLine('architect', { ...base, reason: 'clear', outcome: 'closed' })).toBe(
      '[lifecycle] architect key=$root session=s-1 clear → closed',
    )
  })

  it('formats recoveries with their method', () => {
    expect(
      formatLifecycleLine('architect', { ...base, outcome: 'recovered', recoveryMethod: 'resume' }),
    ).toBe('[lifecycle] architect key=$root session=s-1 recovered (resume)')
  })

  it('skips cached hits, which fire on every prompt to a live session', () => {
    expect(
      formatLifecycleLine('architect', { ...base, outcome: 'recovered', recoveryMethod: 'cached' }),
    ).toBeNull()
  })

  it('routes failed closes to stderr and the rest to stdout', () => {
    const out = sink()
    logLifecycle('architect', { ...base, reason: 'idle', outcome: 'failed' }, out)
    logLifecycle('architect', { ...base, reason: 'idle', outcome: 'closed' }, out)
    expect(out.error).toHaveBeenCalledWith('[lifecycle] architect key=$root session=s-1 idle → failed')
    expect(out.log).toHaveBeenCalledTimes(1)
  })

  it('skips unsupported, which the ACP client already warns about', () => {
    const out = sink()
    const event: SessionLifecycleEvent = { ...base, reason: 'idle', outcome: 'unsupported' }
    logLifecycle('architect', event, out)
    expect(out.log).not.toHaveBeenCalled()
    expect(out.error).not.toHaveBeenCalled()
  })
})

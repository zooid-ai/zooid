import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { startTriggerScheduler } from '../src/daemon/trigger-scheduler.js'
import { loadZooidConfig } from '@zooid/core'

const yaml = `
runtime: local
transports:
  matrix:
    type: matrix
    homeserver: http://localhost:8448
    as_token: t
    hs_token: h
    user_namespace: '@.*:example.org'
agents:
  architect:
    acp: { preset: opencode }
    matrix:
      rooms: ["!ops:example.org"]
triggers:
  every-minute:
    schedule: "* * * * *"
    as: "@cron:example.org"
    room: "!ops:example.org"
    mention: architect
    text: "tick"
`

const scheduler = (over: Record<string, unknown> = {}) => {
  const sent: Array<Record<string, unknown>> = []
  const handle = startTriggerScheduler({
    triggers: loadZooidConfig(yaml).triggers,
    agentUserIds: { architect: '@architect:example.org' },
    resolveRoom: async (r: string) => r,
    ensureBot: async () => {},
    sendMessage: async (m: Record<string, unknown>) => {
      sent.push(m)
      return { event_id: '$1' }
    },
    ...over,
  })
  return { sent, handle }
}

describe('trigger scheduler', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('fires once per due tick and stops cleanly', async () => {
    const { sent, handle } = scheduler()

    await vi.advanceTimersByTimeAsync(61_000)
    expect(sent.length).toBe(1)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(sent.length).toBe(2)

    await handle.stop()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(sent.length).toBe(2)
  })

  it('a throwing trigger does not stop later firings', async () => {
    let calls = 0
    const { handle } = scheduler({
      sendMessage: async () => {
        calls++
        if (calls === 1) throw new Error('transient')
        return { event_id: '$1' }
      },
    })

    await vi.advanceTimersByTimeAsync(121_000)
    expect(calls).toBeGreaterThanOrEqual(2)
    await handle.stop()
  })

  it('starts nothing when there are no triggers', async () => {
    const handle = startTriggerScheduler({
      triggers: {},
      agentUserIds: {},
      resolveRoom: async (r: string) => r,
      ensureBot: async () => {},
      sendMessage: async () => {
        throw new Error('must not be called')
      },
    })
    await vi.advanceTimersByTimeAsync(300_000)
    await handle.stop()
  })
})

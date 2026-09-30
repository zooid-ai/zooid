import { describe, it, expect, vi } from 'vitest'
import { ElicitationCorrelator, type ElicitationResolution } from './elicitation-correlator.js'

const schema = { type: 'object' as const, properties: { env: { type: 'string' as const } } }

function reg(c: ElicitationCorrelator, over: Partial<Parameters<ElicitationCorrelator['register']>[0]> = {}) {
  const controller = new AbortController()
  const out = c.register({
    agentName: 'architect',
    sessionId: 's1',
    sessionKey: '$root',
    roomId: '!r',
    threadRoot: '$root',
    request: { sessionId: 's1', toolCallId: 'tc1', message: 'Which env?', requestedSchema: schema },
    signal: controller.signal,
    ...over,
  })
  return { ...out, controller }
}

describe('ElicitationCorrelator', () => {
  it('registers a pending record with a fresh Zooid request id', () => {
    const c = new ElicitationCorrelator()
    const a = reg(c)
    const b = reg(c)
    expect(a.record.requestId).not.toBe(b.record.requestId)
    expect(a.record).toMatchObject({
      agentName: 'architect', sessionId: 's1', sessionKey: '$root', roomId: '!r',
      threadRoot: '$root', toolCallId: 'tc1', message: 'Which env?', state: 'pending',
    })
    expect(c.countFor('$root')).toBe(2)
    expect(c.countForSession('s1')).toBe(2)
  })

  it('settle resolves only the addressed request and emits resolved once', async () => {
    const c = new ElicitationCorrelator()
    const resolved: ElicitationResolution[] = []
    c.on('resolved', (r) => resolved.push(r))
    const a = reg(c)
    const b = reg(c)
    expect(c.settle(a.record.requestId, { action: 'accept', content: { env: 'prod' } }, {
      respondedBy: '@alice:x', responseEventId: '$resp',
    })).toBe(true)
    await expect(a.response).resolves.toEqual({ action: 'accept', content: { env: 'prod' } })
    expect(c.get(b.record.requestId)?.state).toBe('pending')
    expect(resolved).toHaveLength(1)
    expect(resolved[0]).toMatchObject({
      status: 'accepted', respondedBy: '@alice:x', responseEventId: '$resp',
    })
    expect(c.countFor('$root')).toBe(1)
  })

  it('first settle wins; later settles and cancels are no-ops', async () => {
    const c = new ElicitationCorrelator()
    const a = reg(c)
    expect(c.settle(a.record.requestId, { action: 'decline' })).toBe(true)
    expect(c.settle(a.record.requestId, { action: 'accept', content: {} })).toBe(false)
    expect(c.cancel(a.record.requestId, 'interrupt')).toBe(false)
    await expect(a.response).resolves.toEqual({ action: 'decline' })
    expect(c.get(a.record.requestId)?.state).toBe('declined')
  })

  it('maps actions to terminal statuses', () => {
    const c = new ElicitationCorrelator()
    const statuses: string[] = []
    c.on('resolved', (r: ElicitationResolution) => statuses.push(r.status))
    c.settle(reg(c).record.requestId, { action: 'accept', content: {} })
    c.settle(reg(c).record.requestId, { action: 'decline' })
    c.settle(reg(c).record.requestId, { action: 'cancel' })
    expect(statuses).toEqual(['accepted', 'declined', 'cancelled'])
  })

  it('signal abort cancels with reason agent_cancelled', async () => {
    const c = new ElicitationCorrelator()
    const onResolved = vi.fn()
    c.on('resolved', onResolved)
    const a = reg(c)
    a.controller.abort()
    await expect(a.response).resolves.toEqual({ action: 'cancel' })
    expect(onResolved).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'cancelled', reason: 'agent_cancelled' }),
    )
  })

  it('an already-aborted signal cancels immediately', async () => {
    const c = new ElicitationCorrelator()
    const controller = new AbortController()
    controller.abort()
    const out = c.register({
      agentName: 'a', sessionId: 's', sessionKey: 'k', roomId: '!r', threadRoot: '$t',
      request: { sessionId: 's', message: 'm', requestedSchema: schema }, signal: controller.signal,
    })
    await expect(out.response).resolves.toEqual({ action: 'cancel' })
    expect(c.countForSession('s')).toBe(0)
  })

  it('cancelSession cancels every open request of that session only', async () => {
    const c = new ElicitationCorrelator()
    const a = reg(c)
    const b = reg(c)
    const other = reg(c, { sessionId: 's2', sessionKey: '$other' })
    expect(c.cancelSession('s1', 'interrupt')).toBe(2)
    await expect(a.response).resolves.toEqual({ action: 'cancel' })
    await expect(b.response).resolves.toEqual({ action: 'cancel' })
    expect(c.get(other.record.requestId)?.state).toBe('pending')
    expect(c.cancelSession('s1', 'interrupt')).toBe(0) // idempotent
  })

  it('cancelFor (PendingInputRegistry) cancels by session key', async () => {
    const c = new ElicitationCorrelator()
    const a = reg(c)
    c.cancelFor(['$root'])
    await expect(a.response).resolves.toEqual({ action: 'cancel' })
    expect(c.countFor('$root')).toBe(0)
  })

  it('fail rejects the promise without emitting resolved', async () => {
    const c = new ElicitationCorrelator()
    const onResolved = vi.fn()
    c.on('resolved', onResolved)
    const a = reg(c)
    expect(c.fail(a.record.requestId, new Error('publish failed'))).toBe(true)
    await expect(a.response).rejects.toThrow('publish failed')
    expect(onResolved).not.toHaveBeenCalled()
    expect(c.get(a.record.requestId)?.state).toBe('cancelled')
    expect(c.countFor('$root')).toBe(0)
  })

  it('attachRequestEvent records the published event id', () => {
    const c = new ElicitationCorrelator()
    const a = reg(c)
    c.attachRequestEvent(a.record.requestId, '$ereq')
    expect(c.get(a.record.requestId)?.requestEventId).toBe('$ereq')
  })

  it('get returns a copy, so callers cannot mutate state', () => {
    const c = new ElicitationCorrelator()
    const a = reg(c)
    const snap = c.get(a.record.requestId)!
    snap.state = 'accepted'
    expect(c.get(a.record.requestId)?.state).toBe('pending')
  })

  it('keeps terminal records for stale detection, bounded', () => {
    const c = new ElicitationCorrelator({ terminalCap: 2 })
    const ids = [reg(c), reg(c), reg(c)].map((x) => x.record.requestId)
    for (const id of ids) c.settle(id, { action: 'decline' })
    expect(c.get(ids[0]!)).toBeUndefined()
    expect(c.get(ids[2]!)?.state).toBe('declined')
  })
})

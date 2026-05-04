import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ApprovalCorrelator } from './approval-correlator.js'
import type { ApprovalRequest } from '@zooid/acp-client'

const req = (id: string): ApprovalRequest => ({
  sessionId: 's-1',
  toolCallId: id,
  options: [
    { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
  ],
})

describe('ApprovalCorrelator', () => {
  it('mints a unique approval_id per request', () => {
    const c = new ApprovalCorrelator()
    const a = c.register('agent', 's-1', req('tc-1'))
    const b = c.register('agent', 's-1', req('tc-2'))
    expect(a.approvalId).not.toBe(b.approvalId)
  })

  it('resolve() with a matching id resolves the request promise', async () => {
    const c = new ApprovalCorrelator()
    const handle = c.register('agent', 's-1', req('tc-1'))
    queueMicrotask(() =>
      c.resolve('s-1', handle.approvalId, { decision: 'allow', optionId: 'allow-once' }),
    )
    await expect(handle.decisionPromise).resolves.toEqual({
      decision: 'allow',
      optionId: 'allow-once',
    })
  })

  it('resolve() returns false for an unknown approval id', () => {
    const c = new ApprovalCorrelator()
    expect(c.resolve('s-x', 'made-up', { decision: 'cancel' })).toBe(false)
  })

  it('resolve() returns false when the session id does not match the approval', () => {
    const c = new ApprovalCorrelator()
    const handle = c.register('agent', 's-1', req('tc-1'))
    expect(c.resolve('s-other', handle.approvalId, { decision: 'cancel' })).toBe(false)
  })

  it('cancelSession() rejects all pending approvals for that session', async () => {
    const c = new ApprovalCorrelator()
    const a = c.register('agent', 's-1', req('tc-1'))
    const b = c.register('agent', 's-1', req('tc-2'))
    const c3 = c.register('agent', 's-2', req('tc-3'))

    c.cancelSession('s-1')
    await expect(a.decisionPromise).resolves.toEqual({ decision: 'cancel' })
    await expect(b.decisionPromise).resolves.toEqual({ decision: 'cancel' })
    expect(c.size()).toBe(1)
    // s-2 still pending
    const settled = await Promise.race([
      c3.decisionPromise,
      Promise.resolve('still-pending' as const),
    ])
    expect(settled).toBe('still-pending')
  })

  it('listPending() returns approval requests for a session for SSE replay on reconnect', () => {
    const c = new ApprovalCorrelator()
    const h = c.register('agent', 's-1', req('tc-1'))
    const list = c.listPending('s-1')
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      approvalId: h.approvalId,
      sessionId: 's-1',
      toolCallId: 'tc-1',
    })
  })

  describe('idle timeout', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('resolves with cancel after the configured wall-clock timeout', async () => {
      const c = new ApprovalCorrelator()
      const handle = c.register('agent', 's-1', req('tc-1'), { timeoutMs: 60_000 })
      vi.advanceTimersByTime(60_001)
      await expect(handle.decisionPromise).resolves.toEqual({ decision: 'cancel' })
    })

    it('emits a timeout signal so the transport can notify the client', async () => {
      const c = new ApprovalCorrelator()
      const onTimeout = vi.fn()
      c.on('timeout', onTimeout)
      const handle = c.register('agent', 's-1', req('tc-1'), { timeoutMs: 1000 })
      vi.advanceTimersByTime(1001)
      await handle.decisionPromise
      expect(onTimeout).toHaveBeenCalledWith(
        expect.objectContaining({ approvalId: handle.approvalId, sessionId: 's-1' }),
      )
    })

    it('resolve() before the timeout cancels the timer', async () => {
      const c = new ApprovalCorrelator()
      const handle = c.register('agent', 's-1', req('tc-1'), { timeoutMs: 60_000 })
      c.resolve('s-1', handle.approvalId, { decision: 'allow', optionId: 'allow-once' })
      vi.advanceTimersByTime(60_001)
      await expect(handle.decisionPromise).resolves.toEqual({
        decision: 'allow',
        optionId: 'allow-once',
      })
    })

    it('cancelSession() before the timeout cancels the timer', async () => {
      const c = new ApprovalCorrelator()
      const handle = c.register('agent', 's-1', req('tc-1'), { timeoutMs: 60_000 })
      c.cancelSession('s-1')
      vi.advanceTimersByTime(60_001)
      await expect(handle.decisionPromise).resolves.toEqual({ decision: 'cancel' })
      expect(c.size()).toBe(0)
    })

    it('timeoutMs: 0 disables the timeout (waits forever)', async () => {
      const c = new ApprovalCorrelator()
      const handle = c.register('agent', 's-1', req('tc-1'), { timeoutMs: 0 })
      vi.advanceTimersByTime(60 * 60 * 1000)
      const settled = await Promise.race([
        handle.decisionPromise,
        Promise.resolve('still-pending' as const),
      ])
      expect(settled).toBe('still-pending')
    })
  })
})

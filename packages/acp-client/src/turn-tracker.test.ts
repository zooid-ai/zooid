import { describe, expect, it, vi } from 'vitest'
import { TurnTracker, type TapEvent } from './turn-tracker.js'
import type { ErrorCode } from './errors.js'

describe('TurnTracker', () => {
  it('emits turn_started → session_update* → turn_completed in order', () => {
    const seen: TapEvent[] = []
    const t = new TurnTracker({
      agentId: 'docs',
      onTap: (e) => seen.push(e),
      newTurnId: () => 'turn_001',
    })
    const turnId = t.startTurn({ sessionId: 'sess_a', promptText: 'hi' })
    expect(turnId).toBe('turn_001')
    t.observeUpdate('sess_a', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hello' },
    } as never)
    t.endTurn({ sessionId: 'sess_a', stopReason: 'end_turn' })
    expect(seen.map((e) => e.kind)).toEqual([
      'turn_started',
      'session_update',
      'turn_completed',
    ])
    expect(seen[1].turnId).toBe('turn_001')
    expect(seen[2].kind === 'turn_completed' && seen[2].stopReason).toBe('end_turn')
  })

  it('tags concurrent sessions with their own turn ids', () => {
    const seen: TapEvent[] = []
    let n = 0
    const t = new TurnTracker({
      agentId: 'x',
      onTap: (e) => seen.push(e),
      newTurnId: () => `turn_${++n}`,
    })
    t.startTurn({ sessionId: 'a', promptText: 'p1' })
    t.startTurn({ sessionId: 'b', promptText: 'p2' })
    t.observeUpdate('a', { sessionUpdate: 'tool_call' } as never)
    t.observeUpdate('b', { sessionUpdate: 'tool_call' } as never)
    t.endTurn({ sessionId: 'a', stopReason: 'end_turn' })
    t.endTurn({ sessionId: 'b', stopReason: 'cancelled' })
    const updates = seen.filter((e) => e.kind === 'session_update')
    expect(updates).toHaveLength(2)
    expect(updates[0]).toMatchObject({ sessionId: 'a', turnId: 'turn_1' })
    expect(updates[1]).toMatchObject({ sessionId: 'b', turnId: 'turn_2' })
  })

  it('emits update with turnId=null if no turn is active for that session', () => {
    const seen: TapEvent[] = []
    const t = new TurnTracker({
      agentId: 'x',
      onTap: (e) => seen.push(e),
      newTurnId: () => 't',
    })
    t.observeUpdate('orphan', { sessionUpdate: 'agent_message_chunk' } as never)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      kind: 'session_update',
      sessionId: 'orphan',
      turnId: null,
    })
  })

  it('endTurn for an unknown session is a silent no-op (defensive)', () => {
    const onTap = vi.fn()
    const t = new TurnTracker({ agentId: 'x', onTap, newTurnId: () => 't' })
    expect(() => t.endTurn({ sessionId: 'nope', stopReason: 'end_turn' })).not.toThrow()
    expect(onTap).not.toHaveBeenCalled()
  })
})

describe('TapEvent error variant (ZOD055)', () => {
  it('is a discriminated union member with the expected fields', () => {
    const e: TapEvent = {
      kind: 'error',
      agentId: 'alice',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      code: 'auth_missing' as ErrorCode,
      message: 'Authentication required',
      detail: 'classified from RequestError',
      transient: false,
      acp_error: { code: -32000, message: 'Authentication required', data: undefined },
    }
    expect(e.kind).toBe('error')
  })

  it('sessionId and turnId may be null (failure preceded session/new)', () => {
    const e: TapEvent = {
      kind: 'error',
      agentId: 'alice',
      sessionId: null,
      turnId: null,
      code: 'container_exit' as ErrorCode,
      message: 'Agent container exited',
      transient: true,
    }
    expect(e.sessionId).toBeNull()
  })
})

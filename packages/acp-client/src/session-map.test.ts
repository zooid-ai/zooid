import { describe, it, expect, beforeEach } from 'vitest'
import { SessionMap, type SessionKey } from './session-map.js'

describe('SessionMap', () => {
  let map: SessionMap

  beforeEach(() => {
    map = new SessionMap()
  })

  const key = (threadId: string, agentId: string): SessionKey => ({ threadId, agentId })

  it('returns undefined for missing keys', () => {
    expect(map.get(key('t1', 'a1'))).toBeUndefined()
  })

  it('stores and retrieves sessions by (thread, agent) tuple', () => {
    const session = { sessionId: 's-1', startedAt: Date.now() }
    map.set(key('t1', 'a1'), session)
    expect(map.get(key('t1', 'a1'))).toEqual(session)
  })

  it('keeps sessions for different agents in the same thread separate', () => {
    map.set(key('t1', 'a1'), { sessionId: 's-1', startedAt: 0 })
    map.set(key('t1', 'a2'), { sessionId: 's-2', startedAt: 0 })
    expect(map.get(key('t1', 'a1'))?.sessionId).toBe('s-1')
    expect(map.get(key('t1', 'a2'))?.sessionId).toBe('s-2')
  })

  it('keeps sessions for the same agent in different threads separate', () => {
    map.set(key('t1', 'a1'), { sessionId: 's-1', startedAt: 0 })
    map.set(key('t2', 'a1'), { sessionId: 's-2', startedAt: 0 })
    expect(map.get(key('t1', 'a1'))?.sessionId).toBe('s-1')
    expect(map.get(key('t2', 'a1'))?.sessionId).toBe('s-2')
  })

  it('removes a session by key', () => {
    const k = key('t1', 'a1')
    map.set(k, { sessionId: 's-1', startedAt: 0 })
    map.delete(k)
    expect(map.get(k)).toBeUndefined()
  })

  it('lists all sessions for a given agent across threads', () => {
    map.set(key('t1', 'a1'), { sessionId: 's-1', startedAt: 0 })
    map.set(key('t2', 'a1'), { sessionId: 's-2', startedAt: 0 })
    map.set(key('t1', 'a2'), { sessionId: 's-3', startedAt: 0 })
    const ids = map
      .listForAgent('a1')
      .map((s) => s.sessionId)
      .sort()
    expect(ids).toEqual(['s-1', 's-2'])
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTypingRegistry, type TypingWire } from './typing-registry.js'

const ROOM = '!r:hs'
const ROOM2 = '!r2:hs'
const A = { name: 'architect', userId: '@architect:hs' }
const B = { name: 'coder', userId: '@coder:hs' }

type Call =
  | { kind: 'typing'; roomId: string; asUserId: string; typing: boolean; timeoutMs?: number }
  | { kind: 'presence'; asUserId: string; presence: string }

function fakeWire() {
  const calls: Call[] = []
  const wire: TypingWire & { calls: Call[] } = {
    calls,
    setTyping: vi.fn(async (i) => {
      calls.push({ kind: 'typing', ...i })
    }),
    setPresence: vi.fn(async (i) => {
      calls.push({ kind: 'presence', ...i })
    }),
  }
  return wire
}
const typing = (w: ReturnType<typeof fakeWire>, userId = A.userId, roomId = ROOM) =>
  w.calls.filter(
    (c): c is Extract<Call, { kind: 'typing' }> =>
      c.kind === 'typing' && c.asUserId === userId && c.roomId === roomId,
  )
const presence = (w: ReturnType<typeof fakeWire>, userId = A.userId) =>
  w.calls
    .filter((c): c is Extract<Call, { kind: 'presence' }> => c.kind === 'presence' && c.asUserId === userId)
    .map((c) => c.presence)

describe('typing registry', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('raises once on the first turn, with the 30s lease, and marks the agent unavailable', async () => {
    const w = fakeWire()
    const reg = createTypingRegistry({ wire: w })
    await reg.enter(ROOM, A, 's1')
    expect(typing(w)).toEqual([{ kind: 'typing', roomId: ROOM, asUserId: A.userId, typing: true, timeoutMs: 30_000 }])
    expect(presence(w)).toEqual(['unavailable'])
    expect(reg.isTyping(ROOM, A.userId)).toBe(true)
  })

  it('a second turn in the same room sends nothing', async () => {
    const w = fakeWire()
    const reg = createTypingRegistry({ wire: w })
    await reg.enter(ROOM, A, 's1')
    await reg.enter(ROOM, A, 's2')
    expect(typing(w)).toHaveLength(1)
    expect(presence(w)).toEqual(['unavailable'])
  })

  it('lowers only when the last turn leaves, without a timeout, and marks the agent online', async () => {
    const w = fakeWire()
    const reg = createTypingRegistry({ wire: w })
    await reg.enter(ROOM, A, 's1')
    await reg.enter(ROOM, A, 's2')
    await reg.exit(ROOM, A, 's1')
    expect(typing(w).map((c) => c.typing)).toEqual([true])
    await reg.exit(ROOM, A, 's2')
    expect(typing(w).map((c) => c.typing)).toEqual([true, false])
    expect(typing(w).at(-1)).not.toHaveProperty('timeoutMs')
    expect(presence(w)).toEqual(['unavailable', 'online'])
    expect(reg.isTyping(ROOM, A.userId)).toBe(false)
  })

  it('exit is idempotent and an unknown session is a no-op', async () => {
    const w = fakeWire()
    const reg = createTypingRegistry({ wire: w, warn: () => {} })
    await reg.exit(ROOM, A, 'never-entered')
    await reg.enter(ROOM, A, 's1')
    await reg.exit(ROOM, A, 's1')
    await reg.exit(ROOM, A, 's1')
    expect(typing(w).map((c) => c.typing)).toEqual([true, false])
  })

  it("a late release of an older session cannot clear a newer session's membership", async () => {
    const w = fakeWire()
    const reg = createTypingRegistry({ wire: w })
    await reg.enter(ROOM, A, 'old')
    await reg.exit(ROOM, A, 'old')
    await reg.enter(ROOM, A, 'new')
    await reg.exit(ROOM, A, 'old') // e.g. a cancel path settling late
    expect(reg.isTyping(ROOM, A.userId)).toBe(true)
    expect(typing(w).map((c) => c.typing)).toEqual([true, false, true])
  })

  it('refreshes once per (room, agent) every 25s, however many turns are in flight', async () => {
    const w = fakeWire()
    const reg = createTypingRegistry({ wire: w })
    await reg.enter(ROOM, A, 's1')
    await reg.enter(ROOM, A, 's2')
    await reg.enter(ROOM, A, 's3')
    await vi.advanceTimersByTimeAsync(25_000)
    expect(typing(w).map((c) => c.typing)).toEqual([true, true])
    await vi.advanceTimersByTimeAsync(25_000)
    expect(typing(w).map((c) => c.typing)).toEqual([true, true, true])
  })

  it('nothing a turn owns outlives it: no refresh after the last exit', async () => {
    const w = fakeWire()
    const reg = createTypingRegistry({ wire: w })
    await reg.enter(ROOM, A, 's1')
    await reg.exit(ROOM, A, 's1')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(typing(w).map((c) => c.typing)).toEqual([true, false])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never sends the lower before an in-flight raise has settled', async () => {
    const w = fakeWire()
    let releaseRefresh!: () => void
    let n = 0
    w.setTyping = vi.fn(async (i) => {
      n++
      if (n === 2) await new Promise<void>((r) => (releaseRefresh = r)) // the 25s refresh hangs
      w.calls.push({ kind: 'typing', ...i })
    })
    const reg = createTypingRegistry({ wire: w })
    await reg.enter(ROOM, A, 's1')
    await vi.advanceTimersByTimeAsync(25_000) // refresh PUT now in flight
    const lowered = reg.exit(ROOM, A, 's1')
    await vi.advanceTimersByTimeAsync(0)
    expect(w.setTyping).toHaveBeenCalledTimes(2) // the false is queued, not sent
    releaseRefresh()
    await lowered
    expect(typing(w).map((c) => c.typing)).toEqual([true, true, false])
  })

  it('pause lowers when it parks the only working turn; resume re-raises', async () => {
    const w = fakeWire()
    const reg = createTypingRegistry({ wire: w })
    await reg.enter(ROOM, A, 's1')
    await reg.pause(ROOM, A, 's1')
    expect(typing(w).map((c) => c.typing)).toEqual([true, false])
    expect(presence(w)).toEqual(['unavailable', 'online'])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(typing(w).map((c) => c.typing)).toEqual([true, false]) // no refresh while waiting
    await reg.resume(ROOM, A, 's1')
    expect(typing(w).map((c) => c.typing)).toEqual([true, false, true])
    expect(presence(w)).toEqual(['unavailable', 'online', 'unavailable'])
  })

  it('pause with a sibling turn working changes nothing on the wire', async () => {
    const w = fakeWire()
    const reg = createTypingRegistry({ wire: w })
    await reg.enter(ROOM, A, 's1')
    await reg.enter(ROOM, A, 's2')
    await reg.pause(ROOM, A, 's1')
    await reg.resume(ROOM, A, 's1')
    expect(typing(w)).toHaveLength(1)
    expect(presence(w)).toEqual(['unavailable'])
  })

  it('a resume that lands after the turn ended does not re-raise', async () => {
    const w = fakeWire()
    const reg = createTypingRegistry({ wire: w })
    await reg.enter(ROOM, A, 's1')
    await reg.pause(ROOM, A, 's1')
    await reg.exit(ROOM, A, 's1')
    await reg.resume(ROOM, A, 's1')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(typing(w).map((c) => c.typing)).toEqual([true, false])
    expect(reg.isTyping(ROOM, A.userId)).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('exit of a paused turn sends nothing more (already lowered)', async () => {
    const w = fakeWire()
    const reg = createTypingRegistry({ wire: w })
    await reg.enter(ROOM, A, 's1')
    await reg.pause(ROOM, A, 's1')
    await reg.exit(ROOM, A, 's1')
    expect(typing(w).map((c) => c.typing)).toEqual([true, false])
    expect(presence(w)).toEqual(['unavailable', 'online'])
  })

  it('agents in one room are independent', async () => {
    const w = fakeWire()
    const reg = createTypingRegistry({ wire: w })
    await reg.enter(ROOM, A, 'a1')
    await reg.enter(ROOM, B, 'b1')
    await reg.exit(ROOM, A, 'a1')
    expect(typing(w, A.userId).map((c) => c.typing)).toEqual([true, false])
    expect(typing(w, B.userId).map((c) => c.typing)).toEqual([true])
  })

  it('presence aggregates across rooms: unavailable while any room has a working turn', async () => {
    const w = fakeWire()
    const reg = createTypingRegistry({ wire: w })
    await reg.enter(ROOM, A, 's1')
    await reg.enter(ROOM2, A, 's2')
    await reg.exit(ROOM, A, 's1')
    expect(presence(w)).toEqual(['unavailable'])
    expect(typing(w, A.userId, ROOM).map((c) => c.typing)).toEqual([true, false])
    await reg.exit(ROOM2, A, 's2')
    expect(presence(w)).toEqual(['unavailable', 'online'])
  })

  it('a failed wire call is logged, not retried, and does not block later calls', async () => {
    const w = fakeWire()
    const warn = vi.fn()
    w.setTyping = vi
      .fn<TypingWire['setTyping']>()
      .mockRejectedValueOnce(new Error('502'))
      .mockImplementation(async (i) => {
        w.calls.push({ kind: 'typing', ...i })
      })
    const reg = createTypingRegistry({ wire: w, warn })
    await expect(reg.enter(ROOM, A, 's1')).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    await reg.exit(ROOM, A, 's1')
    expect(w.setTyping).toHaveBeenCalledTimes(2) // the failed raise was not retried
    expect(typing(w).map((c) => c.typing)).toEqual([false])
  })
})

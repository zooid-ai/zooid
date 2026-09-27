import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PendingReturns, type ReleasedReturn } from './pending-returns.js'

const GRACE = 90_000
const ROOT = '$root'
const ROOM = '!r:hs'
const agent = (name: string) => ({
  name,
  userId: `@${name}:hs`,
  rooms: [{ alias: ROOM }],
  trigger: 'mention' as const,
})
const A = agent('a')
const B = agent('b')
const C = agent('c')

function make() {
  const released: ReleasedReturn[] = []
  const returns = new PendingReturns({ graceMs: GRACE, onRelease: (r) => released.push(r) })
  // "callee→targets:text", one entry per release, in order.
  const summary = () =>
    released.map((r) => `${r.callee}→${r.targets.map((t) => t.name).join(',')}:${r.text}`)
  return { returns, summary }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('PendingReturns: the return is a turn boundary', () => {
  it('releases once at turn end, carrying the final non-empty prose', () => {
    const { returns, summary } = make()
    returns.open('b', ROOT, ROOM, A)
    returns.turnStarted('b', ROOT)
    returns.hold('b', ROOT, ROOM, [A], 'looking into it')
    returns.hold('b', ROOT, ROOM, [A], 'the answer is 42')
    returns.hold('b', ROOT, ROOM, [A], '   ')
    returns.turnFinished('b', ROOT)
    expect(summary()).toEqual([])
    returns.turnEnded('b', ROOT)
    expect(summary()).toEqual(['b→a:the answer is 42'])
  })

  it('a callee turn with no prose still releases, with an empty payload', () => {
    const { returns, summary } = make()
    returns.open('b', ROOT, ROOM, A)
    returns.turnStarted('b', ROOT)
    returns.turnFinished('b', ROOT)
    returns.turnEnded('b', ROOT)
    expect(summary()).toEqual(['b→a:'])
  })

  it('a replayed turn end does not release a second time', () => {
    const { returns, summary } = make()
    returns.open('b', ROOT, ROOM, A)
    returns.hold('b', ROOT, ROOM, [A], 'x')
    returns.turnEnded('b', ROOT)
    returns.turnEnded('b', ROOT)
    expect(summary()).toEqual(['b→a:x'])
  })

  it('keeps pending returns per (callee, thread)', () => {
    const { returns, summary } = make()
    returns.open('b', ROOT, ROOM, A)
    returns.open('b', '$other', ROOM, A)
    returns.hold('b', '$other', ROOM, [A], 'other thread')
    returns.turnEnded('b', '$other')
    expect(summary()).toEqual(['b→a:other thread'])
    expect(returns.has('b', ROOT)).toBe(true)
  })

  it('a new call replaces the pending return and drops its payload', () => {
    const { returns, summary } = make()
    returns.open('b', ROOT, ROOM, A)
    returns.hold('b', ROOT, ROOM, [A], 'answer to the first question')
    returns.open('b', ROOT, ROOM, A)
    returns.turnEnded('b', ROOT)
    expect(summary()).toEqual(['b→a:'])
  })
})

describe('PendingReturns: a turn that delegates is not a return', () => {
  it('A → B → C: holds B while it waits on C, then releases B once with its resolving turn', () => {
    const { returns, summary } = make()
    returns.open('b', ROOT, ROOM, A)
    // B's first turn ends by calling C.
    returns.turnStarted('b', ROOT)
    returns.hold('b', ROOT, ROOM, [A], '@c:hs please check this')
    returns.open('c', ROOT, ROOM, B)
    returns.markDelegated('b', ROOT)
    returns.turnFinished('b', ROOT)
    returns.turnEnded('b', ROOT)
    expect(summary()).toEqual([])
    // Waiting on a callee is never timed.
    vi.advanceTimersByTime(10 * GRACE)
    expect(summary()).toEqual([])
    // C's clean turn end returns to B.
    returns.turnStarted('c', ROOT)
    returns.hold('c', ROOT, ROOM, [B], 'checked, all good')
    returns.turnFinished('c', ROOT)
    returns.turnEnded('c', ROOT)
    expect(summary()).toEqual(['c→b:checked, all good'])
    // B's next turn calls nobody: A is woken once, with that turn's text.
    returns.turnStarted('b', ROOT)
    returns.hold('b', ROOT, ROOM, [A], 'done: C confirmed it')
    returns.turnFinished('b', ROOT)
    returns.turnEnded('b', ROOT)
    expect(summary()).toEqual(['c→b:checked, all good', 'b→a:done: C confirmed it'])
  })

  it("a silent resolving turn releases empty, not the delegating turn's text", () => {
    const { returns, summary } = make()
    returns.open('b', ROOT, ROOM, A)
    returns.hold('b', ROOT, ROOM, [A], '@c:hs please check this')
    returns.open('c', ROOT, ROOM, B)
    returns.markDelegated('b', ROOT)
    returns.turnEnded('b', ROOT)
    returns.turnStarted('b', ROOT)
    returns.turnFinished('b', ROOT)
    returns.turnEnded('b', ROOT)
    expect(summary()).toEqual(['b→a:'])
  })

  it('markDelegated is a no-op for an agent that owes no return', () => {
    const { returns } = make()
    returns.markDelegated('a', ROOT)
    expect(returns.has('a', ROOT)).toBe(false)
  })
})

describe('PendingReturns: the grace fallback is for a missing turn end', () => {
  it('never arms while the callee turn is running (long tool runs, approvals, human waits)', () => {
    const { returns, summary } = make()
    returns.open('b', ROOT, ROOM, A)
    returns.turnStarted('b', ROOT)
    returns.hold('b', ROOT, ROOM, [A], 'working')
    returns.activity('b', ROOT)
    vi.advanceTimersByTime(10 * GRACE)
    expect(summary()).toEqual([])
    returns.turnFinished('b', ROOT)
    returns.turnEnded('b', ROOT)
    expect(summary()).toEqual(['b→a:working'])
  })

  it('releases a hold with no turn behind it after the window', () => {
    const { returns, summary } = make()
    returns.hold('b', ROOT, ROOM, [A], 'posted by hand')
    vi.advanceTimersByTime(GRACE - 1)
    expect(summary()).toEqual([])
    vi.advanceTimersByTime(1)
    expect(summary()).toEqual(['b→a:posted by hand'])
  })

  it('re-arms the window on activity', () => {
    const { returns, summary } = make()
    returns.hold('b', ROOT, ROOM, [A], 'x')
    vi.advanceTimersByTime(GRACE - 1_000)
    returns.activity('b', ROOT)
    vi.advanceTimersByTime(GRACE - 1_000)
    expect(summary()).toEqual([])
    vi.advanceTimersByTime(1_000)
    expect(summary()).toEqual(['b→a:x'])
  })

  it('arms when the in-process turn finishes, so a lost turn.end still releases', () => {
    const { returns, summary } = make()
    returns.open('b', ROOT, ROOM, A)
    returns.turnStarted('b', ROOT)
    returns.hold('b', ROOT, ROOM, [A], 'x')
    returns.turnFinished('b', ROOT)
    vi.advanceTimersByTime(GRACE)
    expect(summary()).toEqual(['b→a:x'])
  })

  it('counts concurrent turns of one agent in one thread', () => {
    const { returns, summary } = make()
    returns.open('b', ROOT, ROOM, A)
    returns.turnStarted('b', ROOT)
    returns.turnStarted('b', ROOT)
    returns.hold('b', ROOT, ROOM, [A], 'x')
    returns.turnFinished('b', ROOT)
    vi.advanceTimersByTime(2 * GRACE)
    expect(summary()).toEqual([])
    returns.turnFinished('b', ROOT)
    vi.advanceTimersByTime(GRACE)
    expect(summary()).toEqual(['b→a:x'])
  })
})

describe('PendingReturns: interrupts and resets', () => {
  function bWaitingOnC(returns: PendingReturns) {
    returns.open('b', ROOT, ROOM, A)
    returns.hold('b', ROOT, ROOM, [A], '@c:hs please check this')
    returns.open('c', ROOT, ROOM, B)
    returns.markDelegated('b', ROOT)
    returns.turnEnded('b', ROOT)
  }

  it('an interrupt marks the running callee: its turn end releases even if it delegated', () => {
    const { returns, summary } = make()
    bWaitingOnC(returns)
    returns.turnStarted('c', ROOT)
    returns.interrupt(ROOT)
    // B stays pending; the chain unwinds through C's turn end.
    expect(summary()).toEqual([])
    returns.hold('c', ROOT, ROOM, [B], 'partial result')
    returns.markDelegated('c', ROOT)
    returns.turnFinished('c', ROOT)
    returns.turnEnded('c', ROOT)
    expect(summary()).toEqual(['c→b:partial result'])
  })

  it('an interrupt with nothing running releases every pending return in the thread', () => {
    const { returns, summary } = make()
    bWaitingOnC(returns)
    returns.open('b', '$elsewhere', ROOM, A)
    returns.interrupt(ROOT)
    expect(summary()).toEqual(['b→a:', 'c→b:'])
    expect(returns.has('b', '$elsewhere')).toBe(true)
  })

  it('dropThread clears holds without releasing them (/clear)', () => {
    const { returns, summary } = make()
    returns.hold('b', ROOT, ROOM, [A], 'x')
    returns.dropThread(ROOT)
    vi.advanceTimersByTime(2 * GRACE)
    returns.turnEnded('b', ROOT)
    expect(summary()).toEqual([])
    expect(returns.has('b', ROOT)).toBe(false)
  })
})

describe('remote holds ([[ZOD092]])', () => {
  const caller = { name: 'architect', userId: '@architect:hs', rooms: [], trigger: 'mention' as const }
  const make = () => {
    const released: string[] = []
    const r = new PendingReturns({
      graceMs: 90_000,
      remoteGraceMs: 30 * 60_000,
      onRelease: (x) => released.push(`${x.callee}:${x.text}`),
    })
    return { r, released }
  }
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }))
  afterEach(() => vi.useRealTimers())

  it('a remote callee past the local window is still held (its turn is invisible here)', () => {
    const { r, released } = make()
    r.open('@cloud.product:hs', '$root', '!r:hs', caller, { remote: true })
    r.hold('@cloud.product:hs', '$root', '!r:hs', [caller], 'running sleep 100', { remote: true })
    vi.advanceTimersByTime(5 * 90_000)
    expect(released).toEqual([])
    r.turnEnded('@cloud.product:hs', '$root')
    expect(released).toEqual(['@cloud.product:hs:running sleep 100'])
  })

  it('a remote callee whose daemon died releases after the remote window', () => {
    const { r, released } = make()
    r.open('@cloud.product:hs', '$root', '!r:hs', caller, { remote: true })
    r.hold('@cloud.product:hs', '$root', '!r:hs', [caller], 'partial', { remote: true })
    vi.advanceTimersByTime(30 * 60_000 - 1)
    expect(released).toEqual([])
    vi.advanceTimersByTime(1)
    expect(released).toEqual(['@cloud.product:hs:partial'])
  })

  it('local holds keep the local window', () => {
    const { r, released } = make()
    r.hold('@coding:hs', '$root', '!r:hs', [caller], 'late', {})
    vi.advanceTimersByTime(90_000)
    expect(released).toEqual(['@coding:hs:late'])
  })
})

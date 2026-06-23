import { describe, it, expect, vi } from 'vitest'
import { SyncLoop } from './sync-loop.js'

const evt = (id: string, roomId: string) => ({
  type: 'm.room.message',
  event_id: id,
  sender: '@me:zoon.eco',
  room_id: roomId,
  content: { msgtype: 'm.text', body: 'hi' },
})

function fakeClient(pages: unknown[]) {
  let i = 0
  return {
    sync: vi.fn(async () => pages[Math.min(i++, pages.length - 1)]),
  }
}

describe('SyncLoop', () => {
  it('dispatches each timeline event once and persists next_batch', async () => {
    const store = new Map<string, string>()
    const dispatched: string[] = []
    const client = fakeClient([
      { next_batch: 's1', rooms: { join: { '!r': { timeline: { events: [evt('a', '!r')] } } } } },
      { next_batch: 's2', rooms: { join: { '!r': { timeline: { events: [evt('b', '!r')] } } } } },
      { next_batch: 's2', rooms: { join: {} } },
    ])
    const loop = new SyncLoop({
      client: client as never,
      asUserId: '@laptop.docs:zoon.eco',
      loadSince: () => store.get('docs') ?? null,
      saveSince: (s) => store.set('docs', s),
      onEvent: (e) => dispatched.push(e.event_id as string),
    })
    await loop.tick()
    await loop.tick()
    expect(dispatched).toEqual(['a', 'b'])
    expect(store.get('docs')).toBe('s2')
  })

  it('resumes from the persisted since (no reprocessing across restart)', async () => {
    const store = new Map<string, string>([['docs', 's-persisted']])
    const client = fakeClient([{ next_batch: 's3', rooms: { join: {} } }])
    const loop = new SyncLoop({
      client: client as never,
      asUserId: '@laptop.docs:zoon.eco',
      loadSince: () => store.get('docs') ?? null,
      saveSince: (s) => store.set('docs', s),
      onEvent: () => {},
    })
    await loop.tick()
    expect((client.sync as ReturnType<typeof vi.fn>).mock.calls[0][0].since).toBe('s-persisted')
  })

  it('tolerates an idle sync with no `rooms` key (real homeservers omit it)', async () => {
    const store = new Map<string, string>()
    const dispatched: string[] = []
    // Real Tuwunel returns just { next_batch } on an idle incremental sync.
    const client = fakeClient([{ next_batch: 's-idle' }])
    const loop = new SyncLoop({
      client: client as never,
      asUserId: '@laptop.docs:zoon.eco',
      loadSince: () => store.get('docs') ?? null,
      saveSince: (s) => store.set('docs', s),
      onEvent: (e) => dispatched.push(e.event_id as string),
    })
    await expect(loop.tick()).resolves.toBeUndefined()
    expect(dispatched).toEqual([])
    expect(store.get('docs')).toBe('s-idle') // cursor still advances
  })

  it('tolerates a joined room with no `timeline` (state/ephemeral-only update)', async () => {
    const store = new Map<string, string>()
    const dispatched: string[] = []
    // A room can appear in rooms.join carrying only state — no timeline key.
    const client = fakeClient([
      { next_batch: 's-state', rooms: { join: { '!r': { state: { events: [] } } } } },
    ])
    const loop = new SyncLoop({
      client: client as never,
      asUserId: '@laptop.docs:zoon.eco',
      loadSince: () => store.get('docs') ?? null,
      saveSince: (s) => store.set('docs', s),
      onEvent: (e) => dispatched.push(e.event_id as string),
    })
    await expect(loop.tick()).resolves.toBeUndefined()
    expect(dispatched).toEqual([])
    expect(store.get('docs')).toBe('s-state')
  })

  it('run() survives a throwing tick and keeps going (no daemon crash)', async () => {
    let calls = 0
    let loop!: SyncLoop
    const client = {
      sync: vi.fn(async () => {
        calls++
        if (calls === 1) throw new Error('transient /sync 502')
        loop.stop() // recovered on the 2nd tick — end the loop deterministically
        return { next_batch: 's-ok' }
      }),
    }
    loop = new SyncLoop({
      client: client as never,
      asUserId: '@laptop.docs:zoon.eco',
      loadSince: () => null,
      saveSince: () => {},
      onEvent: () => {},
      retryDelayMs: 1,
    })
    await loop.run() // tick 1 throws → backoff → tick 2 recovers → stop → exits
    expect(calls).toBe(2)
  })
})

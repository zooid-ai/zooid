import { describe, it, expect } from 'vitest'
import { PendingMediaStore, MAX_MEDIA_PER_TURN } from './pending-media.js'

function item(over: Partial<{ eventId: string; sender: string; msgtype: string }> = {}) {
  return {
    eventId: over.eventId ?? '$m1',
    sender: over.sender ?? '@alice:localhost',
    msgtype: over.msgtype ?? 'm.image',
    body: 'dog.jpg',
    filename: 'dog.jpg',
    url: 'mxc://localhost/abc',
    info: { mimetype: 'image/jpeg', size: 1000 },
  }
}

describe('PendingMediaStore', () => {
  it('drains items for the same room+thread+sender and clears them', () => {
    const s = new PendingMediaStore()
    s.add('!r:hs', '$root', item({ eventId: '$m1' }))
    s.add('!r:hs', '$root', item({ eventId: '$m2' }))
    const drained = s.drain('!r:hs', '$root', '@alice:localhost')
    expect(drained.map((i) => i.eventId)).toEqual(['$m1', '$m2'])
    expect(s.drain('!r:hs', '$root', '@alice:localhost')).toEqual([])
  })

  it('does not leak across threads, rooms, or senders', () => {
    const s = new PendingMediaStore()
    s.add('!r:hs', '$rootA', item())
    expect(s.drain('!r:hs', '$rootB', '@alice:localhost')).toEqual([])
    expect(s.drain('!other:hs', '$rootA', '@alice:localhost')).toEqual([])
    expect(s.drain('!r:hs', '$rootA', '@bob:localhost')).toEqual([])
    // alice's item is still there after bob's miss
    expect(s.drain('!r:hs', '$rootA', '@alice:localhost')).toHaveLength(1)
  })

  it('caps the queue at MAX_MEDIA_PER_TURN, dropping oldest first', () => {
    const s = new PendingMediaStore()
    for (let i = 0; i < MAX_MEDIA_PER_TURN + 3; i++) {
      s.add('!r:hs', '$root', item({ eventId: `$m${i}` }))
    }
    const drained = s.drain('!r:hs', '$root', '@alice:localhost')
    expect(drained).toHaveLength(MAX_MEDIA_PER_TURN)
    expect(drained[0].eventId).toBe('$m3') // 0,1,2 dropped
  })

  it('uses a room-level key when the media event is unthreaded', () => {
    const s = new PendingMediaStore()
    s.add('!r:hs', undefined, item())
    expect(s.drain('!r:hs', undefined, '@alice:localhost')).toHaveLength(1)
  })
})

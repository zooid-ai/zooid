import { describe, it, expect } from 'vitest'
import { SpawnRegistry } from './spawn-registry.js'
import type { TransportContextProvider } from '@zooid/core'

const fakeProvider: TransportContextProvider = {
  getThreadHistory: async () => ({ messages: [], has_more: false }),
  getChannelMembers: async () => [],
  getChannelInfo: async () => ({ id: 'r', name: 'r', transport: 'matrix' }),
}

describe('SpawnRegistry', () => {
  it('register() returns a unique spawn-id', () => {
    const r = new SpawnRegistry()
    const a = r.register({
      agentName: 'architect',
      threadRef: { channelId: '!room:hs', threadId: '$root' },
      provider: fakeProvider,
    })
    const b = r.register({
      agentName: 'architect',
      threadRef: { channelId: '!room:hs', threadId: '$root' },
      provider: fakeProvider,
    })
    expect(a).not.toEqual(b)
    expect(a).toMatch(/^[a-f0-9-]{36}$/)
  })

  it('get() returns the binding stored under the spawn-id', () => {
    const r = new SpawnRegistry()
    const spawnId = r.register({
      agentName: 'architect',
      threadRef: { channelId: '!room:hs', threadId: '$root' },
      provider: fakeProvider,
    })
    const b = r.get(spawnId)
    expect(b?.agentName).toBe('architect')
    expect(b?.threadRef.channelId).toBe('!room:hs')
    expect(b?.provider).toBe(fakeProvider)
  })

  it('release() removes the binding', () => {
    const r = new SpawnRegistry()
    const spawnId = r.register({
      agentName: 'a',
      threadRef: { channelId: 'c', threadId: 't' },
      provider: fakeProvider,
    })
    r.release(spawnId)
    expect(r.get(spawnId)).toBeUndefined()
  })

  it('get() returns undefined for unknown spawn-ids', () => {
    const r = new SpawnRegistry()
    expect(r.get('not-a-real-id')).toBeUndefined()
  })
})

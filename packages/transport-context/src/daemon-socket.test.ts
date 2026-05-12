import { describe, it, expect, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { SpawnRegistry } from './spawn-registry.js'
import { startDaemonSocketServer, callDaemon } from './daemon-socket.js'
import type { TransportContextProvider } from '@zooid/core'

const fakeProvider: TransportContextProvider = {
  getThreadHistory: async () => ({
    messages: [
      { id: 'e1', sender: 'alice', text: 'hi', timestamp: '2026-05-11T00:00:00Z', is_agent: false },
    ],
    has_more: false,
  }),
  getChannelMembers: async () => [{ id: '@alice:hs', name: 'alice', is_agent: false }],
  getChannelInfo: async () => ({ id: '!r:hs', name: 'general', transport: 'matrix' }),
}

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanup) await fn()
  cleanup.length = 0
})

describe('daemon-socket', () => {
  it('routes a getThreadHistory call to the bound provider and returns the payload', async () => {
    const registry = new SpawnRegistry()
    const spawnId = registry.register({
      agentName: 'a',
      threadRef: { channelId: 'c', threadId: 't' },
      provider: fakeProvider,
    })
    const sockPath = join(tmpdir(), `zooid-test-${randomUUID()}.sock`)
    const server = await startDaemonSocketServer({ sockPath, registry })
    cleanup.push(() => server.close())

    const res = await callDaemon(sockPath, {
      spawnId,
      method: 'getThreadHistory',
      params: { limit: 50 },
    })

    expect(res).toEqual({
      messages: [
        { id: 'e1', sender: 'alice', text: 'hi', timestamp: '2026-05-11T00:00:00Z', is_agent: false },
      ],
      has_more: false,
    })
  })

  it('returns an error envelope for unknown spawn-ids', async () => {
    const registry = new SpawnRegistry()
    const sockPath = join(tmpdir(), `zooid-test-${randomUUID()}.sock`)
    const server = await startDaemonSocketServer({ sockPath, registry })
    cleanup.push(() => server.close())

    await expect(
      callDaemon(sockPath, { spawnId: 'unknown', method: 'getThreadHistory', params: {} }),
    ).rejects.toThrow(/unknown spawn/i)
  })

  it('routes getChannelMembers and getChannelInfo', async () => {
    const registry = new SpawnRegistry()
    const spawnId = registry.register({
      agentName: 'a',
      threadRef: { channelId: 'c', threadId: 't' },
      provider: fakeProvider,
    })
    const sockPath = join(tmpdir(), `zooid-test-${randomUUID()}.sock`)
    const server = await startDaemonSocketServer({ sockPath, registry })
    cleanup.push(() => server.close())

    const members = await callDaemon(sockPath, { spawnId, method: 'getChannelMembers', params: {} })
    expect(members).toEqual([{ id: '@alice:hs', name: 'alice', is_agent: false }])

    const info = await callDaemon(sockPath, { spawnId, method: 'getChannelInfo', params: {} })
    expect(info).toEqual({ id: '!r:hs', name: 'general', transport: 'matrix' })
  })

  it('serves two different spawns on one shared socket — each routed to its own provider', async () => {
    const providerA: TransportContextProvider = {
      getThreadHistory: async () => ({
        messages: [{ id: 'A1', sender: 'alice', text: 'from A', timestamp: 'T', is_agent: false }],
        has_more: false,
      }),
      getChannelMembers: async () => [{ id: '@a:hs', name: 'a', is_agent: false }],
      getChannelInfo: async () => ({ id: '!a:hs', name: 'room-A', transport: 'matrix' }),
    }
    const providerB: TransportContextProvider = {
      getThreadHistory: async () => ({
        messages: [{ id: 'B1', sender: 'bob', text: 'from B', timestamp: 'T', is_agent: false }],
        has_more: false,
      }),
      getChannelMembers: async () => [{ id: '@b:hs', name: 'b', is_agent: false }],
      getChannelInfo: async () => ({ id: '!b:hs', name: 'room-B', transport: 'matrix' }),
    }
    const registry = new SpawnRegistry()
    const spawnA = registry.register({
      agentName: 'architect',
      threadRef: { channelId: '!a:hs', threadId: '!a:hs' },
      provider: providerA,
    })
    const spawnB = registry.register({
      agentName: 'product-owner',
      threadRef: { channelId: '!b:hs', threadId: '!b:hs' },
      provider: providerB,
    })
    const sockPath = join(tmpdir(), `zooid-test-${randomUUID()}.sock`)
    const server = await startDaemonSocketServer({ sockPath, registry })
    cleanup.push(() => server.close())

    const [resA, resB] = await Promise.all([
      callDaemon(sockPath, { spawnId: spawnA, method: 'getThreadHistory', params: {} }),
      callDaemon(sockPath, { spawnId: spawnB, method: 'getThreadHistory', params: {} }),
    ])

    expect((resA as { messages: Array<{ id: string }> }).messages[0].id).toBe('A1')
    expect((resB as { messages: Array<{ id: string }> }).messages[0].id).toBe('B1')

    const infoB = await callDaemon(sockPath, { spawnId: spawnB, method: 'getChannelInfo', params: {} })
    expect((infoB as { id: string }).id).toBe('!b:hs')
  })

  it('handles many sequential calls from one client connection without leaking state', async () => {
    const providerA: TransportContextProvider = {
      getThreadHistory: async () => ({
        messages: [{ id: 'A', sender: 'a', text: 'a', timestamp: 'T', is_agent: false }],
        has_more: false,
      }),
      getChannelMembers: async () => [],
      getChannelInfo: async () => ({ id: 'a', name: 'a', transport: 'matrix' }),
    }
    const providerB: TransportContextProvider = {
      getThreadHistory: async () => ({
        messages: [{ id: 'B', sender: 'b', text: 'b', timestamp: 'T', is_agent: false }],
        has_more: false,
      }),
      getChannelMembers: async () => [],
      getChannelInfo: async () => ({ id: 'b', name: 'b', transport: 'matrix' }),
    }
    const registry = new SpawnRegistry()
    const spawnA = registry.register({
      agentName: 'a',
      threadRef: { channelId: 'a', threadId: 'a' },
      provider: providerA,
    })
    const spawnB = registry.register({
      agentName: 'b',
      threadRef: { channelId: 'b', threadId: 'b' },
      provider: providerB,
    })
    const sockPath = join(tmpdir(), `zooid-test-${randomUUID()}.sock`)
    const server = await startDaemonSocketServer({ sockPath, registry })
    cleanup.push(() => server.close())

    for (let i = 0; i < 20; i++) {
      const spawnId = i % 2 === 0 ? spawnA : spawnB
      const expected = i % 2 === 0 ? 'A' : 'B'
      const res = (await callDaemon(sockPath, {
        spawnId,
        method: 'getThreadHistory',
        params: {},
      })) as { messages: Array<{ id: string }> }
      expect(res.messages[0].id).toBe(expected)
    }
  })
})

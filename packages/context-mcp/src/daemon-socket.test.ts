import { describe, it, expect, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import { SpawnRegistry } from './spawn-registry.js'
import { startDaemonSocketServer, callDaemon } from './daemon-socket.js'
import type { TransportContextProvider } from '@zooid/core'

function fakeProvider(over: Partial<TransportContextProvider> = {}): TransportContextProvider {
  return {
    getRoomHistory: async () => ({ messages: [], has_more: false }),
    getRecentThreads: async () => ({ threads: [], has_more: false }),
    getThreadHistory: async () => ({ messages: [], has_more: false }),
    getChannelMembers: async () => [],
    getChannelInfo: async () => ({ id: 'r', name: 'r', transport: 'matrix' }),
    ...over,
  }
}

const defaultProvider = fakeProvider({
  getRoomHistory: async () => ({
    messages: [
      { id: 'e1', sender: 'alice', text: 'hi', timestamp: '2026-05-11T00:00:00Z', is_agent: false },
    ],
    has_more: false,
  }),
  getChannelMembers: async () => [{ id: '@alice:hs', name: 'alice', is_agent: false }],
  getChannelInfo: async () => ({ id: '!r:hs', name: 'general', transport: 'matrix' }),
})

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanup) await fn()
  cleanup.length = 0
})

describe('daemon-socket', () => {
  it('routes a getRoomHistory call to the bound provider and returns the payload', async () => {
    const registry = new SpawnRegistry()
    const spawnId = registry.register({
      agentName: 'a',
      threadRef: { channelId: 'c', threadId: 't' },
      provider: defaultProvider,
    })
    const sockPath = join(tmpdir(), `zooid-test-${randomUUID()}.sock`)
    const server = await startDaemonSocketServer({ sockPath, registry })
    cleanup.push(() => server.close())

    const res = await callDaemon(sockPath, {
      spawnId,
      method: 'getRoomHistory',
      params: { limit: 50 },
    })

    expect(res).toEqual({
      messages: [
        { id: 'e1', sender: 'alice', text: 'hi', timestamp: '2026-05-11T00:00:00Z', is_agent: false },
      ],
      has_more: false,
    })
  })

  it('routes getRecentThreads and getThreadHistory with thread metadata', async () => {
    const provider = fakeProvider({
      getRecentThreads: async () => ({
        threads: [
          {
            id: '$root',
            sender: 'alice',
            text: 'kickoff',
            timestamp: 'T',
            is_agent: false,
            reply_count: 2,
            last_activity_at: 'T2',
          },
        ],
        has_more: false,
      }),
      getThreadHistory: async (_c, threadId) => ({
        messages: [
          { id: threadId, sender: 'alice', text: 'root', timestamp: 'T', is_agent: false, thread_id: threadId },
        ],
        has_more: false,
      }),
    })
    const registry = new SpawnRegistry()
    const spawnId = registry.register({
      agentName: 'a',
      threadRef: { channelId: 'c', threadId: 't' },
      provider,
    })
    const sockPath = join(tmpdir(), `zooid-test-${randomUUID()}.sock`)
    const server = await startDaemonSocketServer({ sockPath, registry })
    cleanup.push(() => server.close())

    const overview = (await callDaemon(sockPath, {
      spawnId,
      method: 'getRecentThreads',
      params: {},
    })) as { threads: Array<{ id: string; reply_count: number }> }
    expect(overview.threads[0]).toMatchObject({ id: '$root', reply_count: 2 })

    const detail = (await callDaemon(sockPath, {
      spawnId,
      method: 'getThreadHistory',
      params: { threadId: '$root' },
    })) as { messages: Array<{ id: string; thread_id: string }> }
    expect(detail.messages[0]).toMatchObject({ id: '$root', thread_id: '$root' })
  })

  it('returns an error envelope for unknown spawn-ids', async () => {
    const registry = new SpawnRegistry()
    const sockPath = join(tmpdir(), `zooid-test-${randomUUID()}.sock`)
    const server = await startDaemonSocketServer({ sockPath, registry })
    cleanup.push(() => server.close())

    await expect(
      callDaemon(sockPath, { spawnId: 'unknown', method: 'getRoomHistory', params: {} }),
    ).rejects.toThrow(/unknown spawn/i)
  })

  it('routes getChannelMembers and getChannelInfo', async () => {
    const registry = new SpawnRegistry()
    const spawnId = registry.register({
      agentName: 'a',
      threadRef: { channelId: 'c', threadId: 't' },
      provider: defaultProvider,
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
    const providerA = fakeProvider({
      getRoomHistory: async () => ({
        messages: [{ id: 'A1', sender: 'alice', text: 'from A', timestamp: 'T', is_agent: false }],
        has_more: false,
      }),
      getChannelInfo: async () => ({ id: '!a:hs', name: 'room-A', transport: 'matrix' }),
    })
    const providerB = fakeProvider({
      getRoomHistory: async () => ({
        messages: [{ id: 'B1', sender: 'bob', text: 'from B', timestamp: 'T', is_agent: false }],
        has_more: false,
      }),
      getChannelInfo: async () => ({ id: '!b:hs', name: 'room-B', transport: 'matrix' }),
    })
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
      callDaemon(sockPath, { spawnId: spawnA, method: 'getRoomHistory', params: {} }),
      callDaemon(sockPath, { spawnId: spawnB, method: 'getRoomHistory', params: {} }),
    ])

    expect((resA as { messages: Array<{ id: string }> }).messages[0].id).toBe('A1')
    expect((resB as { messages: Array<{ id: string }> }).messages[0].id).toBe('B1')

    const infoB = await callDaemon(sockPath, { spawnId: spawnB, method: 'getChannelInfo', params: {} })
    expect((infoB as { id: string }).id).toBe('!b:hs')
  })

  it('handles many sequential calls from one client connection without leaking state', async () => {
    const providerA = fakeProvider({
      getRoomHistory: async () => ({
        messages: [{ id: 'A', sender: 'a', text: 'a', timestamp: 'T', is_agent: false }],
        has_more: false,
      }),
    })
    const providerB = fakeProvider({
      getRoomHistory: async () => ({
        messages: [{ id: 'B', sender: 'b', text: 'b', timestamp: 'T', is_agent: false }],
        has_more: false,
      }),
    })
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
        method: 'getRoomHistory',
        params: {},
      })) as { messages: Array<{ id: string }> }
      expect(res.messages[0].id).toBe(expected)
    }
  })
})

describe('close()', () => {
  it('does not hang on a connected client that never disconnects', async () => {
    // The context-mcp servers spawned beside each agent outlive
    // AcpClient.stop() (it SIGTERMs the agent and doesn't wait; these are its
    // grandchildren). net.Server.close() waits for every open connection and,
    // unlike http.Server, never drops idle ones — so before this was fixed,
    // `zooid dev` hung on shutdown for as long as those processes lived.
    const sockPath = join(tmpdir(), `zooid-close-${randomUUID()}.sock`)
    const registry = new SpawnRegistry()
    const handle = await startDaemonSocketServer({ sockPath, registry })

    const client = createConnection(sockPath)
    await new Promise<void>((resolve, reject) => {
      client.once('connect', () => resolve())
      client.once('error', reject)
    })

    const closed = await Promise.race([
      handle.close().then(() => 'closed' as const),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 2000)),
    ])
    client.destroy()
    expect(closed).toBe('closed')
  })
})

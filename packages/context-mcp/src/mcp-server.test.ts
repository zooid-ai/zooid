import { describe, it, expect } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildContextMcpServer } from './mcp-server.js'
import type { TransportContextProvider } from '@zooid/core'

function makeProvider(over: Partial<TransportContextProvider> = {}): TransportContextProvider {
  return {
    getRoomHistory: async () => ({ messages: [], has_more: false }),
    getRecentThreads: async () => ({ threads: [], has_more: false }),
    getThreadHistory: async () => ({ messages: [], has_more: false }),
    getChannelMembers: async () => [],
    getChannelInfo: async () => ({ id: 'r', name: 'r', transport: 'matrix' }),
    ...over,
  }
}

async function connect(server: ReturnType<typeof buildContextMcpServer>) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0.0.1' }, { capabilities: {} })
  await Promise.all([server.connect(serverT), client.connect(clientT)])
  return client
}

describe('buildContextMcpServer', () => {
  it('lists exactly five tools with the spec names', async () => {
    const server = buildContextMcpServer({ resolve: async () => makeProvider() })
    const client = await connect(server)
    const list = await client.listTools()
    expect(list.tools.map((t) => t.name).sort()).toEqual([
      'zooid_get_channel_info',
      'zooid_get_history',
      'zooid_get_members',
      'zooid_get_recent_threads',
      'zooid_get_thread_history',
    ])
  })

  it('zooid_get_history forwards limit + before and returns the page as text JSON', async () => {
    const calls: Array<{ limit?: number; before?: string }> = []
    const provider = makeProvider({
      getRoomHistory: async (_c, opts) => {
        calls.push(opts)
        return {
          messages: [
            { id: 'e1', sender: 'alice', text: 'hi', timestamp: 'T', is_agent: false },
          ],
          next_before: 'cursor-2',
          has_more: true,
        }
      },
    })
    const server = buildContextMcpServer({ resolve: async () => provider })
    const client = await connect(server)
    const res = await client.callTool({
      name: 'zooid_get_history',
      arguments: { limit: 10, before: 'cursor-1' },
    })
    expect(calls).toEqual([{ limit: 10, before: 'cursor-1' }])
    const text = (res.content as Array<{ type: string; text: string }>)[0].text
    expect(JSON.parse(text)).toEqual({
      messages: [{ id: 'e1', sender: 'alice', text: 'hi', timestamp: 'T', is_agent: false }],
      next_before: 'cursor-2',
      has_more: true,
    })
  })

  it('clamps limit to max 200', async () => {
    const calls: Array<{ limit?: number }> = []
    const provider = makeProvider({
      getRoomHistory: async (_c, opts) => {
        calls.push(opts)
        return { messages: [], has_more: false }
      },
    })
    const server = buildContextMcpServer({ resolve: async () => provider })
    const client = await connect(server)
    await client.callTool({ name: 'zooid_get_history', arguments: { limit: 5000 } })
    expect(calls[0].limit).toBe(200)
  })

  it('defaults limit to 50 when omitted', async () => {
    const calls: Array<{ limit?: number }> = []
    const provider = makeProvider({
      getRoomHistory: async (_c, opts) => {
        calls.push(opts)
        return { messages: [], has_more: false }
      },
    })
    const server = buildContextMcpServer({ resolve: async () => provider })
    const client = await connect(server)
    await client.callTool({ name: 'zooid_get_history', arguments: {} })
    expect(calls[0].limit).toBe(50)
  })

  it('zooid_get_recent_threads returns the provider payload', async () => {
    const provider = makeProvider({
      getRecentThreads: async () => ({
        threads: [
          {
            id: '$root',
            sender: 'alice',
            text: 'kickoff',
            timestamp: 'T',
            is_agent: false,
            reply_count: 4,
            last_activity_at: 'T2',
          },
        ],
        has_more: false,
      }),
    })
    const server = buildContextMcpServer({ resolve: async () => provider })
    const client = await connect(server)
    const res = await client.callTool({ name: 'zooid_get_recent_threads', arguments: {} })
    const payload = JSON.parse((res.content as Array<{ text: string }>)[0].text)
    expect(payload.threads[0]).toMatchObject({ id: '$root', reply_count: 4 })
  })

  it('zooid_get_thread_history forwards thread_id and limit/before', async () => {
    const calls: Array<{ threadId: string; opts: { limit?: number; before?: string } }> = []
    const provider = makeProvider({
      getThreadHistory: async (_c, threadId, opts) => {
        calls.push({ threadId, opts })
        return {
          messages: [
            { id: '$root', sender: 'alice', text: 'root', timestamp: 'T', is_agent: false },
          ],
          has_more: false,
        }
      },
    })
    const server = buildContextMcpServer({ resolve: async () => provider })
    const client = await connect(server)
    await client.callTool({
      name: 'zooid_get_thread_history',
      arguments: { thread_id: '$root', limit: 10 },
    })
    expect(calls[0]).toEqual({ threadId: '$root', opts: { limit: 10, before: undefined } })
  })

  it('zooid_get_thread_history surfaces a validation error when thread_id is missing', async () => {
    const server = buildContextMcpServer({ resolve: async () => makeProvider() })
    const client = await connect(server)
    const res = await client.callTool({ name: 'zooid_get_thread_history', arguments: {} })
    expect(res.isError).toBe(true)
  })

  it('zooid_get_members and zooid_get_channel_info return the provider payload', async () => {
    const provider = makeProvider({
      getChannelMembers: async () => [
        { id: '@alice:hs', name: 'alice', is_agent: false },
        { id: '@architect:hs', name: 'architect', is_agent: true, agent_name: 'architect' },
      ],
      getChannelInfo: async () => ({ id: '!r:hs', name: 'general', transport: 'matrix' }),
    })
    const server = buildContextMcpServer({ resolve: async () => provider })
    const client = await connect(server)

    const m = await client.callTool({ name: 'zooid_get_members', arguments: {} })
    expect(JSON.parse((m.content as Array<{ text: string }>)[0].text)).toEqual({
      members: [
        { id: '@alice:hs', name: 'alice', is_agent: false },
        { id: '@architect:hs', name: 'architect', is_agent: true, agent_name: 'architect' },
      ],
    })

    const i = await client.callTool({ name: 'zooid_get_channel_info', arguments: {} })
    expect(JSON.parse((i.content as Array<{ text: string }>)[0].text)).toEqual({
      id: '!r:hs',
      name: 'general',
      transport: 'matrix',
    })
  })

  it('returns isError when the resolver throws (e.g. orphaned spawn-id)', async () => {
    const server = buildContextMcpServer({
      resolve: async () => {
        throw new Error('unknown spawn')
      },
    })
    const client = await connect(server)
    const res = await client.callTool({ name: 'zooid_get_history', arguments: {} })
    expect(res.isError).toBe(true)
  })
})

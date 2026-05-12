import { describe, it, expect, vi } from 'vitest'
import { MatrixContextProvider } from './context-provider.js'
import type { MatrixClient } from './matrix-client.js'

function fakeClient(overrides: Partial<MatrixClient> = {}): MatrixClient {
  return {
    fetchRoomMessages: vi.fn(),
    getJoinedMembers: vi.fn(),
    fetchRoomName: vi.fn(),
    fetchEvent: vi.fn(),
    fetchThreadRelations: vi.fn(),
    ...overrides,
  } as unknown as MatrixClient
}

describe('MatrixContextProvider', () => {
  it('maps Matrix m.room.message events into Message[] oldest-first', async () => {
    const client = fakeClient({
      fetchRoomMessages: vi.fn().mockResolvedValue({
        chunk: [
          {
            event_id: '$e2',
            sender: '@bob:hs',
            origin_server_ts: 2000,
            type: 'm.room.message',
            content: { msgtype: 'm.text', body: 'second' },
          },
          {
            event_id: '$e1',
            sender: '@alice:hs',
            origin_server_ts: 1000,
            type: 'm.room.message',
            content: { msgtype: 'm.text', body: 'first' },
          },
        ],
        end: 'matrix-pagination-token',
      }),
    } as unknown as Partial<MatrixClient>)
    const provider = new MatrixContextProvider({
      client,
      asUserId: '@_zooid:hs',
      agentBots: new Map([['@architect:hs', 'architect']]),
    })

    const page = await provider.getRoomHistory('!room:hs', { limit: 50 })

    expect(page.messages.map((m) => m.id)).toEqual(['$e1', '$e2'])
    expect(page.messages[0].sender).toBe('@alice:hs')
    expect(page.messages[0].is_agent).toBe(false)
    expect(page.next_before).toBe('matrix-pagination-token')
    expect(page.has_more).toBe(true)
  })

  it('flags messages from registered agent bots as is_agent + agent_name', async () => {
    const client = fakeClient({
      fetchRoomMessages: vi.fn().mockResolvedValue({
        chunk: [
          {
            event_id: '$e1',
            sender: '@architect:hs',
            origin_server_ts: 1000,
            type: 'm.room.message',
            content: { msgtype: 'm.text', body: 'thinking...' },
          },
        ],
        end: undefined,
      }),
    } as unknown as Partial<MatrixClient>)
    const provider = new MatrixContextProvider({
      client,
      asUserId: '@_zooid:hs',
      agentBots: new Map([['@architect:hs', 'architect']]),
    })
    const page = await provider.getRoomHistory('!room:hs', {})
    expect(page.messages[0]).toMatchObject({
      sender: '@architect:hs',
      is_agent: true,
      agent_name: 'architect',
    })
    expect(page.has_more).toBe(false)
  })

  it('surfaces thread_id on messages that belong to a thread', async () => {
    const client = fakeClient({
      fetchRoomMessages: vi.fn().mockResolvedValue({
        chunk: [
          {
            event_id: '$reply',
            sender: '@alice:hs',
            origin_server_ts: 2000,
            type: 'm.room.message',
            content: {
              msgtype: 'm.text',
              body: 'in-thread reply',
              'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
            },
          },
          {
            event_id: '$top',
            sender: '@bob:hs',
            origin_server_ts: 1000,
            type: 'm.room.message',
            content: { msgtype: 'm.text', body: 'top-level' },
          },
        ],
        end: undefined,
      }),
    } as unknown as Partial<MatrixClient>)
    const provider = new MatrixContextProvider({
      client,
      asUserId: '@_zooid:hs',
      agentBots: new Map(),
    })
    const page = await provider.getRoomHistory('!room:hs', {})
    const byId = new Map(page.messages.map((m) => [m.id, m]))
    expect(byId.get('$reply')?.thread_id).toBe('$root')
    expect(byId.get('$top')?.thread_id).toBeUndefined()
  })

  it('passes channelId and pagination opts through to the matrix client without thread filtering', async () => {
    const fetchRoomMessages = vi.fn().mockResolvedValue({ chunk: [], end: undefined })
    const provider = new MatrixContextProvider({
      client: fakeClient({ fetchRoomMessages } as unknown as Partial<MatrixClient>),
      asUserId: '@_zooid:hs',
      agentBots: new Map(),
    })
    await provider.getRoomHistory('!room:hs', { limit: 25, before: 'cursor-1' })
    expect(fetchRoomMessages).toHaveBeenCalledWith({
      roomId: '!room:hs',
      asUserId: '@_zooid:hs',
      limit: 25,
      from: 'cursor-1',
    })
  })

  it('getChannelMembers returns joined members with is_agent flags', async () => {
    const client = fakeClient({
      getJoinedMembers: vi.fn().mockResolvedValue({
        joined: {
          '@alice:hs': { display_name: 'Alice' },
          '@architect:hs': { display_name: 'architect' },
        },
      }),
    } as unknown as Partial<MatrixClient>)
    const provider = new MatrixContextProvider({
      client,
      asUserId: '@_zooid:hs',
      agentBots: new Map([['@architect:hs', 'architect']]),
    })
    const members = await provider.getChannelMembers('!room:hs')
    expect(members).toEqual([
      { id: '@alice:hs', name: 'Alice', is_agent: false },
      { id: '@architect:hs', name: 'architect', is_agent: true, agent_name: 'architect' },
    ])
  })

  it('getChannelInfo returns the room name and transport: matrix', async () => {
    const client = fakeClient({
      fetchRoomName: vi.fn().mockResolvedValue('engineering'),
    } as unknown as Partial<MatrixClient>)
    const provider = new MatrixContextProvider({
      client,
      asUserId: '@_zooid:hs',
      agentBots: new Map(),
    })
    const info = await provider.getChannelInfo('!room:hs')
    expect(info).toEqual({ id: '!room:hs', name: 'engineering', transport: 'matrix' })
  })

  it('getRecentThreads returns top-level entries newest-first with bundled thread metadata, skipping thread replies', async () => {
    const client = fakeClient({
      fetchRoomMessages: vi.fn().mockResolvedValue({
        chunk: [
          {
            event_id: '$top2',
            sender: '@bob:hs',
            origin_server_ts: 3000,
            type: 'm.room.message',
            content: { msgtype: 'm.text', body: 'standalone' },
          },
          {
            event_id: '$reply1',
            sender: '@alice:hs',
            origin_server_ts: 2500,
            type: 'm.room.message',
            content: {
              msgtype: 'm.text',
              body: 'in-thread',
              'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
            },
          },
          {
            event_id: '$root',
            sender: '@alice:hs',
            origin_server_ts: 1000,
            type: 'm.room.message',
            content: { msgtype: 'm.text', body: 'thread root' },
            unsigned: {
              'm.relations': {
                'm.thread': { count: 3, latest_event: { origin_server_ts: 2500 } },
              },
            },
          },
        ],
        end: 'next-page',
      }),
    } as unknown as Partial<MatrixClient>)
    const provider = new MatrixContextProvider({
      client,
      asUserId: '@_zooid:hs',
      agentBots: new Map(),
    })
    const page = await provider.getRecentThreads('!room:hs', { limit: 50 })
    expect(page.threads.map((t) => t.id)).toEqual(['$top2', '$root'])
    expect(page.threads[0]).toMatchObject({
      id: '$top2',
      reply_count: 0,
      last_activity_at: new Date(3000).toISOString(),
    })
    expect(page.threads[1]).toMatchObject({
      id: '$root',
      reply_count: 3,
      last_activity_at: new Date(2500).toISOString(),
    })
    expect(page.has_more).toBe(true)
    expect(page.next_before).toBe('next-page')
  })

  it('getThreadHistory prepends the root event then appends replies oldest-first', async () => {
    const client = fakeClient({
      fetchEvent: vi.fn().mockResolvedValue({
        event_id: '$root',
        sender: '@alice:hs',
        origin_server_ts: 1000,
        type: 'm.room.message',
        content: { msgtype: 'm.text', body: 'root msg' },
      }),
      fetchThreadRelations: vi.fn().mockResolvedValue({
        chunk: [
          {
            event_id: '$r1',
            sender: '@bob:hs',
            origin_server_ts: 1500,
            type: 'm.room.message',
            content: {
              msgtype: 'm.text',
              body: 'first reply',
              'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
            },
          },
          {
            event_id: '$r2',
            sender: '@alice:hs',
            origin_server_ts: 2000,
            type: 'm.room.message',
            content: {
              msgtype: 'm.text',
              body: 'second reply',
              'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
            },
          },
        ],
        next_batch: undefined,
      }),
    } as unknown as Partial<MatrixClient>)
    const provider = new MatrixContextProvider({
      client,
      asUserId: '@_zooid:hs',
      agentBots: new Map(),
    })
    const page = await provider.getThreadHistory('!room:hs', '$root', {})
    expect(page.messages.map((m) => m.id)).toEqual(['$root', '$r1', '$r2'])
    expect(page.messages.every((m) => m.thread_id === '$root')).toBe(true)
    expect(page.has_more).toBe(false)
  })

  it('getThreadHistory skips the root fetch when paginating (before is set)', async () => {
    const fetchEvent = vi.fn()
    const fetchThreadRelations = vi.fn().mockResolvedValue({
      chunk: [],
      next_batch: 'next-cursor',
    })
    const provider = new MatrixContextProvider({
      client: fakeClient({ fetchEvent, fetchThreadRelations } as unknown as Partial<MatrixClient>),
      asUserId: '@_zooid:hs',
      agentBots: new Map(),
    })
    const page = await provider.getThreadHistory('!room:hs', '$root', {
      limit: 50,
      before: 'cursor-1',
    })
    expect(fetchEvent).not.toHaveBeenCalled()
    expect(fetchThreadRelations).toHaveBeenCalledWith({
      roomId: '!room:hs',
      rootEventId: '$root',
      asUserId: '@_zooid:hs',
      limit: 50,
      from: 'cursor-1',
    })
    expect(page.next_before).toBe('next-cursor')
    expect(page.has_more).toBe(true)
  })

  it('falls back to the room id when no name state is set', async () => {
    const client = fakeClient({
      fetchRoomName: vi.fn().mockResolvedValue(null),
    } as unknown as Partial<MatrixClient>)
    const provider = new MatrixContextProvider({
      client,
      asUserId: '@_zooid:hs',
      agentBots: new Map(),
    })
    const info = await provider.getChannelInfo('!room:hs')
    expect(info.name).toBe('!room:hs')
  })
})

import { describe, it, expect, vi } from 'vitest'
import { MatrixContextProvider } from './context-provider.js'
import type { MatrixClient } from './matrix-client.js'

function fakeClient(overrides: Partial<MatrixClient> = {}): MatrixClient {
  return {
    fetchRoomMessages: vi.fn(),
    getJoinedMembers: vi.fn(),
    fetchRoomName: vi.fn(),
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

    const page = await provider.getThreadHistory(
      { channelId: '!room:hs', threadId: '!room:hs' },
      { limit: 50 },
    )

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
    const page = await provider.getThreadHistory(
      { channelId: '!room:hs', threadId: '!room:hs' },
      {},
    )
    expect(page.messages[0]).toMatchObject({
      sender: '@architect:hs',
      is_agent: true,
      agent_name: 'architect',
    })
    expect(page.has_more).toBe(false)
  })

  it('uses the threadId to filter to thread events when threadId differs from channelId', async () => {
    const fetchRoomMessages = vi.fn().mockResolvedValue({ chunk: [], end: undefined })
    const provider = new MatrixContextProvider({
      client: fakeClient({ fetchRoomMessages } as unknown as Partial<MatrixClient>),
      asUserId: '@_zooid:hs',
      agentBots: new Map(),
    })
    await provider.getThreadHistory(
      { channelId: '!room:hs', threadId: '$thread-root' },
      { limit: 25 },
    )
    expect(fetchRoomMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: '!room:hs',
        threadId: '$thread-root',
        limit: 25,
      }),
    )
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
    const members = await provider.getChannelMembers({
      channelId: '!room:hs',
      threadId: '!room:hs',
    })
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
    const info = await provider.getChannelInfo({
      channelId: '!room:hs',
      threadId: '!room:hs',
    })
    expect(info).toEqual({ id: '!room:hs', name: 'engineering', transport: 'matrix' })
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
    const info = await provider.getChannelInfo({
      channelId: '!room:hs',
      threadId: '!room:hs',
    })
    expect(info.name).toBe('!room:hs')
  })
})

import { describe, it, expect } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildContextMcpServer } from './mcp-server.js'
import type { TaskActions, TransportContextProvider } from '@zooid/core'

function makeProvider(over: Partial<TransportContextProvider> = {}): TransportContextProvider {
  return {
    getRoomHistory: async () => ({ messages: [], has_more: false }),
    getRecentThreads: async () => ({ threads: [], has_more: false }),
    getThreadHistory: async () => ({ messages: [], has_more: false }),
    getChannelMembers: async () => [],
    getRoomInfo: async () => ({ id: 'r', name: 'r', transport: 'matrix' }),
    getRooms: async () => [{ id: '!a:localhost', name: 'general', transport: 'matrix' }],
    sendMessage: async () => ({ event_id: '$sent' }),
    ...over,
  }
}

function makeTasks(over: Partial<TaskActions> = {}): TaskActions {
  return {
    startTasks: async () => ({ results: [], notify: 'caller', delivery: 'd' }),
    completeTask: async () => ({ status: 'recorded' }),
    describeRole: async () => ({ is_task_assignee: false, can_start_task_threads: true }),
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
  it('lists the read-only surface plus zooid_send_message and zooid_get_rooms when no task role is given', async () => {
    const server = buildContextMcpServer({
      resolve: async () => makeProvider(),
    })
    const client = await connect(server)
    const list = await client.listTools()
    expect(list.tools.map((t) => t.name).sort()).toEqual([
      'zooid_get_history',
      'zooid_get_members',
      'zooid_get_recent_threads',
      'zooid_get_room_info',
      'zooid_get_rooms',
      'zooid_get_thread_history',
      'zooid_send_message',
    ])
  })

  it('renames the two tools that did not name Matrix primitives', async () => {
    const server = buildContextMcpServer({ resolve: async () => makeProvider() })
    const client = await connect(server)
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toContain('zooid_get_room_info')
    expect(names).not.toContain('zooid_get_channel_info')
    expect(names).toContain('zooid_send_message')
    expect(names).toContain('zooid_get_rooms')
  })

  it('registers start_task_threads but not complete_task for a non-assignee', async () => {
    const server = buildContextMcpServer({
      resolve: async () => makeProvider(),
      resolveTasks: async () => makeTasks(),
      role: { is_task_assignee: false, can_start_task_threads: true },
    })
    const names = (await (await connect(server)).listTools()).tools.map((t) => t.name)
    expect(names).toContain('zooid_start_task_threads')
    expect(names).not.toContain('zooid_complete_task')
  })

  it('registers complete_task but not start_task_threads for an assignee', async () => {
    const server = buildContextMcpServer({
      resolve: async () => makeProvider(),
      resolveTasks: async () => makeTasks(),
      role: { is_task_assignee: true, can_start_task_threads: false },
    })
    const names = (await (await connect(server)).listTools()).tools.map((t) => t.name)
    expect(names).toContain('zooid_complete_task')
    expect(names).not.toContain('zooid_start_task_threads')
  })

  it('omits both task tools when no role is resolved', async () => {
    const server = buildContextMcpServer({
      resolve: async () => makeProvider(),
      resolveTasks: async () => makeTasks(),
    })
    const names = (await (await connect(server)).listTools()).tools.map((t) => t.name)
    expect(names).not.toContain('zooid_complete_task')
    expect(names).not.toContain('zooid_start_task_threads')
  })

  it('start_task_threads returns the delivery contract verbatim', async () => {
    const server = buildContextMcpServer({
      resolve: async () => makeProvider(),
      resolveTasks: async () =>
        makeTasks({
          startTasks: async () => ({
            results: [{ agent: 'reviewer', status: 'started', thread_id: '$t' }],
            notify: 'caller',
            delivery:
              'Each result returns to you as a new turn when that task completes. End your turn now — do not read the task thread to wait for it.',
          }),
        }),
      role: { is_task_assignee: false, can_start_task_threads: true },
    })
    const client = await connect(server)
    const res = await client.callTool({
      name: 'zooid_start_task_threads',
      arguments: { tasks: [{ agent: 'reviewer', prompt: 'review' }] },
    })
    const payload = JSON.parse((res.content as Array<{ text: string }>)[0].text)
    expect(payload.notify).toBe('caller')
    expect(payload.delivery).toMatch(/End your turn now/)
  })

  it('send_message forwards room, thread_id and text', async () => {
    const sent: unknown[] = []
    const server = buildContextMcpServer({
      resolve: async () =>
        makeProvider({
          sendMessage: async (input) => {
            sent.push(input)
            return { event_id: '$e', thread_id: '$t' }
          },
        }),
    })
    const client = await connect(server)
    await client.callTool({
      name: 'zooid_send_message',
      arguments: { room: '!a:localhost', thread_id: '$t', text: 'noted' },
    })
    expect(sent).toEqual([{ room: '!a:localhost', thread_id: '$t', text: 'noted' }])
  })

  it('zooid_get_rooms returns the provider payload', async () => {
    const server = buildContextMcpServer({
      resolve: async () =>
        makeProvider({
          getRooms: async () => [{ id: '!a:localhost', name: 'general', transport: 'matrix' }],
        }),
    })
    const client = await connect(server)
    const res = await client.callTool({ name: 'zooid_get_rooms', arguments: {} })
    const payload = JSON.parse((res.content as Array<{ text: string }>)[0].text)
    expect(payload).toEqual({ rooms: [{ id: '!a:localhost', name: 'general', transport: 'matrix' }] })
  })

  it('zooid_get_history forwards limit + before and returns the page as text JSON', async () => {
    const calls: Array<{ limit?: number; before?: string }> = []
    const provider = makeProvider({
      getRoomHistory: async (_c, opts) => {
        calls.push(opts)
        return {
          messages: [
            {
              id: 'e1',
              sender: 'alice',
              text: 'hi',
              timestamp: 'T',
              is_agent: false,
            },
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
      messages: [
        {
          id: 'e1',
          sender: 'alice',
          text: 'hi',
          timestamp: 'T',
          is_agent: false,
        },
      ],
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
    await client.callTool({
      name: 'zooid_get_history',
      arguments: { limit: 5000 },
    })
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
    const res = await client.callTool({
      name: 'zooid_get_recent_threads',
      arguments: {},
    })
    const payload = JSON.parse((res.content as Array<{ text: string }>)[0].text)
    expect(payload.threads[0]).toMatchObject({ id: '$root', reply_count: 4 })
  })

  it('zooid_get_thread_history forwards thread_id and limit/before', async () => {
    const calls: Array<{
      threadId: string
      opts: { limit?: number; before?: string }
    }> = []
    const provider = makeProvider({
      getThreadHistory: async (_c, threadId, opts) => {
        calls.push({ threadId, opts })
        return {
          messages: [
            {
              id: '$root',
              sender: 'alice',
              text: 'root',
              timestamp: 'T',
              is_agent: false,
            },
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
    expect(calls[0]).toEqual({
      threadId: '$root',
      opts: { limit: 10, before: undefined },
    })
  })

  it('zooid_get_thread_history surfaces a validation error when thread_id is missing', async () => {
    const server = buildContextMcpServer({
      resolve: async () => makeProvider(),
    })
    const client = await connect(server)
    const res = await client.callTool({
      name: 'zooid_get_thread_history',
      arguments: {},
    })
    expect(res.isError).toBe(true)
  })

  it('zooid_get_members and zooid_get_room_info return the provider payload', async () => {
    const provider = makeProvider({
      getChannelMembers: async () => [
        { id: '@alice:hs', name: 'alice', is_agent: false },
        {
          id: '@architect:hs',
          name: 'architect',
          is_agent: true,
          agent_name: 'architect',
        },
      ],
      getRoomInfo: async () => ({
        id: '!r:hs',
        name: 'general',
        transport: 'matrix',
      }),
    })
    const server = buildContextMcpServer({ resolve: async () => provider })
    const client = await connect(server)

    const m = await client.callTool({
      name: 'zooid_get_members',
      arguments: {},
    })
    expect(JSON.parse((m.content as Array<{ text: string }>)[0].text)).toEqual({
      members: [
        { id: '@alice:hs', name: 'alice', is_agent: false },
        {
          id: '@architect:hs',
          name: 'architect',
          is_agent: true,
          agent_name: 'architect',
        },
      ],
    })

    const i = await client.callTool({
      name: 'zooid_get_room_info',
      arguments: {},
    })
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
    const res = await client.callTool({
      name: 'zooid_get_history',
      arguments: {},
    })
    expect(res.isError).toBe(true)
  })

  it('exposes task writes only when the daemon supplies task actions and a matching role', async () => {
    const calls: unknown[] = []
    const server = buildContextMcpServer({
      resolve: async () => makeProvider(),
      resolveTasks: async () =>
        makeTasks({
          startTasks: async (_caller, input) => {
            calls.push(input)
            return {
              results: [{ agent: 'worker', status: 'started', thread_id: '$task' }],
              notify: 'caller',
              delivery: 'd',
            }
          },
        }),
      role: { is_task_assignee: false, can_start_task_threads: true },
    })
    const client = await connect(server)
    expect((await client.listTools()).tools.map((t) => t.name)).toContain(
      'zooid_start_task_threads',
    )
    const result = await client.callTool({
      name: 'zooid_start_task_threads',
      arguments: { tasks: [{ agent: 'worker', prompt: 'audit' }] },
    })
    expect(calls).toEqual([{ tasks: [{ agent: 'worker', prompt: 'audit' }], notify: 'caller' }])
    expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toMatchObject({
      results: [{ thread_id: '$task' }],
    })
  })
})

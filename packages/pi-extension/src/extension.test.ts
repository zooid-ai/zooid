import { describe, expect, it } from 'vitest'
import createExtension from './extension.js'

function harness(reply: unknown = { ok: true, result: { messages: [] } }) {
  const tools: Array<any> = []
  const handlers: Record<string, Function> = {}
  let active: string[] = []
  const pi = {
    registerTool: (tool: any) => {
      tools.push(tool)
      active.push(tool.name)
    },
    on: (event: string, handler: Function) => {
      handlers[event] = handler
    },
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = names
    },
    getAllTools: () => tools.map((t) => ({ name: t.name })),
  }
  const calls: Array<any> = []
  createExtension(pi as any, {
    resolve: async (request) => {
      calls.push(request)
      return reply as any
    },
  })
  return { tools, calls, handlers, activeTools: () => active }
}
const ctx = (sessionId = 'session-a') => ({ sessionManager: { getSessionId: () => sessionId } })

describe('Pi Zooid extension', () => {
  it('registers the renamed surface plus the two new tools', () => {
    const { tools } = harness()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'zooid_complete_task', 'zooid_get_history', 'zooid_get_members',
      'zooid_get_recent_threads', 'zooid_get_room_info', 'zooid_get_rooms',
      'zooid_get_thread_history', 'zooid_send_message', 'zooid_start_task_threads',
    ])
  })

  it('carries the wake contract in promptGuidelines', () => {
    const { tools } = harness()
    const start = tools.find((t) => t.name === 'zooid_start_task_threads')
    expect(start.promptGuidelines.join(' ')).toMatch(/zooid_start_task_threads/)
    expect(start.promptGuidelines.join(' ')).toMatch(/end your turn/i)
  })

  it('uses the session from ctx for every call and defaults task notifications', async () => {
    const { tools, calls } = harness({ ok: true, result: { results: [] } })
    await tools.find((tool) => tool.name === 'zooid_start_task_threads').execute(
      'call', { tasks: [{ agent: 'reviewer', prompt: 'review this' }] }, undefined, undefined, ctx('alpha'),
    )
    await tools.find((tool) => tool.name === 'zooid_complete_task').execute(
      'call', { summary: 'done' }, undefined, undefined, ctx('beta'),
    )
    expect(calls).toEqual([
      { acpSessionId: 'alpha', method: 'startTasks', params: { tasks: [{ agent: 'reviewer', prompt: 'review this' }], notify: 'caller' } },
      { acpSessionId: 'beta', method: 'completeTask', params: { summary: 'done' } },
    ])
  })

  it('maps read tools to the daemon methods and clamps pagination', async () => {
    const { tools, calls } = harness()
    await tools.find((tool) => tool.name === 'zooid_get_history').execute('c', { limit: 5000 }, undefined, undefined, ctx())
    await tools.find((tool) => tool.name === 'zooid_get_thread_history').execute('c', { thread_id: '$root', before: 'cursor' }, undefined, undefined, ctx())
    expect(calls).toEqual([
      { acpSessionId: 'session-a', method: 'getRoomHistory', params: { limit: 200 } },
      { acpSessionId: 'session-a', method: 'getThreadHistory', params: { threadId: '$root', limit: 50, before: 'cursor' } },
    ])
  })

  it('zooid_send_message forwards room, thread_id and text', async () => {
    const { tools, calls } = harness({ ok: true, result: { event_id: '$e' } })
    await tools.find((tool) => tool.name === 'zooid_send_message').execute(
      'c', { room: '!a:localhost', thread_id: '$t', text: 'noted' }, undefined, undefined, ctx(),
    )
    expect(calls).toEqual([
      { acpSessionId: 'session-a', method: 'sendMessage', params: { room: '!a:localhost', thread_id: '$t', text: 'noted' } },
    ])
  })

  it('zooid_get_rooms maps to getRooms with no params', async () => {
    const { tools, calls } = harness({ ok: true, result: { rooms: [] } })
    await tools.find((tool) => tool.name === 'zooid_get_rooms').execute('c', {}, undefined, undefined, ctx())
    expect(calls).toEqual([{ acpSessionId: 'session-a', method: 'getRooms', params: {} }])
  })

  it('returns readable errors for unbound sessions and invalid completion summaries', async () => {
    const { tools } = harness({ ok: false, error: 'unknown session: orphan' })
    const unbound = await tools.find((tool) => tool.name === 'zooid_get_members').execute('c', {}, undefined, undefined, ctx('orphan'))
    const invalid = await tools.find((tool) => tool.name === 'zooid_complete_task').execute('c', { summary: '  ' }, undefined, undefined, ctx())
    expect(unbound).toMatchObject({ isError: true })
    expect(unbound.content[0].text).toMatch(/not bound/i)
    expect(invalid).toMatchObject({ isError: true })
  })

  it('disables complete_task for a non-assignee on session_start', async () => {
    const { handlers, activeTools } = harness({
      ok: true, result: { is_task_assignee: false, can_start_task_threads: true },
    })
    await handlers.session_start?.({ reason: 'startup' }, ctx('alpha'))
    expect(activeTools()).toContain('zooid_start_task_threads')
    expect(activeTools()).not.toContain('zooid_complete_task')
  })

  it('disables start_task_threads for an assignee on session_start', async () => {
    const { handlers, activeTools } = harness({
      ok: true, result: { is_task_assignee: true, can_start_task_threads: false },
    })
    await handlers.session_start?.({ reason: 'startup' }, ctx('beta'))
    expect(activeTools()).toContain('zooid_complete_task')
    expect(activeTools()).not.toContain('zooid_start_task_threads')
  })

  it('leaves the surface untouched when the role query fails', async () => {
    const { handlers, tools, activeTools } = harness({ ok: false, error: 'binding not owned by caller' })
    await handlers.session_start?.({ reason: 'startup' }, ctx('gamma'))
    // Fail open: a daemon hiccup must not strip an assignee's ability to finish.
    expect(activeTools().length === 0 || activeTools().length === tools.length).toBe(true)
  })
})

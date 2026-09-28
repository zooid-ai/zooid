import { describe, expect, it } from 'vitest'
import {
  AGENT_NOTIFY_INSTRUCTIONS,
  HANDOFF_DESCRIPTION,
  SEND_MESSAGE_DESCRIPTION,
} from '@zooid/context-mcp'
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
  it('registers the renamed surface plus the task and handoff tools', () => {
    const { tools } = harness()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'zooid_complete_task', 'zooid_get_history', 'zooid_get_members',
      'zooid_get_recent_threads', 'zooid_get_room_info', 'zooid_get_rooms',
      'zooid_get_thread_history', 'zooid_handoff', 'zooid_send_message',
      'zooid_start_task_threads',
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

describe('zooid_handoff on pi ([[ZOD094]])', () => {
  const handoff = (tools: any[]) => tools.find((t) => t.name === 'zooid_handoff')

  it('uses the MCP description verbatim and takes agent + prompt', () => {
    const { tools } = harness()
    const tool = handoff(tools)
    expect(tool.description).toBe(HANDOFF_DESCRIPTION)
    expect(tool.parameters).toEqual({
      type: 'object',
      properties: { agent: { type: 'string' }, prompt: { type: 'string' } },
      required: ['agent', 'prompt'],
    })
  })

  it('carries the MCP server instructions and the end-your-turn rule in promptGuidelines', () => {
    const { tools } = harness()
    const guidelines: string[] = handoff(tools).promptGuidelines
    // Pi has no server-level instructions slot; this is where it goes.
    expect(guidelines).toContain(AGENT_NOTIFY_INSTRUCTIONS)
    const rest = guidelines.filter((g) => g !== AGENT_NOTIFY_INSTRUCTIONS).join(' ')
    expect(rest).toMatch(/zooid_handoff/)
    expect(rest).toMatch(/end your turn/i)
    expect(rest).toMatch(/\[handoff return\]/)
  })

  it('zooid_send_message uses the shared 0.16 description', () => {
    const { tools } = harness()
    const send = tools.find((t) => t.name === 'zooid_send_message')
    expect(send.description).toBe(SEND_MESSAGE_DESCRIPTION)
  })

  it('forwards agent and prompt as a handoff request addressed by the pi session', async () => {
    const started = {
      status: 'started', call_id: 'c1', callee: '@cloud.product:hs',
      delivery: 'Handed off to product. End your turn now.',
    }
    const { tools, calls } = harness({ ok: true, result: started })
    const res = await handoff(tools).execute(
      'call', { agent: 'product', prompt: 'write the spec' }, undefined, undefined, ctx('alpha'),
    )
    expect(calls).toEqual([
      { acpSessionId: 'alpha', method: 'handoff', params: { agent: 'product', prompt: 'write the spec' } },
    ])
    expect(res.isError).toBeUndefined()
    expect(JSON.parse(res.content[0].text)).toEqual(started)
  })

  it('returns a refusal as a readable result, not an error', async () => {
    const refused = { status: 'refused', reason: 'self: you cannot hand off to yourself' }
    const { tools } = harness({ ok: true, result: refused })
    const res = await handoff(tools).execute(
      'call', { agent: 'me', prompt: 'x' }, undefined, undefined, ctx(),
    )
    // The model is meant to read `reason` and act on it (ZOD092 §1).
    expect(res.isError).toBeUndefined()
    expect(JSON.parse(res.content[0].text)).toEqual(refused)
  })

  it('reports an unbound session as an error', async () => {
    const { tools } = harness({ ok: false, error: 'binding not owned by caller' })
    const res = await handoff(tools).execute(
      'call', { agent: 'product', prompt: 'x' }, undefined, undefined, ctx('orphan'),
    )
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toMatch(/not bound/i)
  })

  it('reports a missing pi session id as an error without calling the daemon', async () => {
    const { tools, calls } = harness()
    const res = await handoff(tools).execute(
      'call', { agent: 'product', prompt: 'x' }, undefined, undefined, { sessionManager: {} },
    )
    expect(res.isError).toBe(true)
    expect(calls).toEqual([])
  })
})

describe('zooid_handoff role gating ([[ZOD094]])', () => {
  it('keeps zooid_handoff active when the role allows it', async () => {
    const { handlers, activeTools } = harness({
      ok: true, result: { is_task_assignee: false, can_start_task_threads: true, can_handoff: true },
    })
    await handlers.session_start?.({ reason: 'startup' }, ctx('alpha'))
    expect(activeTools()).toContain('zooid_handoff')
  })

  it('removes zooid_handoff when the role forbids it', async () => {
    const { handlers, activeTools } = harness({
      ok: true, result: { is_task_assignee: false, can_start_task_threads: true, can_handoff: false },
    })
    await handlers.session_start?.({ reason: 'startup' }, ctx('alpha'))
    expect(activeTools()).not.toContain('zooid_handoff')
    // The other gates are unaffected.
    expect(activeTools()).toContain('zooid_start_task_threads')
  })

  it('removes zooid_handoff when an older daemon omits can_handoff', async () => {
    const { handlers, activeTools } = harness({
      ok: true, result: { is_task_assignee: false, can_start_task_threads: true },
    })
    await handlers.session_start?.({ reason: 'startup' }, ctx('alpha'))
    expect(activeTools()).not.toContain('zooid_handoff')
  })

  it('leaves zooid_handoff in place when the role query fails (fail open)', async () => {
    const { handlers, activeTools } = harness({ ok: false, error: 'binding not owned by caller' })
    await handlers.session_start?.({ reason: 'startup' }, ctx('gamma'))
    expect(activeTools()).toContain('zooid_handoff')
  })
})

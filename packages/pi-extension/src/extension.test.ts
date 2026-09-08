import { describe, expect, it } from 'vitest'
import createExtension from './extension.js'

function harness(reply: unknown = { ok: true, result: { messages: [] } }) {
  const tools: Array<any> = []
  const calls: Array<any> = []
  createExtension({ registerTool: (tool) => tools.push(tool) }, {
    resolve: async (request) => {
      calls.push(request)
      return reply as any
    },
  })
  return { tools, calls }
}
const ctx = (sessionId = 'session-a') => ({ sessionManager: { getSessionId: () => sessionId } })

describe('Pi Zooid extension', () => {
  it('registers the complete Zooid read and task tool surface', () => {
    const { tools } = harness()
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'zooid_complete_task', 'zooid_get_channel_info', 'zooid_get_history',
      'zooid_get_members', 'zooid_get_recent_threads', 'zooid_get_thread_history',
      'zooid_start_tasks',
    ])
  })

  it('uses the session from ctx for every call and defaults task notifications', async () => {
    const { tools, calls } = harness({ ok: true, result: { results: [] } })
    await tools.find((tool) => tool.name === 'zooid_start_tasks').execute(
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

  it('returns readable errors for unbound sessions and invalid completion summaries', async () => {
    const { tools } = harness({ ok: false, error: 'unknown session: orphan' })
    const unbound = await tools.find((tool) => tool.name === 'zooid_get_members').execute('c', {}, undefined, undefined, ctx('orphan'))
    const invalid = await tools.find((tool) => tool.name === 'zooid_complete_task').execute('c', { summary: '  ' }, undefined, undefined, ctx())
    expect(unbound).toMatchObject({ isError: true })
    expect(unbound.content[0].text).toMatch(/not bound/i)
    expect(invalid).toMatchObject({ isError: true })
  })
})

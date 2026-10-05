import { describe, expect, it } from 'vitest'
import {
  buildAssignmentContent,
  checkDelegable,
  renderCompletionPrompt,
  renderHandoffReturn,
} from './task-dispatch.js'
import type { AgentBinding } from './router.js'
const agents: AgentBinding[] = [
  {
    name: 'supervisor',
    userId: '@supervisor:hs',
    rooms: [{ alias: '!r:hs' }],
    trigger: 'mention',
  },
  {
    name: 'worker',
    userId: '@worker:hs',
    rooms: [{ alias: '!r:hs' }],
    trigger: 'mention',
  },
]
describe('task dispatch', () => {
  it('admits only local room agents', () => {
    expect(checkDelegable('worker', '!r:hs', agents)).toEqual({ ok: true })
    expect(checkDelegable('ghost', '!r:hs', agents)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('unknown_agent'),
    })
  })
  it('makes a visible, unthreaded signed root and renders a return', () => {
    const content = buildAssignmentContent({
      assigneeUserId: '@worker:hs',
      prompt: 'audit',
      start: {
        version: 1,
        assignee: 'worker',
        attempt_id: 'a1',
        parent: { agent: 'supervisor', thread_root: '$p', session_key: '$p' },
        notify: 'caller',
      },
    })
    expect(content).toMatchObject({
      msgtype: 'm.notice',
      body: '@worker:hs audit',
      'm.mentions': { user_ids: ['@worker:hs'] },
    })
    expect(content).not.toHaveProperty('formatted_body')
    expect(content).not.toHaveProperty('format')
    expect(content['m.relates_to']).toBeUndefined()
    expect(
      renderCompletionPrompt({
        agent: 'worker',
        thread_id: '$task',
        status: 'complete',
        output: { type: 'message', text: 'done' },
      }),
    ).toContain('done')
  })
})

describe('renderHandoffReturn', () => {
  it('heads the resolving turn prose with the callee', () => {
    expect(renderHandoffReturn({ callee: 'ux', text: 'login works in both themes' })).toBe(
      '[handoff return] from ux\n\nlogin works in both themes',
    )
  })

  it('says so when the resolving turn produced no prose', () => {
    expect(renderHandoffReturn({ callee: 'ux', text: '  ' })).toBe(
      '[handoff return] from ux — ended its turn without a reply',
    )
  })
})

import { describe, it, expect, vi } from 'vitest'
import { fireTrigger } from './trigger-runner.js'
import type { TriggerConfig } from '@zooid/core'

const trigger: TriggerConfig = {
  schedule: '0 6 * * 1',
  as: '@cron:example.org',
  room: '#ops:example.org',
  mention: 'architect',
  text: 'Check the pinned agent CLI versions.',
}

const deps = (over: Record<string, unknown> = {}) => ({
  name: 'image-currency',
  trigger,
  agentUserId: '@architect:example.org',
  resolveRoom: vi.fn(async () => '!room:example.org'),
  ensureBot: vi.fn(async () => {}),
  sendMessage: vi.fn(async () => ({ event_id: '$1' })),
  ...over,
})

describe('fireTrigger', () => {
  it('posts text verbatim as the trigger bot user', async () => {
    const d = deps()
    await fireTrigger(d as never)
    expect(d.sendMessage).toHaveBeenCalledTimes(1)
    const call = (d.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.roomId).toBe('!room:example.org')
    expect(call.asUserId).toBe('@cron:example.org')
    expect(call.content.body).toBe('Check the pinned agent CLI versions.')
    expect(call.content.msgtype).toBe('m.text')
  })

  it('sets m.mentions.user_ids structurally — never a templated @name (§Design 3)', async () => {
    const d = deps()
    await fireTrigger(d as never)
    const content = (d.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0].content
    expect(content['m.mentions']).toEqual({ user_ids: ['@architect:example.org'] })
    expect(content.body).not.toContain('@architect')
  })

  it('posts at the top level, never into a thread — runTurn makes each firing a new root', async () => {
    const d = deps()
    await fireTrigger(d as never)
    expect((d.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0].threadRoot).toBeUndefined()
  })

  it('registers and joins the bot user before posting', async () => {
    const d = deps()
    await fireTrigger(d as never)
    expect(d.ensureBot).toHaveBeenCalledWith('@cron:example.org', '!room:example.org')
    const ensure = (d.ensureBot as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
    const send = (d.sendMessage as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
    expect(ensure).toBeLessThan(send)
  })

  it('surfaces a send failure without throwing — one bad firing must not kill the scheduler', async () => {
    const d = deps({
      sendMessage: vi.fn(async () => {
        throw new Error('matrix down')
      }),
    })
    await expect(fireTrigger(d as never)).resolves.toBeUndefined()
  })

  it('does not post when the room cannot be resolved', async () => {
    const d = deps({ resolveRoom: vi.fn(async () => null) })
    await fireTrigger(d as never)
    expect(d.sendMessage).not.toHaveBeenCalled()
  })
})

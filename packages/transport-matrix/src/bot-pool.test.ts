import { describe, it, expect, vi } from 'vitest'
import { BotPool } from './bot-pool.js'
import type { AgentBinding } from './router.js'

function fakeClient() {
  return {
    registerBot: vi.fn(async () => undefined),
    joinRoom: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => ({ event_id: '$x' })),
    sendCustomEvent: vi.fn(async () => ({ event_id: '$x' })),
  }
}

const agents: AgentBinding[] = [
  {
    name: 'architect',
    userId: '@architect:example.com',
    rooms: ['!r1:example.com', '!r2:example.com'],
    trigger: 'mention',
  },
  {
    name: 'monitor',
    userId: '@monitor:example.com',
    rooms: ['!alerts:example.com'],
    trigger: 'any',
  },
]

describe('BotPool.bootstrap', () => {
  it('registers each bot and joins each of its rooms', async () => {
    const client = fakeClient()
    const pool = new BotPool(client, agents)
    await pool.bootstrap()
    expect(client.registerBot).toHaveBeenCalledWith('architect')
    expect(client.registerBot).toHaveBeenCalledWith('monitor')
    expect(client.joinRoom).toHaveBeenCalledWith('!r1:example.com', '@architect:example.com')
    expect(client.joinRoom).toHaveBeenCalledWith('!r2:example.com', '@architect:example.com')
    expect(client.joinRoom).toHaveBeenCalledWith('!alerts:example.com', '@monitor:example.com')
  })

  it('continues when one bot fails to register (logs but does not abort)', async () => {
    const client = fakeClient()
    client.registerBot.mockImplementationOnce(async () => {
      throw new Error('boom')
    })
    const pool = new BotPool(client, agents)
    await pool.bootstrap()
    expect(client.registerBot).toHaveBeenCalledTimes(2)
    // monitor's rooms still joined despite architect failure
    expect(client.joinRoom).toHaveBeenCalledWith('!alerts:example.com', '@monitor:example.com')
  })

  it('looks up an agent binding by user id', () => {
    const client = fakeClient()
    const pool = new BotPool(client, agents)
    expect(pool.findByUserId('@architect:example.com')?.name).toBe('architect')
    expect(pool.findByUserId('@nobody:example.com')).toBeUndefined()
  })

  it('looks up an agent binding by name', () => {
    const client = fakeClient()
    const pool = new BotPool(client, agents)
    expect(pool.findByName('monitor')?.userId).toBe('@monitor:example.com')
  })
})

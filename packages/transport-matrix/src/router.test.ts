import { describe, it, expect } from 'vitest'
import { route, type AgentBinding } from './router.js'

const agents: AgentBinding[] = [
  {
    name: 'architect',
    userId: '@architect:example.com',
    rooms: [{ alias: '!room1:example.com' }],
    trigger: 'mention',
  },
  {
    name: 'monitor',
    userId: '@monitor:example.com',
    rooms: [{ alias: '!alerts:example.com' }],
    trigger: 'any',
  },
]

function msg(
  overrides: Partial<{ room: string; sender: string; body: string; mentions: string[] }> = {},
) {
  return {
    type: 'm.room.message',
    room_id: overrides.room ?? '!room1:example.com',
    sender: overrides.sender ?? '@alice:example.com',
    event_id: '$evt',
    content: {
      msgtype: 'm.text',
      body: overrides.body ?? 'hello',
      ...(overrides.mentions ? { 'm.mentions': { user_ids: overrides.mentions } } : {}),
    },
  }
}

describe('route', () => {
  it('matches mention-triggered agents only when their user id is mentioned', () => {
    const matches = route(msg({ mentions: ['@architect:example.com'] }), agents)
    expect(matches.map((m) => m.name)).toEqual(['architect'])
  })

  it('does not match mention-triggered agents on a plain message', () => {
    const matches = route(msg(), agents)
    expect(matches).toEqual([])
  })

  it('matches `any`-triggered agents on every message in their rooms', () => {
    const matches = route(msg({ room: '!alerts:example.com' }), agents)
    expect(matches.map((m) => m.name)).toEqual(['monitor'])
  })

  it('does not match an `any` agent in a room it does not belong to', () => {
    const matches = route(msg({ room: '!room1:example.com' }), agents)
    expect(matches.map((m) => m.name)).toEqual([])
  })

  it('skips events whose sender is the matched agent itself', () => {
    const matches = route(
      msg({ sender: '@architect:example.com', mentions: ['@architect:example.com'] }),
      agents,
    )
    expect(matches).toEqual([])
  })

  it('returns multiple bindings when multiple agents are mentioned in the same event', () => {
    const both: AgentBinding[] = [
      ...agents,
      {
        name: 'qa',
        userId: '@qa:example.com',
        rooms: [{ alias: '!room1:example.com' }],
        trigger: 'mention',
      },
    ]
    const matches = route(
      msg({ mentions: ['@architect:example.com', '@qa:example.com'] }),
      both,
    )
    expect(matches.map((m) => m.name).sort()).toEqual(['architect', 'qa'])
  })

  it('ignores non-m.room.message events', () => {
    const stateEvent = {
      type: 'm.room.member',
      room_id: '!room1:example.com',
      sender: '@alice:example.com',
      content: {},
    }
    expect(route(stateEvent as never, agents)).toEqual([])
  })
})

import { describe, it, expect } from 'vitest'
import { route, isMediaMsgtype, type AgentBinding, type ThreadState } from './router.js'

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

describe('media events', () => {
  it('classifies media msgtypes', () => {
    for (const t of ['m.image', 'm.file', 'm.video', 'm.audio']) {
      expect(isMediaMsgtype(t)).toBe(true)
    }
    expect(isMediaMsgtype('m.text')).toBe(false)
    expect(isMediaMsgtype('m.notice')).toBe(false)
    expect(isMediaMsgtype(undefined)).toBe(false)
  })

  it('never routes media events to agents, even trigger=any', () => {
    const monitorRoom = msg({ room: '!alerts:example.com', body: 'dog.jpg' })
    const mediaEvent = {
      ...monitorRoom,
      content: { msgtype: 'm.image', body: 'dog.jpg', url: 'mxc://localhost/abc' },
    }
    const matches = route(mediaEvent, agents)
    expect(matches).toEqual([])
  })
})

describe('directional thread continuation (agent-to-agent handoffs)', () => {
  const parent: AgentBinding = {
    name: 'parent',
    userId: '@parent:example.com',
    rooms: [{ alias: '!room1:example.com' }],
    trigger: 'mention',
  }
  const sub: AgentBinding = {
    name: 'sub',
    userId: '@sub:example.com',
    rooms: [{ alias: '!room1:example.com' }],
    trigger: 'mention',
  }
  const pair = [parent, sub]

  // A bare (or mentioning) reply inside the thread rooted at $root.
  function threadMsg(o: { sender: string; mentions?: string[] }) {
    return {
      type: 'm.room.message',
      room_id: '!room1:example.com',
      sender: o.sender,
      event_id: '$evt',
      content: {
        msgtype: 'm.text',
        body: 'reply',
        'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
        ...(o.mentions ? { 'm.mentions': { user_ids: o.mentions } } : {}),
      },
    }
  }

  function states(s: Partial<ThreadState>): Map<string, ThreadState> {
    return new Map([
      ['$root', { participants: [], rootMentions: [], callers: {}, handoffs: {}, ...s }],
    ])
  }

  it("routes a sub's bare reply up to its caller (parent notified)", () => {
    const matches = route(
      threadMsg({ sender: '@sub:example.com' }),
      pair,
      states({ participants: ['parent'], callers: { sub: 'parent' } }),
    )
    expect(matches.map((m) => m.name)).toEqual(['parent'])
  })

  it('does NOT re-trigger a callee when its parent posts a bare reply (loop guard)', () => {
    // parent is the sender; sub is its callee. parent has no caller of its own,
    // so its bare reply routes to nobody — the loop dies here.
    const matches = route(
      threadMsg({ sender: '@parent:example.com' }),
      pair,
      states({ participants: ['parent', 'sub'], callers: { sub: 'parent' } }),
    )
    expect(matches).toEqual([])
  })

  it('an explicit @mention still re-engages the sub (rule 1 wins)', () => {
    const matches = route(
      threadMsg({ sender: '@parent:example.com', mentions: ['@sub:example.com'] }),
      pair,
      states({ participants: ['parent', 'sub'], callers: { sub: 'parent' } }),
    )
    expect(matches.map((m) => m.name)).toEqual(['sub'])
  })

  it('dedupes: a sub reply that also @mentions its caller triggers the caller once', () => {
    const matches = route(
      threadMsg({ sender: '@sub:example.com', mentions: ['@parent:example.com'] }),
      pair,
      states({ participants: ['parent'], callers: { sub: 'parent' } }),
    )
    expect(matches.map((m) => m.name)).toEqual(['parent'])
  })

  it('bubbles a 3-level chain one hop at a time (grandchild → child, not parent)', () => {
    const child: AgentBinding = {
      name: 'child',
      userId: '@child:example.com',
      rooms: [{ alias: '!room1:example.com' }],
      trigger: 'mention',
    }
    const grand: AgentBinding = {
      name: 'grand',
      userId: '@grand:example.com',
      rooms: [{ alias: '!room1:example.com' }],
      trigger: 'mention',
    }
    const matches = route(
      threadMsg({ sender: '@grand:example.com' }),
      [parent, child, grand],
      states({
        participants: ['parent', 'child'],
        callers: { child: 'parent', grand: 'child' },
      }),
    )
    expect(matches.map((m) => m.name)).toEqual(['child'])
  })

  it('a human bare reply still continues with the most-recent-posting agent (unchanged)', () => {
    const matches = route(
      threadMsg({ sender: '@alice:example.com' }),
      pair,
      states({ participants: ['parent', 'sub'], callers: { sub: 'parent' } }),
    )
    expect(matches.map((m) => m.name)).toEqual(['sub'])
  })

  it('an agent with no caller (human-initiated) returns to nobody', () => {
    const matches = route(
      threadMsg({ sender: '@parent:example.com' }),
      pair,
      states({ participants: ['parent'], callers: {} }),
    )
    expect(matches).toEqual([])
  })
})

describe('fan-out: two subs called in one message ([[ZOD071]] acceptance)', () => {
  const mk = (name: string): AgentBinding => ({
    name,
    userId: `@${name}:example.com`,
    rooms: [{ alias: '!room1:example.com' }],
    trigger: 'mention',
  })
  const parent = mk('parent')
  const bebop = mk('bebop')
  const rocksteady = mk('rocksteady')
  const trio = [parent, bebop, rocksteady]

  function threadMsg(o: { sender: string; mentions?: string[] }) {
    return {
      type: 'm.room.message',
      room_id: '!room1:example.com',
      sender: o.sender,
      event_id: '$evt',
      content: {
        msgtype: 'm.text',
        body: 'reply',
        'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
        ...(o.mentions ? { 'm.mentions': { user_ids: o.mentions } } : {}),
      },
    }
  }

  function states(s: Partial<ThreadState>): Map<string, ThreadState> {
    return new Map([
      ['$root', { participants: [], rootMentions: [], callers: {}, handoffs: {}, ...s }],
    ])
  }

  it('a single message @mentioning both subs triggers both (fan-out)', () => {
    const matches = route(
      threadMsg({
        sender: '@parent:example.com',
        mentions: ['@bebop:example.com', '@rocksteady:example.com'],
      }),
      trio,
      states({ participants: ['parent'] }),
    )
    expect(matches.map((m) => m.name).sort()).toEqual(['bebop', 'rocksteady'])
  })

  it("bebop's bare return triggers only parent — never its sibling", () => {
    const matches = route(
      threadMsg({ sender: '@bebop:example.com' }),
      trio,
      states({
        participants: ['parent', 'rocksteady', 'bebop'],
        callers: { bebop: 'parent', rocksteady: 'parent' },
      }),
    )
    expect(matches.map((m) => m.name)).toEqual(['parent'])
  })

  it("rocksteady's bare return likewise routes only up", () => {
    const matches = route(
      threadMsg({ sender: '@rocksteady:example.com' }),
      trio,
      states({
        participants: ['parent', 'bebop', 'rocksteady'],
        callers: { bebop: 'parent', rocksteady: 'parent' },
      }),
    )
    expect(matches.map((m) => m.name)).toEqual(['parent'])
  })
})

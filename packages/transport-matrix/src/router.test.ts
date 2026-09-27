import { describe, it, expect } from 'vitest'
import { HANDOFF_FIELD } from '@zooid/core'
import {
  route,
  isMediaMsgtype,
  wouldCycleCallers,
  type AgentBinding,
  type ThreadState,
} from './router.js'

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
  overrides: Partial<{
    room: string
    sender: string
    body: string
    mentions: string[]
  }> = {},
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
      msg({
        sender: '@architect:example.com',
        mentions: ['@architect:example.com'],
      }),
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
    const matches = route(msg({ mentions: ['@architect:example.com', '@qa:example.com'] }), both)
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

describe('directed task routing', () => {
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
    {
      name: 'eager',
      userId: '@eager:hs',
      rooms: [{ alias: '!r:hs' }],
      trigger: 'any',
    },
  ]
  const root = {
    type: 'm.room.message',
    room_id: '!r:hs',
    sender: '@supervisor:hs',
    content: {
      msgtype: 'm.notice',
      body: '@worker:hs task',
      'm.mentions': { user_ids: ['@worker:hs'] },
    },
  }
  it('routes a task root solely to its assignee, including self assignment', () => {
    expect(
      route(root, agents, new Map(), { assignee: 'worker', isRoot: true }).map((x) => x.name),
    ).toEqual(['worker'])
    expect(
      route(root, agents, new Map(), {
        assignee: 'supervisor',
        isRoot: true,
      }).map((x) => x.name),
    ).toEqual(['supervisor'])
  })
  it('keeps trigger:any out of a task thread while allowing human steering and explicit mentions', () => {
    const state = new Map([
      [
        '$task',
        {
          participants: ['worker'],
          rootMentions: ['worker'],
          callers: {},
          handoffs: {},
        },
      ],
    ])
    const human = {
      ...root,
      sender: '@alice:hs',
      content: {
        msgtype: 'm.text',
        body: 'continue',
        'm.relates_to': { rel_type: 'm.thread', event_id: '$task' },
      },
    }
    expect(
      route(human, agents, state, { assignee: 'worker', isRoot: false }).map((x) => x.name),
    ).toEqual(['worker'])
    const humanMention = {
      ...human,
      content: { ...human.content, 'm.mentions': { user_ids: ['@supervisor:hs'] } },
    }
    expect(
      route(humanMention, agents, state, { assignee: 'worker', isRoot: false }).map(
        (x) => x.name,
      ),
    ).toEqual(['supervisor'])
    const mention = {
      ...human,
      sender: '@worker:hs',
      content: {
        ...human.content,
        'm.mentions': { user_ids: ['@supervisor:hs'] },
        [HANDOFF_FIELD]: { version: 1, call_id: 'c1', caller: '@worker:hs', callee: '@supervisor:hs' },
      },
    }
    expect(
      route(mention, agents, state, { assignee: 'worker', isRoot: false }).map((x) => x.name),
    ).toEqual(['supervisor'])
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
      content: {
        msgtype: 'm.image',
        body: 'dog.jpg',
        url: 'mxc://localhost/abc',
      },
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

  // A bare (or mentioning, or handing off) reply inside the thread rooted at $root.
  function threadMsg(o: {
    sender: string
    mentions?: string[]
    handoff?: { caller: string; callee: string }
  }) {
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
        ...(o.handoff
          ? { [HANDOFF_FIELD]: { version: 1, call_id: 'c1', ...o.handoff } }
          : {}),
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
      states({ participants: ['parent'], callers: { '@sub:example.com': '@parent:example.com' } }),
    )
    expect(matches.map((m) => m.name)).toEqual(['parent'])
  })

  it('does NOT re-trigger a callee when its parent posts a bare reply (loop guard)', () => {
    // parent is the sender; sub is its callee. parent has no caller of its own,
    // so its bare reply routes to nobody — the loop dies here.
    const matches = route(
      threadMsg({ sender: '@parent:example.com' }),
      pair,
      states({ participants: ['parent', 'sub'], callers: { '@sub:example.com': '@parent:example.com' } }),
    )
    expect(matches).toEqual([])
  })

  it('a handoff re-engages the sub', () => {
    const matches = route(
      threadMsg({
        sender: '@parent:example.com',
        mentions: ['@sub:example.com'],
        handoff: { caller: '@parent:example.com', callee: '@sub:example.com' },
      }),
      pair,
      states({ participants: ['parent', 'sub'], callers: { '@sub:example.com': '@parent:example.com' } }),
    )
    expect(matches.map((m) => m.name)).toEqual(['sub'])
  })

  it('dedupes: a sub reply that also @mentions its caller triggers the caller once', () => {
    const matches = route(
      threadMsg({
        sender: '@sub:example.com',
        mentions: ['@parent:example.com'],
      }),
      pair,
      states({ participants: ['parent'], callers: { '@sub:example.com': '@parent:example.com' } }),
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
        callers: { '@child:example.com': '@parent:example.com', '@grand:example.com': '@child:example.com' },
      }),
    )
    expect(matches.map((m) => m.name)).toEqual(['child'])
  })

  it('a human bare reply still continues with the most-recent-posting agent (unchanged)', () => {
    const matches = route(
      threadMsg({ sender: '@alice:example.com' }),
      pair,
      states({ participants: ['parent', 'sub'], callers: { '@sub:example.com': '@parent:example.com' } }),
    )
    expect(matches.map((m) => m.name)).toEqual(['sub'])
  })

  it('a human @mention of another agent switches addressee (no double routing)', () => {
    const matches = route(
      threadMsg({ sender: '@alice:example.com', mentions: ['@parent:example.com'] }),
      pair,
      states({ participants: ['parent', 'sub'], callers: { '@sub:example.com': '@parent:example.com' } }),
    )
    expect(matches.map((m) => m.name)).toEqual(['parent'])
  })

  it('a human @mention of another agent overrides root-mention inheritance', () => {
    const matches = route(
      threadMsg({ sender: '@alice:example.com', mentions: ['@sub:example.com'] }),
      pair,
      states({ rootMentions: ['parent'] }),
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

describe('caller graph cycle guard', () => {
  it('rejects a reverse edge back to an existing caller', () => {
    expect(wouldCycleCallers({ sub: 'parent' }, 'parent', 'sub')).toBe(true)
  })

  it('rejects a cycle through a deeper ancestor', () => {
    expect(
      wouldCycleCallers({ child: 'parent', grandchild: 'child' }, 'parent', 'grandchild'),
    ).toBe(true)
  })

  it('allows a new downward or sibling edge', () => {
    const callers = { child: 'parent' }
    expect(wouldCycleCallers(callers, 'grandchild', 'child')).toBe(false)
    expect(wouldCycleCallers(callers, 'sibling', 'parent')).toBe(false)
  })
})

describe('fan-out: two subs called via two handoff events ([[ZOD071]] / [[ZOD092]])', () => {
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

  function threadMsg(o: {
    sender: string
    mentions?: string[]
    handoff?: { caller: string; callee: string }
  }) {
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
        ...(o.handoff
          ? { [HANDOFF_FIELD]: { version: 1, call_id: 'c1', ...o.handoff } }
          : {}),
      },
    }
  }

  function states(s: Partial<ThreadState>): Map<string, ThreadState> {
    return new Map([
      ['$root', { participants: [], rootMentions: [], callers: {}, handoffs: {}, ...s }],
    ])
  }

  it('a handoff event names one callee only, not a second agent it also mentions', () => {
    const matches = route(
      threadMsg({
        sender: '@parent:example.com',
        mentions: ['@bebop:example.com', '@rocksteady:example.com'],
        handoff: { caller: '@parent:example.com', callee: '@bebop:example.com' },
      }),
      trio,
      states({ participants: ['parent'] }),
    )
    expect(matches.map((m) => m.name)).toEqual(['bebop'])
  })

  it("bebop's bare return triggers only parent — never its sibling", () => {
    const matches = route(
      threadMsg({ sender: '@bebop:example.com' }),
      trio,
      states({
        participants: ['parent', 'rocksteady', 'bebop'],
        callers: { '@bebop:example.com': '@parent:example.com', '@rocksteady:example.com': '@parent:example.com' },
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
        callers: { '@bebop:example.com': '@parent:example.com', '@rocksteady:example.com': '@parent:example.com' },
      }),
    )
    expect(matches.map((m) => m.name)).toEqual(['parent'])
  })
})

describe('agents on other workstations', () => {
  const coding: AgentBinding = {
    name: 'coding',
    userId: '@laptop.coding:hs',
    rooms: [{ alias: '!r:hs' }],
    trigger: 'mention',
  }
  const remoteProduct = '@cloud.product:hs'
  const states = () =>
    new Map<string, ThreadState>([
      ['$root', { participants: ['coding'], rootMentions: ['coding'], callers: {}, handoffs: {} }],
    ])
  function reply(o: {
    sender: string
    msgtype?: string
    mentions?: string[]
    handoff?: { caller: string; callee: string }
  }) {
    return {
      type: 'm.room.message',
      room_id: '!r:hs',
      sender: o.sender,
      content: {
        msgtype: o.msgtype ?? 'm.notice',
        body: 'reply',
        'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
        ...(o.mentions ? { 'm.mentions': { user_ids: o.mentions } } : {}),
        ...(o.handoff
          ? { [HANDOFF_FIELD]: { version: 1, call_id: 'c1', ...o.handoff } }
          : {}),
      },
    }
  }

  it('a rostered remote agent’s bare reply does not wake the last local poster', () => {
    const known = new Set([remoteProduct])
    expect(
      route(reply({ sender: remoteProduct, msgtype: 'm.text' }), [coding], states(), undefined, known),
    ).toEqual([])
  })

  it('an unrostered m.notice sender is still treated as an agent (bots post notices)', () => {
    expect(route(reply({ sender: remoteProduct }), [coding], states())).toEqual([])
  })

  it('a remote agent can still hand off, now via the handoff field', () => {
    const matches = route(
      reply({
        sender: remoteProduct,
        mentions: [coding.userId],
        handoff: { caller: remoteProduct, callee: coding.userId },
      }),
      [coding],
      states(),
      undefined,
      new Set([remoteProduct]),
    )
    expect(matches.map((m) => m.name)).toEqual(['coding'])
  })

  it('a human m.text bare reply still continues with the last local poster', () => {
    const matches = route(
      reply({ sender: '@beno:hs', msgtype: 'm.text' }),
      [coding],
      states(),
      undefined,
      new Set([remoteProduct]),
    )
    expect(matches.map((m) => m.name)).toEqual(['coding'])
  })

  it('a human @mention of a remote agent does not also wake the last local poster', () => {
    expect(
      route(
        reply({ sender: '@beno:hs', msgtype: 'm.text', mentions: [remoteProduct] }),
        [coding],
        states(),
        undefined,
        new Set([remoteProduct]),
      ),
    ).toEqual([])
  })

  it('a human bare reply after a remote agent posted last wakes no local agent', () => {
    const st = new Map<string, ThreadState>([
      [
        '$root',
        {
          participants: ['coding', remoteProduct],
          rootMentions: ['coding'],
          callers: {},
          handoffs: {},
        },
      ],
    ])
    expect(
      route(reply({ sender: '@beno:hs', msgtype: 'm.text' }), [coding], st, undefined, new Set([remoteProduct])),
    ).toEqual([])
  })

  it('a remote agent in a task thread does not steer the assignee', () => {
    expect(
      route(reply({ sender: remoteProduct }), [coding], states(), {
        assignee: 'coding',
        isRoot: false,
      }),
    ).toEqual([])
  })
})

describe('explicit handoff ([[ZOD092]])', () => {
  const mk = (name: string): AgentBinding => ({
    name,
    userId: `@${name}:example.com`,
    rooms: [{ alias: '!room1:example.com' }],
    trigger: 'mention',
  })
  const architect = mk('architect')
  const coding = mk('coding')
  const ux = mk('ux')
  const local = [architect, coding, ux]
  const REMOTE = '@cloud.product:example.com'
  const known = new Set([REMOTE])

  function msg(o: {
    sender: string
    body?: string
    mentions?: string[]
    handoff?: { caller: string; callee: string }
  }) {
    return {
      type: 'm.room.message',
      room_id: '!room1:example.com',
      sender: o.sender,
      event_id: '$e',
      content: {
        msgtype: 'm.notice',
        body: o.body ?? 'x',
        'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
        ...(o.mentions ? { 'm.mentions': { user_ids: o.mentions } } : {}),
        ...(o.handoff
          ? { [HANDOFF_FIELD]: { version: 1, call_id: 'c1', ...o.handoff } }
          : {}),
      },
    }
  }
  const states = (s: Partial<ThreadState> = {}) =>
    new Map([['$root', { participants: [], rootMentions: [], callers: {}, handoffs: {}, ...s }]])

  it("an agent's prose MXID calls nobody (relayed instructions are inert)", () => {
    const m = route(
      msg({ sender: '@architect:example.com', body: 'tell @ux:example.com to reply pong' }),
      local,
      states(),
    )
    expect(m).toEqual([])
  })

  it("an agent's m.mentions call nobody either", () => {
    const m = route(
      msg({ sender: '@architect:example.com', mentions: ['@coding:example.com'] }),
      local,
      states(),
    )
    expect(m).toEqual([])
  })

  it('a handoff event routes to its callee only — not to other agents it names', () => {
    const m = route(
      msg({
        sender: '@architect:example.com',
        body: '@coding:example.com then ask @ux:example.com for pong',
        mentions: ['@coding:example.com'],
        handoff: { caller: '@architect:example.com', callee: '@coding:example.com' },
      }),
      local,
      states(),
    )
    expect(m.map((a) => a.name)).toEqual(['coding'])
  })

  it('a handoff whose caller is not the sender routes nowhere (forged)', () => {
    const m = route(
      msg({
        sender: '@architect:example.com',
        handoff: { caller: '@ux:example.com', callee: '@coding:example.com' },
      }),
      local,
      states(),
    )
    expect(m).toEqual([])
  })

  it("a remote agent's handoff reaches our callee", () => {
    const m = route(
      msg({ sender: REMOTE, handoff: { caller: REMOTE, callee: '@coding:example.com' } }),
      local,
      states(),
      undefined,
      known,
    )
    expect(m.map((a) => a.name)).toEqual(['coding'])
  })

  it("a remote callee's bare reply is a return to our caller (edges keyed by MXID)", () => {
    const m = route(
      msg({ sender: REMOTE }),
      local,
      states({ callers: { [REMOTE]: '@architect:example.com' } }),
      undefined,
      known,
    )
    expect(m.map((a) => a.name)).toEqual(['architect'])
  })

  it('a human @mention still calls, unchanged', () => {
    const m = route(
      {
        ...msg({ sender: '@ori:example.com', mentions: ['@coding:example.com'] }),
        content: {
          msgtype: 'm.text',
          body: '@coding:example.com hi',
          'm.mentions': { user_ids: ['@coding:example.com'] },
          'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
        },
      },
      local,
      states(),
    )
    expect(m.map((a) => a.name)).toEqual(['coding'])
  })

  it('a daemon trigger post (m.text from an unrostered sender) still calls ([[ZOD081]])', () => {
    const m = route(
      {
        type: 'm.room.message',
        room_id: '!room1:example.com',
        sender: '@cloud.cron:example.com',
        event_id: '$e',
        content: {
          msgtype: 'm.text',
          body: '@coding:example.com run the nightly audit',
          'm.mentions': { user_ids: ['@coding:example.com'] },
        },
      },
      local,
      undefined,
      undefined,
      known,
    )
    expect(m.map((a) => a.name)).toEqual(['coding'])
  })

  it('a human raw-body MXID (no m.mentions) still calls, unchanged', () => {
    const m = route(
      {
        type: 'm.room.message',
        room_id: '!room1:example.com',
        sender: '@ori:example.com',
        event_id: '$e',
        content: {
          msgtype: 'm.text',
          body: '@coding:example.com hi',
          'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
        },
      },
      local,
      states(),
    )
    expect(m.map((a) => a.name)).toEqual(['coding'])
  })
})

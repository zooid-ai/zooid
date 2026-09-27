import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMatrixTransport } from '../src/transport.js'

const roomId = '!r:hs'
const GRACE = 90_000
const agent = (name: string) => ({
  name,
  userId: `@${name}:hs`,
  rooms: [{ alias: roomId }],
  trigger: 'mention' as const,
})
const bindings = [agent('architect'), agent('coding'), agent('ux')]

interface Emit {
  /** One assistant message (its own ACP messageId → its own Matrix message). */
  say(text: string): void
  /** One tool call; flushes buffered prose first, as a real turn does. */
  tool(title: string): void
  /** Blocks the turn until `release(name)` or an interrupt cancels it. */
  hold(): Promise<'released' | 'cancelled'>
  /** [[ZOD092]] The only way to call another agent. Resolves after the handoff is posted. */
  handoff(agent: string, prompt: string): Promise<unknown>
}
type Turn = (emit: Emit) => Promise<void> | void

interface Wire {
  type: string
  event_id: string
  sender: string
  content: Record<string, unknown>
}

function setup(
  scripts: Record<string, Turn[]>,
  timeline?: { root: unknown; thread: unknown[] },
) {
  const outbox: Wire[] = []
  const prompts: Array<{ name: string; threadId: string; text: string }> = []
  const turnCount = new Map<string, number>()
  const gates = new Map<string, (r: 'released' | 'cancelled') => void>()
  let n = 0
  let seq = 0
  let transport!: ReturnType<typeof createMatrixTransport>
  const registry = {
    ensureSession: vi.fn(async (name: string, threadId: string) => `sess:${name}:${threadId}`),
    endSession: vi.fn(),
    cancelSession: vi.fn(async (name: string) => {
      gates.get(name)?.('cancelled')
    }),
    stopAll: vi.fn(),
    hasAgent: vi.fn(() => true),
    hasContextSpawn: vi.fn(() => true),
    getApprovalTimeoutMs: vi.fn(() => 0),
    onApprovalRequest: vi.fn(),
    onEvent: vi.fn() as unknown as (name: string, event: unknown) => void,
    prompt: vi.fn(
      async (
        name: string,
        input: { threadId: string; contextThreadId: string; content: Array<{ text?: string }> },
      ) => {
        prompts.push({
          name,
          threadId: input.threadId,
          text: input.content.map((c) => c.text ?? '').join(''),
        })
        const i = turnCount.get(name) ?? 0
        turnCount.set(name, i + 1)
        const sessionId = `sess:${name}:${input.threadId}`
        let cancelled = false
        const emit: Emit = {
          say: (text) =>
            registry.onEvent(name, {
              type: 'agent_message_chunk',
              sessionId,
              messageId: `m${++seq}`,
              content: { type: 'text', text },
            }),
          tool: (title) =>
            registry.onEvent(name, {
              type: 'tool_call',
              sessionId,
              toolCallId: `t${++seq}`,
              title,
              kind: 'execute',
              status: 'pending',
            }),
          hold: () =>
            new Promise((resolve) =>
              gates.set(name, (r) => {
                gates.delete(name)
                if (r === 'cancelled') cancelled = true
                resolve(r)
              }),
            ),
          handoff: (agent, prompt) =>
            transport.taskActions.handoff(
              { agentName: name, channelId: roomId, threadRoot: input.contextThreadId, sessionKey: input.threadId },
              { agent, prompt },
            ),
        }
        await scripts[name]?.[i]?.(emit)
        return { stopReason: cancelled ? ('cancelled' as const) : ('end_turn' as const) }
      },
    ),
  }
  const client = {
    registerBot: vi.fn(),
    joinRoom: vi.fn(),
    leaveRoom: vi.fn(),
    setTyping: vi.fn(async () => {}),
    setPresence: vi.fn(async () => {}),
    // The homeserver echo: every outbound event comes back as an inbound one, in order.
    sendMessage: vi.fn(
      async (input: { asUserId: string; content: Record<string, unknown>; threadRoot?: string }) => {
        const event_id = `$${++n}`
        const content = input.threadRoot
          ? { ...input.content, 'm.relates_to': { rel_type: 'm.thread', event_id: input.threadRoot } }
          : input.content
        outbox.push({ type: 'm.room.message', event_id, sender: input.asUserId, content })
        return { event_id }
      },
    ),
    sendCustomEvent: vi.fn(
      async (input: { asUserId: string; eventType: string; content: Record<string, unknown> }) => {
        const event_id = `$${++n}`
        outbox.push({ type: input.eventType, event_id, sender: input.asUserId, content: input.content })
        return { event_id }
      },
    ),
    fetchEvent: vi.fn(async () => timeline?.root),
    fetchThreadRelations: vi.fn(async () => ({ chunk: timeline?.thread ?? [] })),
  }
  transport = createMatrixTransport({
    agents: registry as never,
    approvals: Object.assign(new EventEmitter(), {
      register: vi.fn(),
      resolve: vi.fn(),
      cancelSession: vi.fn(),
      listPending: vi.fn(),
    }) as never,
    client: client as never,
    bindings,
    hsToken: 'secret',
    drainQuietMs: 0,
    returnGraceMs: GRACE,
  })

  async function deliver(evt: Wire) {
    await transport.app.request(`/_matrix/app/v1/transactions/txn-${evt.event_id}`, {
      method: 'PUT',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ events: [{ ...evt, room_id: roomId }] }),
    })
  }
  async function settle() {
    for (let i = 0; i < 40; i++) {
      while (outbox.length) await deliver(outbox.shift()!)
      await new Promise((r) => setImmediate(r))
    }
  }
  const thread = (root: string) => ({ 'm.relates_to': { rel_type: 'm.thread', event_id: root } })

  return {
    registry,
    deliver,
    settle,
    of: (name: string) => prompts.filter((p) => p.name === name),
    release: (name: string) => gates.get(name)?.('released'),
    async advance(ms: number) {
      await vi.advanceTimersByTimeAsync(ms)
      await settle()
    },
    human: (event_id: string, body: string, o: { root?: string; mention?: string } = {}) =>
      deliver({
        type: 'm.room.message',
        event_id,
        sender: '@ori:hs',
        content: {
          msgtype: 'm.text',
          body,
          ...(o.mention ? { 'm.mentions': { user_ids: [o.mention] } } : {}),
          ...(o.root ? thread(o.root) : {}),
        },
      }),
    // Events from an agent's user that no turn in this process produced:
    // replayed after a restart, or someone posting as the bot.
    agentPosts: (name: string, event_id: string, body: string, root = '$root') =>
      deliver({
        type: 'm.room.message',
        event_id,
        sender: `@${name}:hs`,
        content: { msgtype: 'm.notice', body, ...thread(root) },
      }),
    agentTool: (name: string, event_id: string, root = '$root') =>
      deliver({
        type: 'dev.zooid.tool_call',
        event_id,
        sender: `@${name}:hs`,
        content: { tool_call_id: event_id, title: 'bash', ...thread(root) },
      }),
    agentTurnEnd: (name: string, event_id: string, root = '$root') =>
      deliver({
        type: 'dev.zooid.turn.end',
        event_id,
        sender: `@${name}:hs`,
        content: { agent_id: name, ...thread(root) },
      }),
  }
}

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }))
afterEach(() => vi.useRealTimers())

const kickoff = (h: ReturnType<typeof setup>) =>
  h.human('$root', '@architect:hs ship the login page', { mention: '@architect:hs' })

describe('handoff return timing ([[ZOD088]])', () => {
  it('A → B → C: a turn that delegates does not wake its caller; the result climbs one arc per turn', async () => {
    const h = setup({
      architect: [async (e) => void (await e.handoff('coding', 'build the login page')), (e) => e.say('merged, thanks')],
      coding: [
        async (e) => void (await e.handoff('ux', 'please test the login page')),
        (e) => e.say('done — PR #1 is ready'),
      ],
      ux: [
        (e) => {
          e.say('checked it')
          e.tool('browser')
          e.say('login works in both themes')
        },
      ],
    })
    await kickoff(h)
    await h.settle()

    expect(h.of('ux')).toHaveLength(1)
    expect(h.of('coding')).toHaveLength(2)
    const codingWake = h.of('coding')[1]!.text
    expect(codingWake).toMatch(/^\[handoff return\] from ux\n/)
    expect(codingWake).toContain('login works in both themes')
    expect(codingWake).not.toContain('checked it')

    // The whole fix: architect is woken exactly once after the kickoff.
    expect(h.of('architect')).toHaveLength(2)
    const architectWake = h.of('architect')[1]!.text
    expect(architectWake).toMatch(/^\[handoff return\] from coding\n/)
    expect(architectWake).toContain('done — PR #1 is ready')
    expect(architectWake).not.toContain('@ux:hs')
  })

  it('a callee running tools past the grace window does not wake its caller before its turn ends', async () => {
    const h = setup({
      architect: [async (e) => void (await e.handoff('coding', 'fix the flaky test')), () => {}],
      coding: [
        async (e) => {
          e.say('looking into it')
          e.tool('run tests')
          e.tool('read logs')
          await e.hold()
          e.say('fixed: the retry was racing the timer')
        },
      ],
    })
    await kickoff(h)
    await h.settle()
    await h.advance(5 * GRACE)
    expect(h.of('architect')).toHaveLength(1)

    h.release('coding')
    await h.settle()
    expect(h.of('architect')).toHaveLength(2)
    expect(h.of('architect')[1]!.text).toContain('fixed: the retry was racing the timer')
    expect(h.of('architect')[1]!.text).not.toContain('looking into it')
  })

  it("a human @mention of the caller does not cancel the callee's pending return", async () => {
    const h = setup({
      architect: [async (e) => void (await e.handoff('coding', 'migrate the db')), (e) => e.say('still on it'), () => {}],
      coding: [
        async (e) => {
          e.say('migration done')
          e.tool('verify')
          await e.hold()
        },
      ],
    })
    await kickoff(h)
    await h.settle()
    await h.human('$ping', '@architect:hs status?', { root: '$root', mention: '@architect:hs' })
    await h.settle()
    expect(h.of('architect')).toHaveLength(2)

    h.release('coding')
    await h.settle()
    expect(h.of('architect')).toHaveLength(3)
    expect(h.of('architect')[2]!.text).toBe('[handoff return] from coding\n\nmigration done')
  })

  it('grace fallback: a callee message with no turn behind it releases after the window, re-armed by tool activity', async () => {
    const h = setup({
      architect: [async (e) => void (await e.handoff('coding', 'look at this')), () => {}, () => {}],
      coding: [(e) => e.say('ack')],
    })
    await kickoff(h)
    await h.settle()
    expect(h.of('architect')).toHaveLength(2)

    await h.agentPosts('coding', '$late', 'late result')
    await h.advance(GRACE - 1_000)
    await h.agentTool('coding', '$late-tool')
    await h.advance(GRACE - 1_000)
    expect(h.of('architect')).toHaveLength(2)
    await h.advance(2_000)
    expect(h.of('architect')).toHaveLength(3)
    expect(h.of('architect')[2]!.text).toContain('late result')
  })

  it('an interrupt on the running callee releases its return, and the chain unwinds one arc per turn', async () => {
    const h = setup({
      architect: [async (e) => void (await e.handoff('coding', 'build it')), () => {}],
      coding: [
        async (e) => void (await e.handoff('ux', 'test it')),
        (e) => e.say('ux was interrupted; shipping what we have'),
      ],
      ux: [
        async (e) => {
          e.say('halfway through')
          e.tool('browser')
          await e.hold()
        },
      ],
    })
    await kickoff(h)
    await h.settle()
    expect(h.of('architect')).toHaveLength(1)

    await h.deliver({
      type: 'dev.zooid.interrupt',
      event_id: '$interrupt',
      sender: '@ori:hs',
      content: { 'm.relates_to': { rel_type: 'm.thread', event_id: '$root' } },
    })
    await h.settle()

    expect(h.registry.cancelSession).toHaveBeenCalledWith('ux', expect.any(String))
    expect(h.of('coding')).toHaveLength(2)
    expect(h.of('coding')[1]!.text).toMatch(/^\[handoff return\] from ux\n/)
    expect(h.of('coding')[1]!.text).toContain('halfway through')
    expect(h.of('architect')).toHaveLength(2)
    expect(h.of('architect')[1]!.text).toContain('shipping what we have')
  })

  it('after a restart, rebuilt call state never holds a return as delegated', async () => {
    const h = setup(
      { architect: [() => {}] },
      {
        root: {
          type: 'm.room.message',
          event_id: '$root',
          sender: '@ori:hs',
          content: {
            msgtype: 'm.text',
            body: '@architect:hs ship the login page',
            'm.mentions': { user_ids: ['@architect:hs'] },
          },
        },
        thread: [
          { type: 'm.room.message', event_id: '$a1', sender: '@architect:hs', content: { msgtype: 'm.notice', body: '@coding:hs build it', 'dev.zooid.handoff': { version: 1, call_id: 'a1', caller: '@architect:hs', callee: '@coding:hs' } } },
          { type: 'm.room.message', event_id: '$c1', sender: '@coding:hs', content: { msgtype: 'm.notice', body: '@ux:hs test it', 'dev.zooid.handoff': { version: 1, call_id: 'c1', caller: '@coding:hs', callee: '@ux:hs' } } },
        ],
      },
    )
    // Coding's pre-restart turn, replayed: nothing in this process ran it.
    await h.agentPosts('coding', '$c2', 'done — PR #1')
    await h.agentTurnEnd('coding', '$c2-end')
    await h.settle()
    expect(h.of('architect')).toHaveLength(1)
    expect(h.of('architect')[0]!.text).toBe('[handoff return] from coding\n\ndone — PR #1')
  })
})

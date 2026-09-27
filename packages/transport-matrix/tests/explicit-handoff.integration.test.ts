import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMatrixTransport } from '../src/transport.js'

const roomId = '!r:hs'
const spaceId = '!space:hs'
const GRACE = 90_000
const REMOTE_GRACE = 30 * 60_000

interface Emit {
  say(text: string): void
  tool(title: string): void
  hold(): Promise<'released' | 'cancelled'>
  handoff(agent: string, prompt: string): Promise<Record<string, unknown>>
}
type Turn = (emit: Emit) => Promise<void> | void
interface Wire {
  type: string
  event_id: string
  sender: string
  content: Record<string, unknown>
}

/**
 * A workforce of daemons sharing one homeserver. Each workstation has its own
 * transport, bindings and scripted agents; every event any daemon sends is
 * echoed, in order, to every daemon — the way Tuwunel fans a room out.
 */
function workforce(stations: Record<string, Record<string, Turn[]>>) {
  const bus: Wire[] = []
  const prompts: Array<{ name: string; threadId: string; text: string }> = []
  const gates = new Map<string, (r: 'released' | 'cancelled') => void>()
  let n = 0
  let seq = 0
  const mxid = (ws: string, name: string) => `@${ws}.${name}:hs`
  const rosters = Object.entries(stations).map(([ws, agents]) => ({
    type: 'dev.zooid.workforce',
    state_key: ws,
    content: {
      version: 1,
      agents: Object.keys(agents).map((name) => ({ user_id: mxid(ws, name), name, rooms: [roomId] })),
    },
  }))
  const daemons = Object.entries(stations).map(([ws, scripts]) => {
    const bindings = Object.keys(scripts).map((name) => ({
      name,
      userId: mxid(ws, name),
      rooms: [{ alias: roomId }],
      trigger: 'mention' as const,
    }))
    const turnCount = new Map<string, number>()
    let transport!: ReturnType<typeof createMatrixTransport>
    const registry = {
      ensureSession: vi.fn(async (name: string, threadId: string) => `sess:${ws}:${name}:${threadId}`),
      endSession: vi.fn(),
      cancelSession: vi.fn(async (name: string) => gates.get(`${ws}.${name}`)?.('cancelled')),
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
          prompts.push({ name, threadId: input.threadId, text: input.content.map((c) => c.text ?? '').join('') })
          const i = turnCount.get(name) ?? 0
          turnCount.set(name, i + 1)
          const sessionId = `sess:${ws}:${name}:${input.threadId}`
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
                gates.set(`${ws}.${name}`, (r) => {
                  gates.delete(`${ws}.${name}`)
                  if (r === 'cancelled') cancelled = true
                  resolve(r)
                }),
              ),
            handoff: (agent, prompt) =>
              transport.taskActions.handoff(
                { agentName: name, channelId: roomId, threadRoot: input.contextThreadId, sessionKey: input.threadId },
                { agent, prompt },
              ) as Promise<Record<string, unknown>>,
          }
          await scripts[name]?.[i]?.(emit)
          return { stopReason: cancelled ? ('cancelled' as const) : ('end_turn' as const) }
        },
      ),
    }
    const client = {
      registerBot: vi.fn(async () => {}),
      joinRoom: vi.fn(async () => {}),
      leaveRoom: vi.fn(async () => {}),
      setTyping: vi.fn(async () => {}),
      setPresence: vi.fn(async () => {}),
      setDisplayName: vi.fn(async () => {}),
      invite: vi.fn(async () => {}),
      sendStateEvent: vi.fn(async () => ({ event_id: '$s' })),
      fetchRoomState: vi.fn(async () => rosters),
      sendMessage: vi.fn(
        async (i: { asUserId: string; content: Record<string, unknown>; threadRoot?: string }) => {
          const event_id = `$${++n}`
          const content = i.threadRoot
            ? { ...i.content, 'm.relates_to': { rel_type: 'm.thread', event_id: i.threadRoot } }
            : i.content
          bus.push({ type: 'm.room.message', event_id, sender: i.asUserId, content })
          return { event_id }
        },
      ),
      sendCustomEvent: vi.fn(
        async (i: { asUserId: string; eventType: string; content: Record<string, unknown> }) => {
          const event_id = `$${++n}`
          bus.push({ type: i.eventType, event_id, sender: i.asUserId, content: i.content })
          return { event_id }
        },
      ),
      fetchEvent: vi.fn(async () => undefined),
      fetchThreadRelations: vi.fn(async () => ({ chunk: [] })),
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
      remoteReturnGraceMs: REMOTE_GRACE,
    })
    return { ws, transport, registry, client }
  })

  async function deliver(evt: Wire) {
    for (const d of daemons)
      await d.transport.app.request(`/_matrix/app/v1/transactions/txn-${d.ws}-${evt.event_id}`, {
        method: 'PUT',
        headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
        body: JSON.stringify({ events: [{ ...evt, room_id: roomId }] }),
      })
  }
  async function settle() {
    for (let i = 0; i < 60; i++) {
      while (bus.length) await deliver(bus.shift()!)
      await new Promise((r) => setImmediate(r))
    }
  }
  return {
    daemons,
    deliver,
    settle,
    async boot() {
      for (const d of daemons) await d.transport.bootstrap({ spaceRoomId: spaceId, asUserId: '@zooid:hs' })
    },
    of: (name: string) => prompts.filter((p) => p.name === name),
    release: (key: string) => gates.get(key)?.('released'),
    async advance(ms: number) {
      await vi.advanceTimersByTimeAsync(ms)
      await settle()
    },
    wire: () => bus,
    human: (event_id: string, body: string, mention: string, root?: string) =>
      deliver({
        type: 'm.room.message',
        event_id,
        sender: '@ori:hs',
        content: {
          msgtype: 'm.text',
          body,
          'm.mentions': { user_ids: [mention] },
          ...(root ? { 'm.relates_to': { rel_type: 'm.thread', event_id: root } } : {}),
        },
      }),
    turnEnd: (sender: string, event_id: string, root = '$root') =>
      deliver({
        type: 'dev.zooid.turn.end',
        event_id,
        sender,
        content: { agent_id: 'product', 'm.relates_to': { rel_type: 'm.thread', event_id: root } },
      }),
  }
}

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }))
afterEach(() => vi.useRealTimers())

describe('explicit handoff ([[ZOD092]])', () => {
  it('relayed instructions naming a third agent wake only the callee', async () => {
    const w = workforce({
      laptop: {
        architect: [async (e) => void (await e.handoff('coding', 'build it, then ask @laptop.ux:hs for pong')), () => {}],
        coding: [(e) => e.say('built. I mentioned @laptop.ux:hs in passing')],
        ux: [],
      },
    })
    await w.boot()
    await w.human('$root', '@laptop.architect:hs go', '@laptop.architect:hs')
    await w.settle()
    expect(w.of('coding')).toHaveLength(1)
    expect(w.of('ux')).toHaveLength(0)
    expect(w.of('architect')).toHaveLength(2)
    expect(w.of('architect')[1]!.text).toBe('[handoff return] from coding\n\nbuilt. I mentioned @laptop.ux:hs in passing')
  })

  it('the handoff is posted in the caller thread, after the caller prose, with structured call metadata', async () => {
    const w = workforce({
      laptop: {
        architect: [
          async (e) => {
            e.say('handing this to coding')
            await e.handoff('coding', 'build it')
          },
        ],
        coding: [],
      },
    })
    await w.boot()
    await w.human('$root', '@laptop.architect:hs go', '@laptop.architect:hs')
    await w.settle()
    const all = w.daemons[0]!.client.sendMessage.mock.calls.map((c) => c[0]) as Array<{
      threadRoot?: string
      content: Record<string, unknown>
    }>
    const prose = all.findIndex((c) => c.content.body === 'handing this to coding')
    const call = all.findIndex((c) => c.content['dev.zooid.handoff'] !== undefined)
    expect(prose).toBeGreaterThanOrEqual(0)
    expect(call).toBeGreaterThan(prose)
    expect(all[call]!.threadRoot).toBe('$root')
    expect(all[call]!.content['dev.zooid.handoff']).toMatchObject({
      version: 1,
      caller: '@laptop.architect:hs',
      callee: '@laptop.coding:hs',
    })
    expect(all[call]!.content['m.mentions']).toEqual({ user_ids: ['@laptop.coding:hs'] })
  })

  it('refuses a second open handoff in the same thread and points at task threads', async () => {
    let second: Record<string, unknown> | undefined
    const w = workforce({
      laptop: {
        architect: [
          async (e) => {
            await e.handoff('coding', 'part one')
            second = await e.handoff('ux', 'part two')
          },
        ],
        coding: [async (e) => void (await e.hold())],
        ux: [],
      },
    })
    await w.boot()
    await w.human('$root', '@laptop.architect:hs go', '@laptop.architect:hs')
    await w.settle()
    expect(second).toMatchObject({ status: 'refused' })
    expect(String(second!.reason)).toMatch(/zooid_start_task_threads/)
    expect(w.of('ux')).toHaveLength(0)
  })

  it('refuses a handoff back up the chain and says the result returns automatically', async () => {
    let back: Record<string, unknown> | undefined
    const w = workforce({
      laptop: {
        architect: [async (e) => void (await e.handoff('coding', 'build it'))],
        coding: [
          async (e) => {
            back = await e.handoff('architect', 'done?')
          },
        ],
      },
    })
    await w.boot()
    await w.human('$root', '@laptop.architect:hs go', '@laptop.architect:hs')
    await w.settle()
    expect(back).toMatchObject({ status: 'refused' })
    expect(String(back!.reason)).toMatch(/returns to architect automatically/)
  })

  it('cross-workstation: A (laptop) → B (cloud) → C (laptop); A wakes once, after B is really done', async () => {
    const w = workforce({
      laptop: {
        architect: [async (e) => void (await e.handoff('product', 'smoke test')), () => {}],
        cpo: [(e) => e.say('pong')],
      },
      cloud: {
        product: [
          async (e) => {
            e.say('running sleep 100')
            e.tool('sleep 100')
            await e.hold() // the long tool call: one tool_call, then silence
            await e.handoff('cpo', 'reply with exactly: pong')
          },
          (e) => e.say('product done'),
        ],
      },
    })
    await w.boot()
    await w.human('$root', '@laptop.architect:hs go', '@laptop.architect:hs')
    await w.settle()
    expect(w.of('product')).toHaveLength(1)

    // Well past the local 90s window: a remote turn this daemon cannot see.
    await w.advance(5 * GRACE)
    expect(w.of('architect')).toHaveLength(1)

    w.release('cloud.product')
    await w.settle()

    expect(w.of('cpo')).toHaveLength(1)
    expect(w.of('cpo')[0]!.text).toContain('reply with exactly: pong')
    // cpo's return crossed back to product on the cloud daemon.
    expect(w.of('product')).toHaveLength(2)
    expect(w.of('product')[1]!.text).toBe('[handoff return] from cpo\n\npong')
    // And product's return crossed to architect on the laptop — exactly once.
    expect(w.of('architect')).toHaveLength(2)
    expect(w.of('architect')[1]!.text).toBe('[handoff return] from product\n\nproduct done')
  })

  it("cross-workstation fallback: a remote callee's dead daemon releases after the remote window, re-armed by its tool activity", async () => {
    const w = workforce({
      laptop: { architect: [async (e) => void (await e.handoff('product', 'go')), () => {}] },
      cloud: { product: [async (e) => {
        e.say('working')
        e.tool('build')
        await e.hold() // never released: the cloud daemon "died"
      }] },
    })
    await w.boot()
    await w.human('$root', '@laptop.architect:hs go', '@laptop.architect:hs')
    await w.settle()
    await w.advance(REMOTE_GRACE - 1_000)
    await w.deliver({
      type: 'dev.zooid.tool_call',
      event_id: '$late-tool',
      sender: '@cloud.product:hs',
      content: { tool_call_id: 'late', title: 'bash', 'm.relates_to': { rel_type: 'm.thread', event_id: '$root' } },
    })
    await w.advance(REMOTE_GRACE - 1_000)
    expect(w.of('architect')).toHaveLength(1)
    await w.advance(2_000)
    expect(w.of('architect')).toHaveLength(2)
    expect(w.of('architect')[1]!.text).toBe('[handoff return] from product\n\nworking')
  })

  it("a turn.end from someone other than the callee releases nothing (sender-authenticated)", async () => {
    const w = workforce({
      laptop: { architect: [async (e) => void (await e.handoff('product', 'go')), () => {}] },
      cloud: { product: [async (e) => {
        e.say('working')
        await e.hold()
      }] },
    })
    await w.boot()
    await w.human('$root', '@laptop.architect:hs go', '@laptop.architect:hs')
    await w.settle()
    // Forged: claims agent_id "product" but is sent by a human.
    await w.turnEnd('@ori:hs', '$forged')
    await w.settle()
    expect(w.of('architect')).toHaveLength(1)
  })
})

import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { ElicitationCorrelator } from '@zooid/core'
import type { ElicitationResponse } from '@zooid/acp-client'
import { createMatrixTransport } from './transport.js'

const ROOM = '!r:example.com'
const AGENT = '@architect:example.com'
const ALICE = '@alice:example.com'
const schema = {
  type: 'object' as const,
  properties: { env: { type: 'string' as const, enum: ['staging', 'prod'] } },
  required: ['env'],
}
type Asker = (name: string, req: unknown, signal: AbortSignal) => Promise<ElicitationResponse>
type Gate = { release: (r?: { stopReason: string }) => void; fail: (e: Error) => void }

function setup(o: { failPublish?: number } = {}) {
  const gates = new Map<string, Gate>() // by thread root / session key
  const reg = {
    hasAgent: vi.fn(() => true),
    ensureSession: vi.fn(async (_n: string, threadId: string) => `sess-${threadId}`),
    endSession: vi.fn(async () => {}),
    cancelSession: vi.fn(async (_n: string, sessionId: string) => {
      gates.get(sessionId.replace(/^sess-/, ''))?.release({ stopReason: 'cancelled' })
    }),
    prompt: vi.fn(
      (_n: string, p: { threadId: string }) =>
        new Promise((resolve, reject) =>
          gates.set(p.threadId, { release: (r = { stopReason: 'end_turn' }) => resolve(r), fail: reject }),
        ),
    ),
    stopAll: vi.fn(async () => {}),
    getApprovalTimeoutMs: vi.fn(() => 0),
    onEvent: vi.fn() as unknown as (n: string, e: unknown) => void,
    onApprovalRequest: vi.fn(async () => ({ decision: 'cancel' as const })),
    onElicitationRequest: undefined as Asker | undefined,
  }
  const approvals = Object.assign(new EventEmitter(), {
    register: vi.fn(), resolve: vi.fn(() => true), cancelSession: vi.fn(), listPending: vi.fn(() => []),
  })
  let n = 0
  let publishFailures = o.failPublish ?? 0
  const client = {
    registerBot: vi.fn(async () => undefined),
    joinRoom: vi.fn(async () => undefined),
    leaveRoom: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => ({ event_id: `$msg${++n}` })),
    sendCustomEvent: vi.fn(async (i: { eventType: string }) => {
      if (i.eventType === 'dev.zooid.elicitation_request' && publishFailures > 0) {
        publishFailures--
        throw new Error('sendEvent failed: 502')
      }
      return { event_id: i.eventType === 'dev.zooid.elicitation_request' ? '$ereq' : `$ev${++n}` }
    }),
    setTyping: vi.fn(async () => {}),
    setPresence: vi.fn(async () => {}),
    getJoinedMembers: vi.fn(async () => ({ joined: { [AGENT]: {}, [ALICE]: {} } })),
  }
  const elicitations = new ElicitationCorrelator()
  const transport = createMatrixTransport({
    agents: reg as never,
    approvals: approvals as never,
    client: client as never,
    bindings: [{ name: 'architect', userId: AGENT, rooms: [{ alias: ROOM }], trigger: 'mention' as const }],
    hsToken: 'hs',
    botUserId: '@zooid:example.com',
    drainQuietMs: 0,
    elicitations,
    elicitationRetryDelayMs: 0,
  })
  return { transport, reg, client, gates, elicitations }
}
type Setup = ReturnType<typeof setup>

let txn = 0
let evn = 0
const post = (s: Setup, events: unknown[]) =>
  s.transport.app.request(`/_matrix/app/v1/transactions/ty${++txn}`, {
    method: 'PUT',
    headers: { Authorization: 'Bearer hs', 'content-type': 'application/json' },
    body: JSON.stringify({ events }),
  })
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r))
}
async function mention(s: Setup, root: string) {
  await post(s, [{
    type: 'm.room.message', event_id: root, room_id: ROOM, sender: ALICE, origin_server_ts: Date.now(),
    content: { msgtype: 'm.text', body: 'go', 'm.mentions': { user_ids: [AGENT] } },
  }])
  await settle()
}
function ask(s: Setup, root: string) {
  const controller = new AbortController()
  const response = s.reg.onElicitationRequest!(
    'architect',
    { sessionId: `sess-${root}`, toolCallId: 'tc1', message: 'Which env?', requestedSchema: schema },
    controller.signal,
  )
  response.catch(() => {}) // some tests end the wait by failure
  return { response, controller }
}
async function answer(s: Setup, root: string) {
  const req = s.client.sendCustomEvent.mock.calls
    .map((c) => c[0] as { eventType: string; content: Record<string, unknown> })
    .filter((i) => i.eventType === 'dev.zooid.elicitation_request')
    .at(-1)!
  await post(s, [{
    type: 'dev.zooid.elicitation_response', event_id: `$resp${++evn}`, room_id: ROOM, sender: ALICE,
    content: {
      version: 1, request_id: req.content.request_id, request_event_id: '$ereq', action: 'accept',
      content: { env: 'prod' }, 'm.relates_to': { rel_type: 'm.thread', event_id: root },
    },
  }])
  await settle()
}
const typing = (s: Setup) =>
  s.client.setTyping.mock.calls
    .map((c) => c[0] as { asUserId: string; typing: boolean })
    .filter((c) => c.asUserId === AGENT)
    .map((c) => c.typing)
const presence = (s: Setup) =>
  s.client.setPresence.mock.calls
    .map((c) => c[0] as { asUserId: string; presence: string })
    .filter((c) => c.asUserId === AGENT)
    .map((c) => c.presence)

describe('transport — typing is the room aggregate of in-flight turns (ZOD091)', () => {
  it('two turns in one room raise once and lower when the last one ends', async () => {
    const s = setup()
    await mention(s, '$a')
    await mention(s, '$b')
    expect(typing(s)).toEqual([true])
    expect(presence(s)).toEqual(['unavailable'])
    s.gates.get('$a')!.release()
    await settle()
    expect(typing(s)).toEqual([true]) // $b still working
    expect(presence(s)).toEqual(['unavailable'])
    s.gates.get('$b')!.release()
    await settle()
    expect(typing(s)).toEqual([true, false])
    expect(presence(s)).toEqual(['unavailable', 'online'])
  })

  it('a failed turn releases without clearing a sibling', async () => {
    const s = setup()
    await mention(s, '$a')
    await mention(s, '$b')
    s.gates.get('$a')!.fail(new Error('boom'))
    await settle()
    expect(typing(s)).toEqual([true])
    s.gates.get('$b')!.release()
    await settle()
    expect(typing(s)).toEqual([true, false])
  })

  it('an interrupted turn releases', async () => {
    const s = setup()
    await mention(s, '$a')
    await post(s, [{
      type: 'dev.zooid.interrupt', event_id: '$int1', room_id: ROOM, sender: ALICE,
      content: { session_id: 'sess-$a' },
    }])
    await settle()
    expect(s.reg.cancelSession).toHaveBeenCalledWith('architect', 'sess-$a')
    expect(typing(s)).toEqual([true, false])
    expect(presence(s)).toEqual(['unavailable', 'online'])
  })

  it('a harness execution limit releases', async () => {
    const s = setup()
    await mention(s, '$a')
    s.gates.get('$a')!.release({ stopReason: 'max_tokens' })
    await settle()
    expect(typing(s)).toEqual([true, false])
  })

  it('raises before the prompt and lowers before turn.end', async () => {
    const s = setup()
    await mention(s, '$a')
    s.gates.get('$a')!.release()
    await settle()
    const raiseAt = s.client.setTyping.mock.invocationCallOrder[0]!
    const lowerAt = s.client.setTyping.mock.invocationCallOrder.at(-1)!
    const turnEndIdx = s.client.sendCustomEvent.mock.calls.findIndex(
      (c) => (c[0] as { eventType: string }).eventType === 'dev.zooid.turn.end',
    )
    expect(raiseAt).toBeLessThan(s.reg.prompt.mock.invocationCallOrder[0]!)
    expect(lowerAt).toBeLessThan(s.client.sendCustomEvent.mock.invocationCallOrder[turnEndIdx]!)
  })

  describe('human wait', () => {
    it('a sole waiting turn lowers; the answer re-raises; the end lowers', async () => {
      const s = setup()
      await mention(s, '$a')
      ask(s, '$a')
      await settle()
      expect(typing(s)).toEqual([true, false])
      expect(presence(s)).toEqual(['unavailable', 'online'])
      await answer(s, '$a')
      expect(typing(s)).toEqual([true, false, true])
      expect(presence(s)).toEqual(['unavailable', 'online', 'unavailable'])
      s.gates.get('$a')!.release()
      await settle()
      expect(typing(s)).toEqual([true, false, true, false])
    })

    it('a waiting turn with a sibling working sends nothing', async () => {
      const s = setup()
      await mention(s, '$a')
      await mention(s, '$b')
      ask(s, '$a')
      await settle()
      expect(typing(s)).toEqual([true])
      await answer(s, '$a')
      expect(typing(s)).toEqual([true])
      expect(presence(s)).toEqual(['unavailable'])
    })

    it('a card that could not be published still resumes typing', async () => {
      const s = setup({ failPublish: 3 })
      await mention(s, '$a')
      const { response } = ask(s, '$a')
      await expect(response).rejects.toThrow(/could not publish/)
      await settle()
      expect(typing(s)).toEqual([true, false, true])
    })

    it('a wait that ends after its turn ended does not re-raise', async () => {
      const s = setup()
      await mention(s, '$a')
      const { controller } = ask(s, '$a')
      await settle()
      s.gates.get('$a')!.release() // turn ends while the question is open
      await settle()
      expect(typing(s)).toEqual([true, false])
      controller.abort() // the wait ends late
      await settle()
      expect(typing(s)).toEqual([true, false])
    })
  })
})

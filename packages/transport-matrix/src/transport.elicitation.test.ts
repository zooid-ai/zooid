import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { ElicitationCorrelator } from '@zooid/core'
import { ElicitationUnsupportedError, type ElicitationResponse } from '@zooid/acp-client'
import { createMatrixTransport } from './transport.js'

const ROOM = '!r:example.com'
const AGENT = '@architect:example.com'
const CODER = '@coder:example.com'
const ALICE = '@alice:example.com'
const BOB = '@bob:example.com'
const schema = {
  type: 'object' as const,
  properties: { env: { type: 'string' as const, enum: ['staging', 'prod'] } },
  required: ['env'],
}

type Asker = (name: string, req: unknown, signal: AbortSignal) => Promise<ElicitationResponse>

function setup(o: { members?: string[]; failPublish?: number } = {}) {
  let release!: () => void
  const turnGate = new Promise<void>((r) => (release = r))
  const reg = {
    hasAgent: vi.fn(() => true),
    ensureSession: vi.fn(async (_n: string, threadId: string) => `sess-${threadId}`),
    endSession: vi.fn(),
    cancelSession: vi.fn(async () => {}),
    prompt: vi.fn(async () => {
      await turnGate
      return { stopReason: 'end_turn' as const }
    }),
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
      if (i.eventType === 'dev.zooid.elicitation_request') {
        if (publishFailures > 0) {
          publishFailures--
          throw new Error('sendEvent failed: 502')
        }
        return { event_id: '$ereq' }
      }
      return { event_id: `$ev${++n}` }
    }),
    setTyping: vi.fn(async () => {}),
    setPresence: vi.fn(async () => {}),
    getJoinedMembers: vi.fn(async () => ({
      joined: Object.fromEntries((o.members ?? [AGENT, CODER, ALICE, BOB]).map((m) => [m, {}])),
    })),
  }
  const elicitations = new ElicitationCorrelator()
  const transport = createMatrixTransport({
    agents: reg as never,
    approvals: approvals as never,
    client: client as never,
    bindings: [
      { name: 'architect', userId: AGENT, rooms: [{ alias: ROOM }], trigger: 'mention' as const },
      { name: 'coder', userId: CODER, rooms: [{ alias: ROOM }], trigger: 'mention' as const },
    ],
    hsToken: 'hs',
    botUserId: '@zooid:example.com',
    drainQuietMs: 0,
    elicitations,
    elicitationRetryDelayMs: 0,
  })
  return { transport, reg, client, elicitations, finishTurn: () => release() }
}

let txn = 0
let evn = 0
type Setup = ReturnType<typeof setup>
const post = (s: Setup, events: unknown[]) =>
  s.transport.app.request(`/_matrix/app/v1/transactions/t${++txn}`, {
    method: 'PUT',
    headers: { Authorization: 'Bearer hs', 'content-type': 'application/json' },
    body: JSON.stringify({ events }),
  })
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r))
}
async function startTurn(s: Setup, root = '$root') {
  await post(s, [{
    type: 'm.room.message', event_id: root, room_id: ROOM, sender: ALICE,
    content: { msgtype: 'm.text', body: 'deploy it', 'm.mentions': { user_ids: [AGENT] } },
  }])
  await settle()
}
function ask(s: Setup, o: { session?: string; agent?: string; toolCallId?: string; schema?: unknown } = {}) {
  const controller = new AbortController()
  const response = s.reg.onElicitationRequest!(
    o.agent ?? 'architect',
    {
      sessionId: o.session ?? 'sess-$root',
      toolCallId: o.toolCallId ?? 'tc1',
      message: 'Which env?',
      requestedSchema: o.schema ?? schema,
    },
    controller.signal,
  )
  return { response, controller }
}
function respond(
  s: Setup,
  o: { requestId: string; sender?: string; action?: string; content?: unknown; room?: string; root?: string; requestEventId?: string },
) {
  const eventId = `$resp${++evn}`
  const p = post(s, [{
    type: 'dev.zooid.elicitation_response', event_id: eventId, room_id: o.room ?? ROOM, sender: o.sender ?? ALICE,
    content: {
      version: 1, request_id: o.requestId, request_event_id: o.requestEventId ?? '$ereq',
      action: o.action ?? 'accept', ...(o.content !== undefined ? { content: o.content } : {}),
      'm.relates_to': { rel_type: 'm.thread', event_id: o.root ?? '$root' },
    },
  }])
  return { p, eventId }
}
const sent = (s: Setup, type: string) =>
  s.client.sendCustomEvent.mock.calls
    .map((c) => c[0] as { eventType: string; content: Record<string, unknown>; txnId?: string; asUserId: string })
    .filter((i) => i.eventType === type)
const requestIdOf = (s: Setup, i = 0) => sent(s, 'dev.zooid.elicitation_request')[i]!.content.request_id as string

describe('Matrix transport — elicitation loop', () => {
  it('installs the handler on the registry at construction', () => {
    const s = setup()
    expect(s.reg.onElicitationRequest).toBeTypeOf('function')
  })

  it('publishes a threaded request card as the agent, after flushing buffered prose', async () => {
    const s = setup()
    await startTurn(s)
    s.reg.onEvent('architect', {
      type: 'agent_message_chunk', sessionId: 'sess-$root', content: { type: 'text', text: 'Before I deploy:' },
    })
    ask(s)
    await settle()
    const [req] = sent(s, 'dev.zooid.elicitation_request')
    expect(req).toMatchObject({
      asUserId: AGENT,
      content: {
        version: 1, session_id: 'sess-$root', tool_call_id: 'tc1', message: 'Which env?',
        requested_schema: schema,
        'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
      },
    })
    expect(req!.txnId).toBe(`elicit-req-${req!.content.request_id}`)
    const msgOrder = s.client.sendMessage.mock.invocationCallOrder[0]!
    const cardOrder = s.client.sendCustomEvent.mock.invocationCallOrder.find(
      (_o, i) => (s.client.sendCustomEvent.mock.calls[i]![0] as { eventType: string }).eventType === 'dev.zooid.elicitation_request',
    )!
    expect(msgOrder).toBeLessThan(cardOrder)
    expect(s.client.setTyping).toHaveBeenLastCalledWith(expect.objectContaining({ asUserId: AGENT, typing: false }))
    expect(s.elicitations.countFor('$root')).toBe(1)
  })

  it('resolves the waiting request directly: no new prompt, no new session', async () => {
    const s = setup()
    await startTurn(s)
    const { response } = ask(s)
    await settle()
    await respond(s, { requestId: requestIdOf(s), content: { env: 'prod' } }).p
    await expect(response).resolves.toEqual({ action: 'accept', content: { env: 'prod' } })
    expect(s.reg.prompt).toHaveBeenCalledTimes(1)
    expect(s.reg.ensureSession).toHaveBeenCalledTimes(1)
    await settle()
    expect(sent(s, 'dev.zooid.elicitation_resolved')[0]).toMatchObject({
      asUserId: AGENT,
      txnId: `elicit-res-${requestIdOf(s)}`,
      content: {
        request_id: requestIdOf(s), request_event_id: '$ereq', status: 'accepted', responded_by: ALICE,
        'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
      },
    })
    expect(s.elicitations.countFor('$root')).toBe(0)
  })

  it('reaches the waiting turn even while a follow-up turn is queued behind it', async () => {
    const s = setup()
    await startTurn(s)
    const { response } = ask(s)
    await settle()
    // A human follow-up in the same thread queues a new turn behind the active one.
    await post(s, [{
      type: 'm.room.message', event_id: '$follow', room_id: ROOM, sender: BOB,
      content: {
        msgtype: 'm.text', body: '@architect also check logs', 'm.mentions': { user_ids: [AGENT] },
        'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
      },
    }])
    await settle()
    await respond(s, { requestId: requestIdOf(s), content: { env: 'staging' } }).p
    await expect(response).resolves.toEqual({ action: 'accept', content: { env: 'staging' } })
    expect(s.reg.prompt).toHaveBeenCalledTimes(1) // the queued turn has not started
  })

  it('maps Skip to decline and Cancel to cancel', async () => {
    const s = setup()
    await startTurn(s)
    const a = ask(s, { toolCallId: 'a' })
    const b = ask(s, { toolCallId: 'b' })
    await settle()
    await respond(s, { requestId: requestIdOf(s, 0), action: 'decline' }).p
    await respond(s, { requestId: requestIdOf(s, 1), action: 'cancel' }).p
    await expect(a.response).resolves.toEqual({ action: 'decline' })
    await expect(b.response).resolves.toEqual({ action: 'cancel' })
    await settle()
    expect(sent(s, 'dev.zooid.elicitation_resolved').map((e) => e.content.status)).toEqual(['declined', 'cancelled'])
  })

  it('keeps invalid answers pending and sends field feedback', async () => {
    const s = setup()
    await startTurn(s)
    const { response } = ask(s)
    await settle()
    const id = requestIdOf(s)
    const bad = respond(s, { requestId: id, content: { env: 'dev', extra: 1 } })
    await bad.p
    await settle()
    expect(sent(s, 'dev.zooid.elicitation_rejected')[0]).toMatchObject({
      asUserId: AGENT,
      content: {
        request_id: id, response_event_id: bad.eventId, reason: 'invalid',
        errors: { env: 'must be one of: staging, prod', extra: 'unknown field' },
      },
    })
    expect(s.elicitations.get(id)?.state).toBe('pending')
    await respond(s, { requestId: id, content: { env: 'prod' } }).p
    await expect(response).resolves.toEqual({ action: 'accept', content: { env: 'prod' } })
  })

  it.each([
    ['the agent itself', { sender: AGENT }],
    ['another bound agent', { sender: CODER }],
    ['the AS sender bot', { sender: '@zooid:example.com' }],
    ['a non-member', { sender: '@eve:example.com' }],
    ['another room', { room: '!other:example.com' }],
    ['another thread', { root: '$elsewhere' }],
    ['a different request event', { requestEventId: '$forged' }],
  ])('ignores a response from %s', async (_label, over) => {
    const s = setup()
    await startTurn(s)
    ask(s)
    await settle()
    const id = requestIdOf(s)
    await respond(s, { requestId: id, content: { env: 'prod' }, ...over }).p
    await settle()
    expect(s.elicitations.get(id)?.state).toBe('pending')
    expect(sent(s, 'dev.zooid.elicitation_resolved')).toHaveLength(0)
    expect(sent(s, 'dev.zooid.elicitation_rejected')).toHaveLength(0)
  })

  it('first valid response wins; a later one gets stale feedback', async () => {
    const s = setup()
    await startTurn(s)
    const { response } = ask(s)
    await settle()
    const id = requestIdOf(s)
    const first = respond(s, { requestId: id, sender: ALICE, content: { env: 'prod' } })
    const second = respond(s, { requestId: id, sender: BOB, content: { env: 'staging' } })
    await Promise.all([first.p, second.p])
    await expect(response).resolves.toEqual({ action: 'accept', content: { env: 'prod' } })
    await settle()
    expect(sent(s, 'dev.zooid.elicitation_resolved')).toHaveLength(1)
    expect(sent(s, 'dev.zooid.elicitation_rejected')[0]).toMatchObject({
      content: { request_id: id, response_event_id: second.eventId, reason: 'stale' },
    })
  })

  it('an answer to one request never wakes another (two sessions, two requests)', async () => {
    const s = setup()
    await startTurn(s, '$root')
    await startTurn(s, '$root2')
    const a = ask(s, { session: 'sess-$root' })
    const b = ask(s, { session: 'sess-$root2' })
    await settle()
    await respond(s, { requestId: requestIdOf(s, 1), root: '$root2', content: { env: 'prod' } }).p
    await expect(b.response).resolves.toEqual({ action: 'accept', content: { env: 'prod' } })
    expect(s.elicitations.get(requestIdOf(s, 0))?.state).toBe('pending')
    expect(s.elicitations.countFor('$root')).toBe(1)
    void a
  })

  it('ACP-side cancellation (signal abort) closes the card', async () => {
    const s = setup()
    await startTurn(s)
    const { response, controller } = ask(s)
    await settle()
    controller.abort()
    await expect(response).resolves.toEqual({ action: 'cancel' })
    await settle()
    expect(sent(s, 'dev.zooid.elicitation_resolved')[0]).toMatchObject({
      content: { status: 'cancelled', reason: 'agent_cancelled' },
    })
    await respond(s, { requestId: requestIdOf(s), content: { env: 'prod' } }).p
    await settle()
    expect(sent(s, 'dev.zooid.elicitation_rejected')[0]).toMatchObject({ content: { reason: 'stale' } })
  })

  it('/clear cancels open questions and their turn before ending the session', async () => {
    const s = setup()
    await startTurn(s)
    const { response } = ask(s)
    await settle()
    await post(s, [{
      type: 'dev.zooid.session_reset', event_id: '$reset', room_id: ROOM, sender: ALICE,
      content: { 'm.relates_to': { rel_type: 'm.thread', event_id: '$root' } },
    }])
    await expect(response).resolves.toEqual({ action: 'cancel' })
    expect(s.reg.cancelSession).toHaveBeenCalledWith('architect', 'sess-$root')
    const cancelOrder = s.reg.cancelSession.mock.invocationCallOrder[0]!
    const endOrder = s.reg.endSession.mock.invocationCallOrder[0]!
    expect(cancelOrder).toBeLessThan(endOrder)
    await settle()
    expect(sent(s, 'dev.zooid.elicitation_resolved')[0]).toMatchObject({
      content: { status: 'cancelled', reason: 'clear' },
    })
  })

  it('/clear leaves sessions without open questions running (ZOD039 unchanged)', async () => {
    const s = setup()
    await startTurn(s)
    await post(s, [{
      type: 'dev.zooid.session_reset', event_id: '$reset2', room_id: ROOM, sender: ALICE,
      content: { 'm.relates_to': { rel_type: 'm.thread', event_id: '$root' } },
    }])
    expect(s.reg.cancelSession).not.toHaveBeenCalled()
    expect(s.reg.endSession).toHaveBeenCalled()
  })

  it('rejects requests with no Matrix destination or from the wrong agent', async () => {
    const s = setup()
    await startTurn(s)
    await expect(ask(s, { session: 'sess-unknown' }).response).rejects.toBeInstanceOf(ElicitationUnsupportedError)
    await expect(ask(s, { agent: 'coder' }).response).rejects.toBeInstanceOf(ElicitationUnsupportedError)
    expect(sent(s, 'dev.zooid.elicitation_request')).toHaveLength(0)
  })

  it('rejects unsupported schema variants without publishing', async () => {
    const s = setup()
    await startTurn(s)
    const r = ask(s, { schema: { type: 'object', properties: { o: { type: 'object' } } } }).response
    await expect(r).rejects.toThrow(/unsupported type "object"/)
    expect(sent(s, 'dev.zooid.elicitation_request')).toHaveLength(0)
  })

  it('retries publication with a stable txnId, then succeeds', async () => {
    const s = setup({ failPublish: 2 })
    await startTurn(s)
    ask(s)
    await settle()
    await settle()
    const attempts = sent(s, 'dev.zooid.elicitation_request')
    expect(attempts).toHaveLength(3)
    expect(new Set(attempts.map((a) => a.txnId)).size).toBe(1)
    expect(s.elicitations.get(requestIdOf(s))?.requestEventId).toBe('$ereq')
  })

  it('settles with a transport error when the card cannot be published', async () => {
    const s = setup({ failPublish: 99 })
    await startTurn(s)
    const { response } = ask(s)
    await expect(response).rejects.toThrow(/could not publish/)
    expect(s.elicitations.countFor('$root')).toBe(0)
  })

  it('does not route elicitation control events as messages', async () => {
    const s = setup()
    await startTurn(s)
    ask(s)
    await settle()
    // The daemon's own echoes come back through the AS stream.
    await post(s, [
      { type: 'dev.zooid.elicitation_request', event_id: '$ereq', room_id: ROOM, sender: AGENT,
        content: { request_id: requestIdOf(s), 'm.relates_to': { rel_type: 'm.thread', event_id: '$root' } } },
      { type: 'dev.zooid.elicitation_resolved', event_id: '$eres', room_id: ROOM, sender: AGENT,
        content: { request_id: requestIdOf(s), 'm.relates_to': { rel_type: 'm.thread', event_id: '$root' } } },
    ])
    await settle()
    expect(s.reg.prompt).toHaveBeenCalledTimes(1)
  })
})

describe('response races', () => {
  it('accepts an answer arriving before publication acknowledgement', async () => {
    const s = setup()
    await startTurn(s)
    let acknowledge!: () => void
    const acknowledgement = new Promise<void>((resolve) => { acknowledge = resolve })
    s.client.sendCustomEvent.mockImplementationOnce(async () => {
      await acknowledgement
      return { event_id: '$ereq' }
    })
    const a = ask(s)
    await settle()
    const requestId = requestIdOf(s)
    const candidate = respond(s, { requestId, content: { env: 'prod' } })
    await settle()
    expect(s.elicitations.countFor('$root')).toBe(1)
    acknowledge()
    await candidate.p
    await expect(a.response).resolves.toEqual({ action: 'accept', content: { env: 'prod' } })
    s.finishTurn()
  })
  it('serializes simultaneous eligible answers to one winner', async () => {
    const s = setup()
    await startTurn(s)
    const a = ask(s)
    await settle()
    const requestId = requestIdOf(s)
    const alice = respond(s, { requestId, sender: ALICE, content: { env: 'prod' } })
    const bob = respond(s, { requestId, sender: BOB, content: { env: 'staging' } })
    await Promise.all([alice.p, bob.p])
    await a.response
    await settle()
    expect(sent(s, 'dev.zooid.elicitation_resolved')).toHaveLength(1)
    expect(sent(s, 'dev.zooid.elicitation_rejected')).toHaveLength(1)
    s.finishTurn()
  })
})

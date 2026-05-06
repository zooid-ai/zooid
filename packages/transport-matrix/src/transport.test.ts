import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createMatrixTransport } from './transport.js'

function fakeRegistry() {
  return {
    hasAgent: vi.fn(() => true),
    ensureSession: vi.fn(async (_name: string, threadId: string) => `sess-${threadId}`),
    endSession: vi.fn(),
    prompt: vi.fn(async () => ({ stopReason: 'end_turn' as const })),
    stopAll: vi.fn(async () => {}),
    getApprovalTimeoutMs: vi.fn(() => 0),
    onEvent: vi.fn() as unknown as (n: string, e: unknown) => void,
    onApprovalRequest: vi.fn(async () => ({ decision: 'cancel' as const })),
  }
}

function fakeApprovals() {
  const e = new EventEmitter()
  return Object.assign(e, {
    register: vi.fn(),
    resolve: vi.fn(() => true),
    cancelSession: vi.fn(),
    listPending: vi.fn(() => []),
  })
}

function fakeClient() {
  return {
    registerBot: vi.fn(async () => undefined),
    joinRoom: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => ({ event_id: '$x' })),
    sendCustomEvent: vi.fn(async () => ({ event_id: '$x' })),
  }
}

const baseAgents = [
  {
    name: 'architect',
    userId: '@architect:example.com',
    rooms: ['!r:example.com'],
    trigger: 'mention' as const,
  },
]

function makeTransport() {
  const agents = fakeRegistry()
  const approvals = fakeApprovals()
  const client = fakeClient()
  const transport = createMatrixTransport({
    agents: agents as never,
    approvals: approvals as never,
    client: client as never,
    bindings: baseAgents,
    hsToken: 'hs-secret',
  })
  return { transport, agents, approvals, client }
}

let txnCounter = 0
async function postTxn(
  app: ReturnType<typeof makeTransport>['transport']['app'],
  body: unknown,
  auth = 'Bearer hs-secret',
) {
  // Each call uses a fresh txnId so the in-memory event-id dedup never
  // misfires across tests that share a transport.
  return app.request(`/_matrix/app/v1/transactions/txn${++txnCounter}`, {
    method: 'PUT',
    headers: { Authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// runTurn is fire-and-forget; let any pending microtasks drain before
// asserting on side-effects driven by the agent prompt.
async function settleTurn(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r))
}

describe('matrix transport /transactions', () => {
  it('rejects requests with a wrong hs_token', async () => {
    const { transport } = makeTransport()
    const res = await postTxn(transport.app, { events: [] }, 'Bearer wrong')
    expect(res.status).toBe(403)
  })

  it('returns 200 {} on an empty event list', async () => {
    const { transport } = makeTransport()
    const res = await postTxn(transport.app, { events: [] })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({})
  })

  it('routes a mentioned message to the agent and replies in-thread', async () => {
    const { transport, agents, client } = makeTransport()
    const events = [
      {
        type: 'm.room.message',
        event_id: '$root',
        room_id: '!r:example.com',
        sender: '@alice:example.com',
        content: {
          msgtype: 'm.text',
          body: 'hi',
          'm.mentions': { user_ids: ['@architect:example.com'] },
        },
      },
    ]
    // Have prompt() emit a streaming text event to drive the reply
    agents.prompt.mockImplementation(async (_name: string, p: { threadId: string }) => {
      agents.onEvent('architect', {
        type: 'message_chunk',
        sessionId: 'sess-' + p.threadId,
        content: { type: 'text', text: 'hello back' },
      })
      return { stopReason: 'end_turn' as const }
    })

    const res = await postTxn(transport.app, { events })
    expect(res.status).toBe(200)
    await settleTurn()
    // Non-threaded messages now use the room as the session key; the reply
    // also goes to the room (not in-thread).
    expect(agents.ensureSession).toHaveBeenCalledWith('architect', '!r:example.com')
    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: '!r:example.com',
        asUserId: '@architect:example.com',
        threadRoot: undefined,
        content: expect.objectContaining({ msgtype: 'm.text', body: 'hello back' }),
      }),
    )
  })

  it('uses an in-thread message event_id as the thread root when one is set', async () => {
    const { transport, agents } = makeTransport()
    const events = [
      {
        type: 'm.room.message',
        event_id: '$reply',
        room_id: '!r:example.com',
        sender: '@alice:example.com',
        content: {
          msgtype: 'm.text',
          body: 'follow up',
          'm.mentions': { user_ids: ['@architect:example.com'] },
          'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
        },
      },
    ]
    await postTxn(transport.app, { events })
    await settleTurn()
    expect(agents.ensureSession).toHaveBeenCalledWith('architect', '$root')
  })

  it('emits eco.zoon.approval_request when an approval is registered', async () => {
    const { transport, approvals, client } = makeTransport()
    // Drive a turn so the transport remembers which room the session belongs to.
    await postTxn(transport.app, {
      events: [
        {
          type: 'm.room.message',
          event_id: '$root',
          room_id: '!r:example.com',
          sender: '@alice:example.com',
          content: {
            msgtype: 'm.text',
            body: 'hi',
            'm.mentions': { user_ids: ['@architect:example.com'] },
          },
        },
      ],
    })
    await settleTurn()
    approvals.emit('registered', {
      approvalId: 'a1',
      // Session key is the room for non-threaded messages.
      sessionId: 'sess-!r:example.com',
      toolCallId: 't1',
      options: [{ optionId: 'allow_once', name: 'Allow', kind: 'allow_once' }],
    })
    // Wait a microtask for the listener to fire
    await new Promise((r) => setImmediate(r))
    expect(client.sendCustomEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'eco.zoon.approval_request',
        content: expect.objectContaining({ approval_id: 'a1' }),
      }),
    )
  })

  it('resolves an approval when an eco.zoon.approval_response event arrives', async () => {
    const { transport, approvals } = makeTransport()
    await postTxn(transport.app, {
      events: [
        {
          type: 'eco.zoon.approval_response',
          event_id: '$resp',
          room_id: '!r:example.com',
          sender: '@alice:example.com',
          content: {
            approval_id: 'a1',
            session_id: 'sess-$root',
            decision: 'allow',
            option_id: 'allow_once',
          },
        },
      ],
    })
    expect(approvals.resolve).toHaveBeenCalledWith(
      'sess-$root',
      'a1',
      { decision: 'allow', optionId: 'allow_once' },
    )
  })
})

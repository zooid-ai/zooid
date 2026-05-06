import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createMatrixTransport } from './transport.js'

function fakeRegistry() {
  let resolvePrompt: (() => void) | undefined
  const promptPending = new Promise<void>((r) => {
    resolvePrompt = r
  })
  const reg = {
    hasAgent: vi.fn(() => true),
    ensureSession: vi.fn(async (_name: string, threadId: string) => `sess-${threadId}`),
    endSession: vi.fn(),
    prompt: vi.fn(async () => {
      await promptPending
      return { stopReason: 'end_turn' as const }
    }),
    stopAll: vi.fn(async () => {}),
    getApprovalTimeoutMs: vi.fn(() => 0),
    onEvent: vi.fn() as unknown as (n: string, e: unknown) => void,
    onApprovalRequest: vi.fn(async () => ({ decision: 'cancel' as const })),
  }
  return { reg, finishPrompt: () => resolvePrompt!() }
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
    setTyping: vi.fn(async () => {}),
    setPresence: vi.fn(async () => {}),
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
  const { reg, finishPrompt } = fakeRegistry()
  const approvals = fakeApprovals()
  const client = fakeClient()
  const transport = createMatrixTransport({
    agents: reg as never,
    approvals: approvals as never,
    client: client as never,
    bindings: baseAgents,
    hsToken: 'hs-secret',
  })
  return { transport, agents: reg, approvals, client, finishPrompt }
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

describe('typing indicator lifecycle', () => {
  it('sets typing=true at runTurn start and typing=false in finally on success', async () => {
    const { transport, client, finishPrompt } = makeTransport()
    await postTxn(transport.app, {
      events: [
        {
          type: 'm.room.message',
          event_id: '$e1',
          origin_server_ts: Date.now(),
          room_id: '!r:example.com',
          sender: '@user:example.com',
          content: {
            msgtype: 'm.text',
            body: 'hi',
            'm.mentions': { user_ids: ['@architect:example.com'] },
          },
        },
      ],
    })
    await settleTurn()
    expect(client.setTyping).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: '!r:example.com',
        asUserId: '@architect:example.com',
        typing: true,
        timeoutMs: 30_000,
      }),
    )
    finishPrompt()
    await settleTurn()
    expect(client.setTyping).toHaveBeenLastCalledWith(
      expect.objectContaining({
        roomId: '!r:example.com',
        asUserId: '@architect:example.com',
        typing: false,
      }),
    )
  })

  it('clears typing in finally even when prompt rejects', async () => {
    const { reg } = fakeRegistry()
    reg.prompt = vi.fn(async () => {
      throw new Error('boom')
    })
    const approvals = fakeApprovals()
    const client = fakeClient()
    const transport = createMatrixTransport({
      agents: reg as never,
      approvals: approvals as never,
      client: client as never,
      bindings: baseAgents,
      hsToken: 'hs-secret',
    })
    await postTxn(transport.app, {
      events: [
        {
          type: 'm.room.message',
          event_id: '$e2',
          origin_server_ts: Date.now(),
          room_id: '!r:example.com',
          sender: '@user:example.com',
          content: {
            msgtype: 'm.text',
            body: 'hi',
            'm.mentions': { user_ids: ['@architect:example.com'] },
          },
        },
      ],
    })
    await settleTurn()
    const offCalls = client.setTyping.mock.calls.filter(
      ([arg]) => (arg as { typing: boolean }).typing === false,
    )
    expect(offCalls.length).toBeGreaterThan(0)
  })

  it('refreshes typing every 25s while the prompt is in flight', async () => {
    vi.useFakeTimers()
    try {
      const { transport, client, finishPrompt } = makeTransport()
      await postTxn(transport.app, {
        events: [
          {
            type: 'm.room.message',
            event_id: '$e3',
            origin_server_ts: Date.now(),
            room_id: '!r:example.com',
            sender: '@user:example.com',
            content: {
            msgtype: 'm.text',
            body: 'hi',
            'm.mentions': { user_ids: ['@architect:example.com'] },
          },
          },
        ],
      })
      await vi.advanceTimersByTimeAsync(0)
      const beforeTickCount = client.setTyping.mock.calls.length
      await vi.advanceTimersByTimeAsync(25_000)
      const afterTickCount = client.setTyping.mock.calls.length
      expect(afterTickCount).toBeGreaterThan(beforeTickCount)
      const lastTickArg = client.setTyping.mock.calls[afterTickCount - 1][0] as {
        typing: boolean
      }
      expect(lastTickArg.typing).toBe(true)
      finishPrompt()
      await vi.runOnlyPendingTimersAsync()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('presence lifecycle', () => {
  it('sets every agent online during bootstrap', async () => {
    const { transport, client } = makeTransport()
    await transport.bootstrap()
    expect(client.setPresence).toHaveBeenCalledWith(
      expect.objectContaining({
        asUserId: '@architect:example.com',
        presence: 'online',
      }),
    )
  })

  it('flips to unavailable around runTurn and back to online in finally', async () => {
    const { transport, client, finishPrompt } = makeTransport()
    await postTxn(transport.app, {
      events: [
        {
          type: 'm.room.message',
          event_id: '$e4',
          origin_server_ts: Date.now(),
          room_id: '!r:example.com',
          sender: '@user:example.com',
          content: {
            msgtype: 'm.text',
            body: 'hi',
            'm.mentions': { user_ids: ['@architect:example.com'] },
          },
        },
      ],
    })
    await settleTurn()
    const seenUnavailable = client.setPresence.mock.calls.some(
      ([arg]) => (arg as { presence: string }).presence === 'unavailable',
    )
    expect(seenUnavailable).toBe(true)
    finishPrompt()
    await settleTurn()
    const last = client.setPresence.mock.calls.at(-1)?.[0] as { presence: string }
    expect(last.presence).toBe('online')
  })

  it('does not abort runTurn when setPresence rejects', async () => {
    const { transport, agents, client, finishPrompt } = makeTransport()
    client.setPresence.mockRejectedValue(new Error('hs hiccup'))
    await postTxn(transport.app, {
      events: [
        {
          type: 'm.room.message',
          event_id: '$e5',
          origin_server_ts: Date.now(),
          room_id: '!r:example.com',
          sender: '@user:example.com',
          content: {
            msgtype: 'm.text',
            body: 'hi',
            'm.mentions': { user_ids: ['@architect:example.com'] },
          },
        },
      ],
    })
    await settleTurn()
    await (agents.onEvent as (n: string, e: unknown) => unknown)('architect', {
      type: 'message_chunk',
      sessionId: 'sess-!r:example.com',
      content: { type: 'text', text: 'reply' },
    })
    finishPrompt()
    await settleTurn()
    expect(client.sendMessage).toHaveBeenCalled()
  })
})

describe('tool-call and plan event bridging', () => {
  async function startTurnAndGetSession() {
    const { transport, agents, client, finishPrompt } = makeTransport()
    await postTxn(transport.app, {
      events: [
        {
          type: 'm.room.message',
          event_id: '$e6',
          origin_server_ts: Date.now(),
          room_id: '!r:example.com',
          sender: '@user:example.com',
          content: {
            msgtype: 'm.text',
            body: 'hi',
            'm.mentions': { user_ids: ['@architect:example.com'] },
          },
        },
      ],
    })
    await settleTurn()
    return { transport, agents, client, finishPrompt, sessionId: 'sess-!r:example.com' }
  }

  it('forwards tool_call as eco.zoon.tool_call in-room under the agent bot user', async () => {
    const { agents, client, finishPrompt, sessionId } = await startTurnAndGetSession()
    await (agents.onEvent as (n: string, e: unknown) => unknown)('architect', {
      type: 'tool_call',
      sessionId,
      toolCallId: 'tc-1',
      title: 'Run tests',
      kind: 'execute',
      status: 'pending',
    })
    await settleTurn()
    expect(client.sendCustomEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: '!r:example.com',
        asUserId: '@architect:example.com',
        eventType: 'eco.zoon.tool_call',
        content: expect.objectContaining({
          session_id: sessionId,
          tool_call_id: 'tc-1',
          title: 'Run tests',
          kind: 'execute',
          status: 'pending',
        }),
      }),
    )
    finishPrompt()
    await settleTurn()
  })

  it('forwards tool_call_update as eco.zoon.tool_call_update', async () => {
    const { agents, client, finishPrompt, sessionId } = await startTurnAndGetSession()
    await (agents.onEvent as (n: string, e: unknown) => unknown)('architect', {
      type: 'tool_call_update',
      sessionId,
      toolCallId: 'tc-1',
      status: 'completed',
    })
    await settleTurn()
    const call = client.sendCustomEvent.mock.calls.find(
      ([arg]) => (arg as { eventType: string }).eventType === 'eco.zoon.tool_call_update',
    )
    expect(call).toBeDefined()
    finishPrompt()
    await settleTurn()
  })

  it('forwards plan as eco.zoon.plan', async () => {
    const { agents, client, finishPrompt, sessionId } = await startTurnAndGetSession()
    await (agents.onEvent as (n: string, e: unknown) => unknown)('architect', {
      type: 'plan',
      sessionId,
      entries: [{ content: 'a', priority: 'high', status: 'pending' }],
    })
    await settleTurn()
    const call = client.sendCustomEvent.mock.calls.find(
      ([arg]) => (arg as { eventType: string }).eventType === 'eco.zoon.plan',
    )
    expect(call).toBeDefined()
    finishPrompt()
    await settleTurn()
  })

  it('attaches m.relates_to thread when the originating message was in-thread', async () => {
    const { transport, agents, client, finishPrompt } = makeTransport()
    await postTxn(transport.app, {
      events: [
        {
          type: 'm.room.message',
          event_id: '$e7',
          origin_server_ts: Date.now(),
          room_id: '!r:example.com',
          sender: '@user:example.com',
          content: {
            msgtype: 'm.text',
            body: 'hi',
            'm.mentions': { user_ids: ['@architect:example.com'] },
            'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
          },
        },
      ],
    })
    await settleTurn()
    const sessionId = 'sess-$root'
    await (agents.onEvent as (n: string, e: unknown) => unknown)('architect', {
      type: 'tool_call',
      sessionId,
      toolCallId: 'tc-1',
      title: 'x',
    })
    await settleTurn()
    const call = client.sendCustomEvent.mock.calls.find(
      ([arg]) => (arg as { eventType: string }).eventType === 'eco.zoon.tool_call',
    )
    expect((call?.[0] as { content: Record<string, unknown> }).content['m.relates_to']).toEqual({
      rel_type: 'm.thread',
      event_id: '$root',
    })
    finishPrompt()
    await settleTurn()
  })

  it('drops events with unknown sessionId', async () => {
    const { agents, client, finishPrompt } = await startTurnAndGetSession()
    const before = client.sendCustomEvent.mock.calls.length
    await (agents.onEvent as (n: string, e: unknown) => unknown)('architect', {
      type: 'tool_call',
      sessionId: 'sess-unknown',
      toolCallId: 'tc-1',
      title: 'x',
    })
    await settleTurn()
    expect(client.sendCustomEvent.mock.calls.length).toBe(before)
    finishPrompt()
    await settleTurn()
  })

  it('still buffers message_chunk into the final m.room.message', async () => {
    const { transport, agents, client, finishPrompt } = makeTransport()
    await postTxn(transport.app, {
      events: [
        {
          type: 'm.room.message',
          event_id: '$e8',
          origin_server_ts: Date.now(),
          room_id: '!r:example.com',
          sender: '@user:example.com',
          content: {
            msgtype: 'm.text',
            body: 'hi',
            'm.mentions': { user_ids: ['@architect:example.com'] },
          },
        },
      ],
    })
    await settleTurn()
    const sessionId = 'sess-!r:example.com'
    await (agents.onEvent as (n: string, e: unknown) => unknown)('architect', {
      type: 'message_chunk',
      sessionId,
      content: { type: 'text', text: 'hello world' },
    })
    finishPrompt()
    await settleTurn()
    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({ body: 'hello world' }),
      }),
    )
  })
})

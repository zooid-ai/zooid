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
    ensureSession: vi.fn(
      async (_name: string, threadId: string, _roomId: string) => `sess-${threadId}`,
    ),
    endSession: vi.fn(),
    cancelSession: vi.fn(async () => {}),
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
    leaveRoom: vi.fn(async () => undefined),
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
    rooms: [{ alias: '!r:example.com' }],
    trigger: 'mention' as const,
  },
]

function makeTransport(drain?: { drainQuietMs?: number; drainMaxMs?: number }) {
  const { reg, finishPrompt } = fakeRegistry()
  const approvals = fakeApprovals()
  const client = fakeClient()
  const transport = createMatrixTransport({
    agents: reg as never,
    approvals: approvals as never,
    client: client as never,
    bindings: baseAgents,
    hsToken: 'hs-secret',
    botUserId: '@zooid:example.com',
    // Disable post-turn drain by default so settleTurn (microtasks) suffices.
    // Tests covering trailing-chunk behavior pass an explicit window.
    drainQuietMs: drain?.drainQuietMs ?? 0,
    drainMaxMs: drain?.drainMaxMs,
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

  it('replies in a thread rooted on the inbound event when the message is top-level', async () => {
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
    agents.prompt.mockImplementation(async (_name: string, p: { threadId: string }) => {
      agents.onEvent('architect', {
        type: 'agent_message_chunk',
        sessionId: 'sess-' + p.threadId,
        content: { type: 'text', text: 'hello back' },
      })
      return { stopReason: 'end_turn' as const }
    })

    const res = await postTxn(transport.app, { events })
    expect(res.status).toBe(200)
    await settleTurn()
    // Agent-promotion: sessionKey is the inbound event_id, NOT the room.
    expect(agents.ensureSession).toHaveBeenCalledWith('architect', '$root', '!r:example.com')
    // The reply threads against the user's message.
    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: '!r:example.com',
        asUserId: '@architect:example.com',
        threadRoot: '$root',
        content: expect.objectContaining({ msgtype: 'm.text', body: 'hello back' }),
      }),
    )
  })

  it('drains trailing agent_message_chunks that arrive after prompt() resolves', async () => {
    // ACP doesn't guarantee all session/update chunks precede the prompt
    // response for a normal turn; opencode flushes a trailing chunk just after
    // the stopReason. The post-turn drain must wait for it instead of sending
    // the truncated buffer.
    const { transport, agents, client } = makeTransport({ drainQuietMs: 20, drainMaxMs: 500 })
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
    agents.prompt.mockImplementation(async (_name: string, p: { threadId: string }) => {
      const sessionId = 'sess-' + p.threadId
      // First chunk arrives during the turn…
      agents.onEvent('architect', {
        type: 'agent_message_chunk',
        sessionId,
        content: { type: 'text', text: 'Hi.' },
      })
      // …a second chunk lands shortly AFTER the prompt response resolves.
      setTimeout(() => {
        agents.onEvent('architect', {
          type: 'agent_message_chunk',
          sessionId,
          content: { type: 'text', text: ' How can I help?' },
        })
      }, 5)
      return { stopReason: 'end_turn' as const }
    })

    const res = await postTxn(transport.app, { events })
    expect(res.status).toBe(200)
    // Wait past the drain window for the turn to finalize.
    await new Promise((r) => setTimeout(r, 150))

    // Exactly one message, containing BOTH the early and the late chunk.
    expect(client.sendMessage).toHaveBeenCalledTimes(1)
    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({ body: 'Hi. How can I help?' }),
      }),
    )
  })

  it('uses an in-thread message event_id as the thread root when one is set', async () => {
    const { transport, agents, client } = makeTransport()
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
    agents.prompt.mockImplementation(async (_name: string, p: { threadId: string }) => {
      agents.onEvent('architect', {
        type: 'agent_message_chunk',
        sessionId: 'sess-' + p.threadId,
        content: { type: 'text', text: 'reply' },
      })
      return { stopReason: 'end_turn' as const }
    })
    await postTxn(transport.app, { events })
    await settleTurn()
    expect(agents.ensureSession).toHaveBeenCalledWith('architect', '$root', '!r:example.com')
    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ threadRoot: '$root' }),
    )
  })

  it('attaches formatted_body when agent text contains markdown', async () => {
    const { transport, agents, client } = makeTransport()
    agents.prompt.mockImplementation(async (_name: string, p: { threadId: string }) => {
      agents.onEvent('architect', {
        type: 'agent_message_chunk',
        sessionId: 'sess-' + p.threadId,
        content: {
          type: 'text',
          text: '**bold** _italic_\n\n```ts\nconst x = 1\n```',
        },
      })
      return { stopReason: 'end_turn' as const }
    })
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
    expect(client.sendMessage).toHaveBeenCalledTimes(1)
    const call = client.sendMessage.mock.calls[0]![0] as {
      content: {
        msgtype: string
        body: string
        format?: string
        formatted_body?: string
      }
    }
    expect(call.content.msgtype).toBe('m.text')
    expect(call.content.body).toBe('**bold** _italic_\n\n```ts\nconst x = 1\n```')
    expect(call.content.format).toBe('org.matrix.custom.html')
    expect(typeof call.content.formatted_body).toBe('string')
    expect(call.content.formatted_body).toContain('<strong>bold</strong>')
    expect(call.content.formatted_body).toContain('<code class="language-ts">')
  })

  it('omits formatted_body when agent text has no markdown features', async () => {
    const { transport, agents, client } = makeTransport()
    agents.prompt.mockImplementation(async (_name: string, p: { threadId: string }) => {
      agents.onEvent('architect', {
        type: 'agent_message_chunk',
        sessionId: 'sess-' + p.threadId,
        content: { type: 'text', text: 'just plain text' },
      })
      return { stopReason: 'end_turn' as const }
    })
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
    expect(client.sendMessage).toHaveBeenCalledTimes(1)
    const call = client.sendMessage.mock.calls[0]![0] as {
      content: Record<string, unknown>
    }
    expect(call.content.body).toBe('just plain text')
    expect(call.content).not.toHaveProperty('formatted_body')
    expect(call.content).not.toHaveProperty('format')
  })

  it('emits dev.zooid.approval_request when an approval is registered', async () => {
    const { transport, approvals, client } = makeTransport()
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
      sessionId: 'sess-$root',          // session is keyed on the promoted thread root
      toolCallId: 't1',
      options: [{ optionId: 'allow_once', name: 'Allow', kind: 'allow_once' }],
    })
    await new Promise((r) => setImmediate(r))
    expect(client.sendCustomEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'dev.zooid.approval_request',
        content: expect.objectContaining({ approval_id: 'a1' }),
      }),
    )
  })

  it('resolves an approval when an dev.zooid.approval_response event arrives', async () => {
    const { transport, approvals } = makeTransport()
    await postTxn(transport.app, {
      events: [
        {
          type: 'dev.zooid.approval_response',
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

describe('thread implicit triggers', () => {
  it('triggers the most-recent-posting agent for a bare reply in a thread', async () => {
    const { transport, agents } = makeTransport()
    // Turn 1: user @mentions architect at top level. Agent-promotion makes
    // $root the thread root and architect a thread participant.
    agents.prompt.mockImplementation(async (_name: string, p: { threadId: string }) => {
      agents.onEvent('architect', {
        type: 'agent_message_chunk',
        sessionId: 'sess-' + p.threadId,
        content: { type: 'text', text: 'hi' },
      })
      return { stopReason: 'end_turn' as const }
    })
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
    agents.ensureSession.mockClear()

    // Turn 2: user replies in the thread WITHOUT @mention.
    await postTxn(transport.app, {
      events: [
        {
          type: 'm.room.message',
          event_id: '$reply2',
          room_id: '!r:example.com',
          sender: '@alice:example.com',
          content: {
            msgtype: 'm.text',
            body: 'follow up',
            'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
          },
        },
      ],
    })
    await settleTurn()

    // architect should be triggered implicitly because they posted in the thread.
    expect(agents.ensureSession).toHaveBeenCalledWith('architect', '$root', '!r:example.com')
  })

  it("inherits the thread root's @mentions when no agent has posted yet", async () => {
    const { transport, agents } = makeTransport()
    // Have prompt() never resolve, so no agent reply has landed when turn 2 arrives.
    agents.prompt.mockImplementation(() => new Promise(() => {}))
    await postTxn(transport.app, {
      events: [
        {
          type: 'm.room.message',
          event_id: '$root',
          room_id: '!r:example.com',
          sender: '@alice:example.com',
          content: {
            msgtype: 'm.text',
            body: 'long question',
            'm.mentions': { user_ids: ['@architect:example.com'] },
          },
        },
      ],
    })
    await settleTurn()
    agents.ensureSession.mockClear()

    // User adds a clarifying reply in-thread before architect has replied.
    await postTxn(transport.app, {
      events: [
        {
          type: 'm.room.message',
          event_id: '$clarify',
          room_id: '!r:example.com',
          sender: '@alice:example.com',
          content: {
            msgtype: 'm.text',
            body: 'btw focus on the auth module',
            'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
          },
        },
      ],
    })
    await settleTurn()
    // Inherits the root's @mention of architect.
    expect(agents.ensureSession).toHaveBeenCalledWith('architect', '$root', '!r:example.com')
  })

  it('does not trigger any agent for a bare top-level message', async () => {
    const { transport, agents } = makeTransport()
    await postTxn(transport.app, {
      events: [
        {
          type: 'm.room.message',
          event_id: '$bare',
          room_id: '!r:example.com',
          sender: '@alice:example.com',
          content: { msgtype: 'm.text', body: 'just thinking out loud' },
        },
      ],
    })
    await settleTurn()
    expect(agents.ensureSession).not.toHaveBeenCalled()
  })

  it('an explicit @mention in a thread always triggers the named agent', async () => {
    const { transport, agents } = makeTransport()
    agents.prompt.mockImplementationOnce(async (_n: string, p: { threadId: string }) => {
      agents.onEvent('architect', {
        type: 'agent_message_chunk',
        sessionId: 'sess-' + p.threadId,
        content: { type: 'text', text: 'hi' },
      })
      return { stopReason: 'end_turn' as const }
    })
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

    agents.ensureSession.mockClear()
    await postTxn(transport.app, {
      events: [
        {
          type: 'm.room.message',
          event_id: '$reply',
          room_id: '!r:example.com',
          sender: '@alice:example.com',
          content: {
            msgtype: 'm.text',
            body: 'one more thing',
            'm.mentions': { user_ids: ['@architect:example.com'] },
            'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
          },
        },
      ],
    })
    await settleTurn()
    expect(agents.ensureSession).toHaveBeenCalledWith('architect', '$root', '!r:example.com')
  })
})

describe('dev.zooid.session_reset', () => {
  it('ends the thread-keyed session when sent inside a thread', async () => {
    const { transport, agents } = makeTransport()
    await postTxn(transport.app, {
      events: [
        {
          type: 'dev.zooid.session_reset',
          event_id: '$reset',
          room_id: '!r:example.com',
          sender: '@alice:example.com',
          content: {
            'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
          },
        },
      ],
    })
    expect(agents.endSession).toHaveBeenCalledWith('architect', '$root')
  })

  it('is a no-op when sent at room scope (no thread relation)', async () => {
    const { transport, agents } = makeTransport()
    await postTxn(transport.app, {
      events: [
        {
          type: 'dev.zooid.session_reset',
          event_id: '$reset-room',
          room_id: '!r:example.com',
          sender: '@alice:example.com',
          content: {},
        },
      ],
    })
    expect(agents.endSession).not.toHaveBeenCalled()
  })

  it('preserves thread routing state — bare reply after /clear still triggers the same agent', async () => {
    const { transport, agents } = makeTransport()
    // Turn 1: user @mentions architect — architect becomes a participant.
    agents.prompt.mockImplementation(async (_name: string, p: { threadId: string }) => {
      agents.onEvent('architect', {
        type: 'agent_message_chunk',
        sessionId: 'sess-' + p.threadId,
        content: { type: 'text', text: 'ok' },
      })
      return { stopReason: 'end_turn' as const }
    })
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

    // /clear in the thread.
    await postTxn(transport.app, {
      events: [
        {
          type: 'dev.zooid.session_reset',
          event_id: '$reset',
          room_id: '!r:example.com',
          sender: '@alice:example.com',
          content: { 'm.relates_to': { rel_type: 'm.thread', event_id: '$root' } },
        },
      ],
    })
    expect(agents.endSession).toHaveBeenCalledWith('architect', '$root')

    agents.ensureSession.mockClear()

    // Bare follow-up — no @mention — must still route to architect (most-recent-poster
    // rule survives /clear; only the agent's session memory is wiped).
    await postTxn(transport.app, {
      events: [
        {
          type: 'm.room.message',
          event_id: '$followup',
          room_id: '!r:example.com',
          sender: '@alice:example.com',
          content: {
            msgtype: 'm.text',
            body: 'still here?',
            'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
          },
        },
      ],
    })
    await settleTurn()
    expect(agents.ensureSession).toHaveBeenCalledWith('architect', '$root', '!r:example.com')
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
      type: 'agent_message_chunk',
      sessionId: 'sess-$e5',
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
    return { transport, agents, client, finishPrompt, sessionId: 'sess-$e6' }
  }

  it('forwards tool_call as dev.zooid.tool_call in-room under the agent bot user', async () => {
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
        eventType: 'dev.zooid.tool_call',
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

  it('forwards tool_call_update as dev.zooid.tool_call_update', async () => {
    const { agents, client, finishPrompt, sessionId } = await startTurnAndGetSession()
    await (agents.onEvent as (n: string, e: unknown) => unknown)('architect', {
      type: 'tool_call_update',
      sessionId,
      toolCallId: 'tc-1',
      status: 'completed',
    })
    await settleTurn()
    const call = client.sendCustomEvent.mock.calls.find(
      ([arg]) => (arg as { eventType: string }).eventType === 'dev.zooid.tool_call_update',
    )
    expect(call).toBeDefined()
    finishPrompt()
    await settleTurn()
  })

  it('forwards plan as dev.zooid.plan', async () => {
    const { agents, client, finishPrompt, sessionId } = await startTurnAndGetSession()
    await (agents.onEvent as (n: string, e: unknown) => unknown)('architect', {
      type: 'plan',
      sessionId,
      entries: [{ content: 'a', priority: 'high', status: 'pending' }],
    })
    await settleTurn()
    const call = client.sendCustomEvent.mock.calls.find(
      ([arg]) => (arg as { eventType: string }).eventType === 'dev.zooid.plan',
    )
    expect(call).toBeDefined()
    finishPrompt()
    await settleTurn()
  })

  it('replays available_commands advertised during ensureSession (before the session ctx exists)', async () => {
    // Regression (ZOD040 ctx race): shims advertise commands during session
    // load/new — i.e. inside ensureSession, BEFORE runTurn registers the ctx.
    // Without buffer-and-replay the event hits onEvent with no ctx and is
    // dropped, so the command palette never fills. available_commands is only
    // ever emitted at session establishment, so this is its ONLY chance.
    const { transport, agents, client, finishPrompt } = makeTransport()
    agents.ensureSession.mockImplementation(async (_name: string, threadId: string) => {
      const sessionId = `sess-${threadId}`
      await (agents.onEvent as (n: string, e: unknown) => unknown)('architect', {
        type: 'available_commands',
        sessionId,
        commands: [{ name: 'compact', description: 'Compact the context' }],
      })
      return sessionId
    })

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
          },
        },
      ],
    })
    await settleTurn()

    const call = client.sendCustomEvent.mock.calls.find(
      ([arg]) =>
        (arg as { eventType: string }).eventType === 'dev.zooid.available_commands_update',
    )
    expect(call).toBeDefined()
    expect((call![0] as { content: Record<string, unknown> }).content).toMatchObject({
      session_id: 'sess-$e7',
      available_commands: [{ name: 'compact', description: 'Compact the context' }],
    })
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
      ([arg]) => (arg as { eventType: string }).eventType === 'dev.zooid.tool_call',
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

  it('still buffers agent_message_chunk into the final m.room.message', async () => {
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
    const sessionId = 'sess-$e8'
    await (agents.onEvent as (n: string, e: unknown) => unknown)('architect', {
      type: 'agent_message_chunk',
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

describe('agent_message_chunk message-boundary buffering', () => {
  async function startTurn(eventId: string) {
    const { transport, agents, client, finishPrompt } = makeTransport()
    await postTxn(transport.app, {
      events: [
        {
          type: 'm.room.message',
          event_id: eventId,
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
    return { agents, client, finishPrompt, sessionId: 'sess-' + eventId }
  }

  const emit = (
    agents: { onEvent: unknown },
    sessionId: string,
    text: string,
    messageId?: string,
  ) =>
    (agents.onEvent as (n: string, e: unknown) => unknown)('architect', {
      type: 'agent_message_chunk',
      sessionId,
      content: { type: 'text', text },
      messageId,
    })

  const sentBody = (client: { sendMessage: { mock: { calls: unknown[][] } } }) =>
    (client.sendMessage.mock.calls[0]![0] as { content: { body: string } }).content.body

  const sentBodies = (client: { sendMessage: { mock: { calls: unknown[][] } } }) =>
    client.sendMessage.mock.calls.map(
      (c) => (c[0] as { content: { body: string } }).content.body,
    )

  it('flushes a separate Matrix message when messageId changes (opencode run-on)', async () => {
    // opencode streams "…it." under one message id, then "Filed:" under a NEW
    // id with no delimiter chunk. Each id is a distinct assistant message, so
    // each lands as its own Matrix message rather than welding into "it.Filed:"
    // (or being buffered into a single turn-end blob).
    const { agents, client, finishPrompt, sessionId } = await startTurn('$mid1')
    await emit(agents, sessionId, 'Let me file it.', 'msg_aaa')
    await emit(agents, sessionId, 'Filed: done', 'msg_bbb')
    finishPrompt()
    await settleTurn()
    expect(client.sendMessage).toHaveBeenCalledTimes(2)
    expect(sentBodies(client)).toEqual(['Let me file it.', 'Filed: done'])
  })

  it('does NOT break between chunks sharing a messageId (token streaming stays intact)', async () => {
    // Within one message, tokens carry their own leading spaces; we must
    // concatenate raw or we corrupt every streamed sentence.
    const { agents, client, finishPrompt, sessionId } = await startTurn('$mid2')
    await emit(agents, sessionId, 'Hello', 'msg_aaa')
    await emit(agents, sessionId, ' world', 'msg_aaa')
    await emit(agents, sessionId, '.', 'msg_aaa')
    finishPrompt()
    await settleTurn()
    expect(sentBody(client)).toBe('Hello world.')
  })

  it('flushes each message of a three-message run separately', async () => {
    const { agents, client, finishPrompt, sessionId } = await startTurn('$mid3')
    await emit(agents, sessionId, 'one.', 'msg_a')
    await emit(agents, sessionId, 'two.', 'msg_b')
    await emit(agents, sessionId, 'three.', 'msg_c')
    finishPrompt()
    await settleTurn()
    expect(client.sendMessage).toHaveBeenCalledTimes(3)
    expect(sentBodies(client)).toEqual(['one.', 'two.', 'three.'])
  })

  it('still breaks on an empty delimiter chunk (agents that signal that way)', async () => {
    const { agents, client, finishPrompt, sessionId } = await startTurn('$mid4')
    await emit(agents, sessionId, 'before', 'msg_a')
    await emit(agents, sessionId, '', 'msg_a') // empty delimiter, same id
    await emit(agents, sessionId, 'after', 'msg_a')
    finishPrompt()
    await settleTurn()
    expect(sentBody(client)).toBe('before\n\nafter')
  })

  it('concatenates raw when chunks carry no messageId (e.g. Claude Code)', async () => {
    const { agents, client, finishPrompt, sessionId } = await startTurn('$mid5')
    await emit(agents, sessionId, 'Hello', undefined)
    await emit(agents, sessionId, ' there', undefined)
    finishPrompt()
    await settleTurn()
    expect(sentBody(client)).toBe('Hello there')
  })

  it('flushes buffered text before a following plan event (interleaving)', async () => {
    // A turn that alternates prose and plan updates: each prose message must
    // land on the wire before the plan event that follows it, not be deferred
    // to turn end (the bug — everything buffered, then one blob after N plans).
    const { agents, client, finishPrompt, sessionId } = await startTurn('$mid6')
    await emit(agents, sessionId, 'Sure, making a list.', 'msg_a')
    await (agents.onEvent as (n: string, e: unknown) => unknown)('architect', {
      type: 'plan',
      sessionId,
      entries: [{ content: 'Buy milk', status: 'pending' }],
    })
    await emit(agents, sessionId, 'Working through them.', 'msg_b')
    finishPrompt()
    await settleTurn()

    expect(sentBodies(client)).toEqual(['Sure, making a list.', 'Working through them.'])
    const planIdx = client.sendCustomEvent.mock.calls.findIndex(
      ([arg]) => (arg as { eventType: string }).eventType === 'dev.zooid.plan',
    )
    expect(planIdx).toBeGreaterThanOrEqual(0)
    // Order across both mocks: msg1 → plan → msg2.
    const msg1 = client.sendMessage.mock.invocationCallOrder[0]!
    const msg2 = client.sendMessage.mock.invocationCallOrder[1]!
    const plan = client.sendCustomEvent.mock.invocationCallOrder[planIdx]!
    expect(msg1).toBeLessThan(plan)
    expect(plan).toBeLessThan(msg2)
  })
})

describe('dev.zooid.interrupt handling', () => {
  it('dispatches cancelSession(agent.name, sessionId) for an interrupt that targets a tracked session', async () => {
    const { transport, agents, finishPrompt } = makeTransport()
    await postTxn(transport.app, {
      events: [
        {
          type: 'm.room.message',
          event_id: '$start',
          origin_server_ts: Date.now(),
          room_id: '!r:example.com',
          sender: '@user:example.com',
          content: { msgtype: 'm.text', body: 'hi', 'm.mentions': { user_ids: ['@architect:example.com'] } },
        },
      ],
    })
    await settleTurn()

    await postTxn(transport.app, {
      events: [
        {
          type: 'dev.zooid.interrupt',
          event_id: '$int',
          origin_server_ts: Date.now(),
          room_id: '!r:example.com',
          sender: '@user:example.com',
          content: { session_id: 'sess-$start', reason: 'user_initiated' },
        },
      ],
    })
    expect(agents.cancelSession).toHaveBeenCalledWith('architect', 'sess-$start')
    finishPrompt()
    await settleTurn()
  })

  it('drops interrupts with no session_id', async () => {
    const { transport, agents, finishPrompt } = makeTransport()
    await postTxn(transport.app, {
      events: [
        {
          type: 'm.room.message',
          event_id: '$s2',
          origin_server_ts: Date.now(),
          room_id: '!r:example.com',
          sender: '@user:example.com',
          content: { msgtype: 'm.text', body: 'hi', 'm.mentions': { user_ids: ['@architect:example.com'] } },
        },
      ],
    })
    await settleTurn()
    await postTxn(transport.app, {
      events: [
        {
          type: 'dev.zooid.interrupt',
          event_id: '$int2',
          origin_server_ts: Date.now(),
          room_id: '!r:example.com',
          sender: '@user:example.com',
          content: {},
        },
      ],
    })
    expect(agents.cancelSession).not.toHaveBeenCalled()
    finishPrompt()
    await settleTurn()
  })

  it('drops interrupts whose session_id is not tracked', async () => {
    const { transport, agents } = makeTransport()
    await postTxn(transport.app, {
      events: [
        {
          type: 'dev.zooid.interrupt',
          event_id: '$int3',
          origin_server_ts: Date.now(),
          room_id: '!r:example.com',
          sender: '@user:example.com',
          content: { session_id: 'sess-unknown' },
        },
      ],
    })
    expect(agents.cancelSession).not.toHaveBeenCalled()
  })

  it('cancels the matching session when interrupt carries a thread relation (no session_id)', async () => {
    const { transport, agents, finishPrompt } = makeTransport()
    await postTxn(transport.app, {
      events: [
        {
          type: 'm.room.message',
          event_id: '$threadRoot',
          origin_server_ts: Date.now(),
          room_id: '!r:example.com',
          sender: '@user:example.com',
          content: { msgtype: 'm.text', body: 'hi', 'm.mentions': { user_ids: ['@architect:example.com'] } },
        },
      ],
    })
    await settleTurn()

    await postTxn(transport.app, {
      events: [
        {
          type: 'dev.zooid.interrupt',
          event_id: '$intT',
          origin_server_ts: Date.now(),
          room_id: '!r:example.com',
          sender: '@user:example.com',
          content: {
            'm.relates_to': { rel_type: 'm.thread', event_id: '$threadRoot' },
            reason: 'user_initiated',
          },
        },
      ],
    })
    expect(agents.cancelSession).toHaveBeenCalledWith('architect', 'sess-$threadRoot')
    finishPrompt()
    await settleTurn()
  })

  it('is idempotent — a second interrupt for the same session re-invokes cancelSession', async () => {
    const { transport, agents, finishPrompt } = makeTransport()
    await postTxn(transport.app, {
      events: [
        {
          type: 'm.room.message',
          event_id: '$s4',
          origin_server_ts: Date.now(),
          room_id: '!r:example.com',
          sender: '@user:example.com',
          content: { msgtype: 'm.text', body: 'hi', 'm.mentions': { user_ids: ['@architect:example.com'] } },
        },
      ],
    })
    await settleTurn()
    const interrupt = (id: string) => ({
      events: [
        {
          type: 'dev.zooid.interrupt',
          event_id: id,
          origin_server_ts: Date.now(),
          room_id: '!r:example.com',
          sender: '@user:example.com',
          content: { session_id: 'sess-$s4' },
        },
      ],
    })
    await postTxn(transport.app, interrupt('$intA'))
    await postTxn(transport.app, interrupt('$intB'))
    expect(agents.cancelSession).toHaveBeenCalledTimes(2)
    finishPrompt()
    await settleTurn()
  })

  it('rejects interrupts on the AS endpoint without a valid hsToken', async () => {
    const { transport } = makeTransport()
    const r = await postTxn(
      transport.app,
      {
        events: [
          {
            type: 'dev.zooid.interrupt',
            event_id: '$bad',
            origin_server_ts: Date.now(),
            room_id: '!r:example.com',
            sender: '@user:example.com',
            content: { session_id: 'sess-x' },
          },
        ],
      },
      'Bearer wrong-secret',
    )
    expect(r.status).toBe(403)
  })
})

describe('full loop integration', () => {
  it('top-level @mention → in-thread reply → bare follow-up triggers same agent', async () => {
    const { transport, agents, client } = makeTransport()
    agents.prompt.mockImplementation(async (_n: string, p: { threadId: string }) => {
      agents.onEvent('architect', {
        type: 'agent_message_chunk',
        sessionId: 'sess-' + p.threadId,
        content: { type: 'text', text: 'reply ' + p.threadId.slice(0, 6) },
      })
      return { stopReason: 'end_turn' as const }
    })

    // Turn 1: top-level mention.
    await postTxn(transport.app, {
      events: [{
        type: 'm.room.message', event_id: '$root', room_id: '!r:example.com',
        sender: '@alice:example.com',
        content: {
          msgtype: 'm.text', body: 'hi @architect',
          'm.mentions': { user_ids: ['@architect:example.com'] },
        },
      }],
    })
    await settleTurn()
    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ threadRoot: '$root' }),
    )

    // Turn 2: bare reply in thread — implicit trigger, same session.
    agents.ensureSession.mockClear()
    client.sendMessage.mockClear()
    await postTxn(transport.app, {
      events: [{
        type: 'm.room.message', event_id: '$bare', room_id: '!r:example.com',
        sender: '@alice:example.com',
        content: {
          msgtype: 'm.text', body: 'follow up',
          'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
        },
      }],
    })
    await settleTurn()
    expect(agents.ensureSession).toHaveBeenCalledWith('architect', '$root', '!r:example.com')
    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ threadRoot: '$root' }),
    )
  })
})

// ─── Media pipeline tests ────────────────────────────────────────────────────

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const TINY_PNG = Buffer.from(TINY_PNG_B64, 'base64')

function fakeMedia() {
  return {
    download: vi.fn(async () => ({ data: new Uint8Array(TINY_PNG), contentType: 'image/png' })),
    upload: vi.fn(async () => ({ content_uri: 'mxc://localhost/up1' })),
  }
}

const workspaceBinding = {
  ...baseAgents[0],
  workspaceDir: '/tmp/ws',
  agentWorkspacePath: '/workspace',
}

function makeMediaTransport(opts: {
  media?: ReturnType<typeof fakeMedia>
  writeAttachmentFn?: unknown
} = {}) {
  const { reg, finishPrompt } = fakeRegistry()
  const approvals = fakeApprovals()
  const client = fakeClient()
  const transport = createMatrixTransport({
    agents: reg as never,
    approvals: approvals as never,
    client: client as never,
    bindings: [workspaceBinding],
    hsToken: 'hs-secret',
    drainQuietMs: 0,
    media: opts.media as never,
    writeAttachmentFn: opts.writeAttachmentFn as never,
  })
  return { transport, agents: reg, client, finishPrompt }
}

function imageEvent(over: {
  size?: number
  mimetype?: string
  msgtype?: string
  body?: string
  eventId?: string
} = {}) {
  return {
    type: 'm.room.message',
    event_id: over.eventId ?? '$media1',
    room_id: '!r:example.com',
    sender: '@alice:example.com',
    content: {
      msgtype: over.msgtype ?? 'm.image',
      body: over.body ?? 'dog.png',
      url: 'mxc://localhost/abc',
      info: { mimetype: over.mimetype ?? 'image/png', size: over.size ?? 67 },
    },
  }
}

function mentionMsg(body: string, eventId = '$text1') {
  return {
    type: 'm.room.message',
    event_id: eventId,
    room_id: '!r:example.com',
    sender: '@alice:example.com',
    content: {
      msgtype: 'm.text',
      body: `@architect ${body}`,
      'm.mentions': { user_ids: ['@architect:example.com'] },
    },
  }
}

describe('inbound media', () => {
  it('media events do not trigger a turn; m.text from the same sender drains them inline', async () => {
    const media = fakeMedia()
    const { transport, agents } = makeMediaTransport({ media })

    // Image event: no turn fired
    await postTxn(transport.app, { events: [imageEvent()] })
    await settleTurn()
    expect(agents.prompt).not.toHaveBeenCalled()

    // m.text mention from same sender: turn fires, image block prepended
    agents.prompt.mockImplementation(async (_name: string, p: { content: unknown[] }) => {
      agents.onEvent('architect', {
        type: 'agent_message_chunk',
        sessionId: 'sess-$text1',
        content: { type: 'text', text: 'got it' },
      })
      return { stopReason: 'end_turn' as const }
    })
    await postTxn(transport.app, { events: [mentionMsg('look at this')] })
    await settleTurn()

    expect(agents.prompt).toHaveBeenCalledOnce()
    const content = (agents.prompt.mock.calls[0][1] as { content: unknown[] }).content
    expect(content[0]).toMatchObject({ type: 'image', data: TINY_PNG_B64, mimeType: 'image/png' })
    expect((content[1] as { type: string; text: string }).type).toBe('text')
    expect(media.download).toHaveBeenCalledOnce()
  })

  it('routes an oversized image to the file path with a resource_link block and prose line', async () => {
    const media = fakeMedia()
    const writeAttachmentFn = vi.fn(() => ({
      hostPath: '/tmp/ws/.zooid/attachments/media1/dog.png',
      agentPath: '/workspace/.zooid/attachments/media1/dog.png',
    }))
    const { transport, agents } = makeMediaTransport({ media, writeAttachmentFn })

    agents.prompt.mockResolvedValue({ stopReason: 'end_turn' as const })
    await postTxn(transport.app, { events: [imageEvent({ size: 600_000 })] }) // > MAX_INLINE_IMAGE_BYTES
    await postTxn(transport.app, { events: [mentionMsg('summarize')] })
    await settleTurn()

    const content = (agents.prompt.mock.calls[0][1] as { content: unknown[] }).content
    expect(content[0]).toMatchObject({
      type: 'resource_link',
      uri: 'file:///workspace/.zooid/attachments/media1/dog.png',
      name: 'dog.png',
    })
    expect((content[1] as { text: string }).text).toContain(
      '/workspace/.zooid/attachments/media1/dog.png',
    )
  })

  it('routes m.file to the workspace regardless of size', async () => {
    const media = fakeMedia()
    const writeAttachmentFn = vi.fn(() => ({
      hostPath: '/tmp/ws/.zooid/attachments/media1/report.pdf',
      agentPath: '/workspace/.zooid/attachments/media1/report.pdf',
    }))
    const { transport, agents } = makeMediaTransport({ media, writeAttachmentFn })

    agents.prompt.mockResolvedValue({ stopReason: 'end_turn' as const })
    await postTxn(transport.app, {
      events: [imageEvent({ msgtype: 'm.file', body: 'report.pdf', mimetype: 'application/pdf' })],
    })
    await postTxn(transport.app, { events: [mentionMsg('read it')] })
    await settleTurn()

    expect(writeAttachmentFn).toHaveBeenCalledOnce()
    const content = (agents.prompt.mock.calls[0][1] as { content: unknown[] }).content
    expect((content[0] as { type: string }).type).toBe('resource_link')
  })

  it('emits dev.zooid.error (code media_failed) when download fails, still runs the turn text-only', async () => {
    const media = fakeMedia()
    media.download.mockRejectedValueOnce(new Error('download boom'))
    const { transport, agents, client } = makeMediaTransport({ media })

    agents.prompt.mockImplementation(async () => {
      agents.onEvent('architect', {
        type: 'agent_message_chunk',
        sessionId: 'sess-$text1',
        content: { type: 'text', text: 'ok' },
      })
      return { stopReason: 'end_turn' as const }
    })
    await postTxn(transport.app, { events: [imageEvent()] })
    await postTxn(transport.app, { events: [mentionMsg('look')] })
    await settleTurn()

    expect(client.sendCustomEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'dev.zooid.error',
        content: expect.objectContaining({ code: 'media_failed' }),
      }),
    )
    const content = (agents.prompt.mock.calls[0][1] as { content: unknown[] }).content
    expect(content).toHaveLength(1)
    expect((content[0] as { type: string }).type).toBe('text')
  })
})

describe('outbound agent images', () => {
  it('uploads an image chunk and sends a threaded m.image as the agent user', async () => {
    const media = fakeMedia()
    const { transport, agents, client } = makeMediaTransport({ media })

    agents.prompt.mockImplementation(async () => {
      // Emit image block during prompt
      agents.onEvent('architect', {
        type: 'agent_message_chunk',
        sessionId: 'sess-$text1',
        content: { type: 'image', data: TINY_PNG_B64, mimeType: 'image/png' },
      })
      // Also emit text block so the turn isn't empty
      agents.onEvent('architect', {
        type: 'agent_message_chunk',
        sessionId: 'sess-$text1',
        content: { type: 'text', text: 'here is the image' },
      })
      return { stopReason: 'end_turn' as const }
    })

    await postTxn(transport.app, { events: [mentionMsg('show me an image')] })
    await settleTurn()
    // Give async upload/send a moment to settle
    await new Promise((r) => setTimeout(r, 10))

    expect(media.upload).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: 'image/png', asUserId: '@architect:example.com' }),
    )
    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        asUserId: '@architect:example.com',
        content: expect.objectContaining({
          msgtype: 'm.image',
          url: 'mxc://localhost/up1',
          info: expect.objectContaining({ mimetype: 'image/png', size: TINY_PNG.length }),
        }),
      }),
    )
  })

  it('does not throw when an audio block arrives (non-goal — warn and drop)', async () => {
    const media = fakeMedia()
    const { transport, agents } = makeMediaTransport({ media })

    agents.prompt.mockImplementation(async () => {
      agents.onEvent('architect', {
        type: 'agent_message_chunk',
        sessionId: 'sess-$text1',
        content: { type: 'audio', data: 'AAAA', mimeType: 'audio/wav' },
      })
      agents.onEvent('architect', {
        type: 'agent_message_chunk',
        sessionId: 'sess-$text1',
        content: { type: 'text', text: 'ok' },
      })
      return { stopReason: 'end_turn' as const }
    })

    await expect(
      postTxn(transport.app, { events: [mentionMsg('test audio')] }),
    ).resolves.not.toThrow()
    await settleTurn()
  })
})

describe('ad-hoc bot invite declines', () => {
  let n = 0
  const invite = (stateKey: string, sender: string) => ({
    type: 'm.room.member',
    event_id: `$inv${++n}`,
    room_id: '!r:example.com',
    sender,
    state_key: stateKey,
    content: { membership: 'invite' },
  })

  it('declines an invite to the AS bot from a human, with a reason', async () => {
    const { transport, client } = makeTransport()
    await postTxn(transport.app, { events: [invite('@zooid:example.com', '@zongshan:example.com')] })
    expect(client.leaveRoom).toHaveBeenCalledWith(
      '!r:example.com',
      '@zooid:example.com',
      { reason: expect.stringContaining('zooid.yaml') },
    )
  })

  it('declines an invite to an agent from a human', async () => {
    const { transport, client } = makeTransport()
    await postTxn(transport.app, { events: [invite('@architect:example.com', '@zongshan:example.com')] })
    expect(client.leaveRoom).toHaveBeenCalledWith(
      '!r:example.com',
      '@architect:example.com',
      expect.objectContaining({ reason: expect.any(String) }),
    )
  })

  it('does NOT decline a provisioning invite (inviter is our AS bot)', async () => {
    const { transport, client } = makeTransport()
    await postTxn(transport.app, { events: [invite('@architect:example.com', '@zooid:example.com')] })
    expect(client.leaveRoom).not.toHaveBeenCalled()
  })

  it('ignores an invite to a human (not one of our bots)', async () => {
    const { transport, client } = makeTransport()
    await postTxn(transport.app, { events: [invite('@dave:example.com', '@zongshan:example.com')] })
    expect(client.leaveRoom).not.toHaveBeenCalled()
  })
})

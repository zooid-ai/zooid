import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createMatrixTransport } from '../src/transport.js'

const roomId = '!r:hs'
const bindings = [
  {
    name: 'supervisor',
    userId: '@supervisor:hs',
    rooms: [{ alias: roomId }],
    trigger: 'mention' as const,
  },
  {
    name: 'worker',
    userId: '@worker:hs',
    rooms: [{ alias: roomId }],
    trigger: 'mention' as const,
  },
  {
    name: 'eager',
    userId: '@eager:hs',
    rooms: [{ alias: roomId }],
    trigger: 'any' as const,
  },
]

async function settle() {
  for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r))
}

describe('thread fan-out', () => {
  it('dispatches only the assignee and returns its terminal result to the exact caller session', async () => {
    const sent: Array<{
      type: string
      input: Record<string, unknown>
      event_id: string
    }> = []
    const prompts: Array<{ name: string; threadId: string; text: string }> = []
    let n = 0
    const registry = {
      ensureSession: vi.fn(async (name: string, threadId: string) => `sess:${name}:${threadId}`),
      endSession: vi.fn(),
      cancelSession: vi.fn(),
      stopAll: vi.fn(),
      hasAgent: vi.fn(() => true),
      hasContextSpawn: vi.fn(() => true),
      getApprovalTimeoutMs: vi.fn(() => 0),
      onApprovalRequest: vi.fn(),
      onEvent: vi.fn() as unknown as (name: string, event: unknown) => void,
      prompt: vi.fn(
        async (name: string, input: { threadId: string; content: Array<{ text?: string }> }) => {
          prompts.push({
            name,
            threadId: input.threadId,
            text: input.content.map((x) => x.text ?? '').join(''),
          })
          if (name === 'worker')
            registry.onEvent(name, {
              type: 'agent_message_chunk',
              sessionId: `sess:${name}:${input.threadId}`,
              content: { type: 'text', text: 'audit is clean' },
            })
          return { stopReason: 'end_turn' as const }
        },
      ),
    }
    const client = {
      registerBot: vi.fn(),
      joinRoom: vi.fn(),
      leaveRoom: vi.fn(),
      setTyping: vi.fn(async () => {}),
      setPresence: vi.fn(async () => {}),
      sendMessage: vi.fn(async (input: Record<string, unknown>) => {
        const event_id = `$${++n}`
        sent.push({ type: 'm.room.message', input, event_id })
        return { event_id }
      }),
      sendCustomEvent: vi.fn(async (input: Record<string, unknown>) => {
        const event_id = `$${++n}`
        sent.push({ type: String(input.eventType), input, event_id })
        return { event_id }
      }),
    }
    const transport = createMatrixTransport({
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
    })
    const started = await transport.taskActions.startTasks(
      {
        agentName: 'supervisor',
        channelId: roomId,
        threadRoot: '$parent',
        sessionKey: '$parent',
      },
      { tasks: [{ agent: 'worker', prompt: 'audit' }] },
    )
    expect(started.results[0]).toMatchObject({ status: 'started' })
    const root = sent[0]!
    await transport.app.request('/_matrix/app/v1/transactions/root', {
      method: 'PUT',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        events: [
          {
            type: root.type,
            event_id: root.event_id,
            room_id: roomId,
            sender: '@supervisor:hs',
            content: root.input.content,
          },
        ],
      }),
    })
    await settle()
    expect(prompts.filter((p) => p.name === 'worker')).toHaveLength(1)
    expect(prompts.some((p) => p.name === 'eager')).toBe(false)
    expect(sent.some((e) => e.type === 'dev.zooid.thread_result')).toBe(true)
    expect(
      sent.some((e) => (e.input.content as Record<string, unknown>)['dev.zooid.thread_result']),
    ).toBe(true)
    expect(prompts.filter((p) => p.name === 'supervisor')).toMatchObject([{ threadId: '$parent' }])
  })
})

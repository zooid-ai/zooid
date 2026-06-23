import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createMatrixTransport } from '../src/transport.js'

function fakeRegistry() {
  const reg = {
    hasAgent: vi.fn(() => true),
    ensureSession: vi.fn(
      async (_name: string, threadId: string, _roomId: string) => `sess-${threadId}`,
    ),
    endSession: vi.fn(),
    cancelSession: vi.fn(async () => {}),
    prompt: vi.fn(async () => ({ stopReason: 'end_turn' as const })),
    stopAll: vi.fn(async () => {}),
    getApprovalTimeoutMs: vi.fn(() => 0),
    onEvent: vi.fn() as unknown as (n: string, e: unknown) => void,
    onApprovalRequest: vi.fn(async () => ({ decision: 'cancel' as const })),
  }
  return reg
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

const baseAgents = [
  {
    name: 'architect',
    userId: '@architect:example.com',
    rooms: [{ alias: '!r:example.com' }],
    trigger: 'mention' as const,
  },
]

const mentionEvt = {
  type: 'm.room.message',
  event_id: '$mention-1',
  sender: '@alice:example.com',
  origin_server_ts: Date.now(),
  content: {
    msgtype: 'm.text',
    body: '@architect hi',
    'm.mentions': { user_ids: ['@architect:example.com'] },
  },
}

function makePullTransport(
  pages: unknown[],
  store: Map<string, string>,
) {
  let i = 0
  const fakeClient = {
    registerBot: vi.fn(async () => undefined),
    joinRoom: vi.fn(async () => undefined),
    leaveRoom: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => ({ event_id: '$x' })),
    sendCustomEvent: vi.fn(async () => ({ event_id: '$x' })),
    setTyping: vi.fn(async () => {}),
    setPresence: vi.fn(async () => {}),
    fetchEvent: vi.fn(async () => null),
    fetchThreadRelations: vi.fn(async () => ({ chunk: [] })),
    sync: vi.fn(async () => pages[Math.min(i++, pages.length - 1)]),
  }
  const agents = fakeRegistry()
  const approvals = fakeApprovals()
  const transport = createMatrixTransport({
    agents: agents as never,
    approvals: approvals as never,
    client: fakeClient as never,
    bindings: baseAgents,
    hsToken: 'hs-secret',
    drainQuietMs: 0,
    mode: 'client',
    loadSince: (userId) => store.get(userId) ?? null,
    saveSince: (userId, since) => store.set(userId, since),
  })
  return { transport, agents, fakeClient }
}

async function settleTurn(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r))
}

describe('pull transport (mode: client)', () => {
  it('dispatches a synced mention into runTurn exactly once and persists since', async () => {
    const store = new Map<string, string>()
    const pages = [
      {
        next_batch: 's1',
        rooms: { join: { '!r:example.com': { timeline: { events: [mentionEvt] } } } },
      },
      { next_batch: 's1', rooms: { join: {} } },
    ]

    const { transport, agents } = makePullTransport(pages, store)
    const loops = transport.syncLoops
    expect(loops).toBeDefined()
    expect(loops!.length).toBe(1)

    await loops![0].tick()
    await settleTurn()

    expect(agents.prompt).toHaveBeenCalledOnce()
    expect(agents.ensureSession).toHaveBeenCalledWith('architect', '$mention-1', '!r:example.com')
    expect(store.get('@architect:example.com')).toBe('s1')
  })

  it('resumes from persisted since — fresh transport passes since on next tick', async () => {
    const store = new Map<string, string>([['@architect:example.com', 's-persisted']])
    const pages = [{ next_batch: 's2', rooms: { join: {} } }]

    const { transport, fakeClient } = makePullTransport(pages, store)
    await transport.syncLoops![0].tick()

    expect(fakeClient.sync).toHaveBeenCalledWith(
      expect.objectContaining({ since: 's-persisted', asUserId: '@architect:example.com' }),
    )
    expect(store.get('@architect:example.com')).toBe('s2')
  })

  it('does not reprocess a mention when a fresh transport starts from the persisted since', async () => {
    const store = new Map<string, string>()

    // First run: process the mention
    const pages1 = [
      {
        next_batch: 's1',
        rooms: { join: { '!r:example.com': { timeline: { events: [mentionEvt] } } } },
      },
    ]
    const { transport: t1, agents: a1 } = makePullTransport(pages1, store)
    await t1.syncLoops![0].tick()
    await settleTurn()
    expect(a1.prompt).toHaveBeenCalledOnce()
    expect(store.get('@architect:example.com')).toBe('s1')

    // Second run: idle page only — mention is NOT replayed because since='s1'
    const pages2 = [{ next_batch: 's1', rooms: { join: {} } }]
    const { transport: t2, agents: a2, fakeClient } = makePullTransport(pages2, store)
    await t2.syncLoops![0].tick()
    await settleTurn()

    expect(fakeClient.sync).toHaveBeenCalledWith(
      expect.objectContaining({ since: 's1' }),
    )
    expect(a2.prompt).not.toHaveBeenCalled()
  })
})

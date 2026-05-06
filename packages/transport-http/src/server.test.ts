import { describe, it, expect, vi } from 'vitest'
import type {
  AcpRegistry,
  AcpRegistryEventHandler,
  AcpRegistryApprovalHandler,
} from '@zooid/core'
import { ApprovalCorrelator } from '@zooid/core'
import type {
  AgentEvent,
  ApprovalRequest,
  PromptInput,
  PromptResult,
} from '@zooid/acp-client'
import { createApp } from './server.js'

const TOKEN = 'test-token-0123456789abcdef'
const SID = '11111111-2222-3333-4444-555555555555'

interface FakeRegistryOptions {
  agents?: string[]
  events?: AgentEvent[]
  stopReason?: PromptResult['stopReason']
  sessionId?: string
  ensureSession?: (name: string, threadId: string) => Promise<string>
  prompt?: (name: string, input: PromptInput) => Promise<PromptResult>
}

function makeRegistry(opts: FakeRegistryOptions = {}): AcpRegistry {
  const known = new Set(opts.agents ?? ['triage'])
  const events = opts.events ?? []
  let onEvent: AcpRegistryEventHandler = () => {}
  let onApprovalRequest: AcpRegistryApprovalHandler = async () => ({ decision: 'cancel' })

  const reg: AcpRegistry = {
    hasAgent: (n) => known.has(n),
    getApprovalTimeoutMs: () => 0,
    ensureSession:
      opts.ensureSession ??
      vi.fn(async () => opts.sessionId ?? SID),
    endSession: vi.fn(),
    prompt:
      opts.prompt ??
      vi.fn(async (name) => {
        for (const e of events) onEvent(name, e)
        return { stopReason: opts.stopReason ?? 'end_turn' }
      }),
    stopAll: vi.fn(async () => {}),
    get onEvent() {
      return onEvent
    },
    set onEvent(h) {
      onEvent = h
    },
    get onApprovalRequest() {
      return onApprovalRequest
    },
    set onApprovalRequest(h) {
      onApprovalRequest = h
    },
  }
  return reg
}

function parseFrames(text: string): unknown[] {
  return text
    .split('\n\n')
    .filter((f) => f.startsWith('data: '))
    .map((f) => JSON.parse(f.slice('data: '.length)))
}

async function postJson(
  app: ReturnType<typeof createApp>,
  path: string,
  body: object,
  authOverride?: string | null,
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (authOverride !== null) {
    headers.authorization = authOverride ?? `Bearer ${TOKEN}`
  }
  return app.request(path, { method: 'POST', headers, body: JSON.stringify(body) })
}

function newApprovals(): ApprovalCorrelator {
  return new ApprovalCorrelator()
}

// ─── auth ────────────────────────────────────────────────────────────────

describe('auth', () => {
  it('401 when Authorization header missing', async () => {
    const app = createApp({ agents: makeRegistry(), approvals: newApprovals(), token: TOKEN })
    const res = await postJson(app, '/agents/triage/sessions', { prompt: 'hi' }, null)
    expect(res.status).toBe(401)
  })

  it('401 when token is wrong', async () => {
    const app = createApp({ agents: makeRegistry(), approvals: newApprovals(), token: TOKEN })
    const res = await postJson(
      app,
      '/agents/triage/sessions',
      { prompt: 'hi' },
      'Bearer wrong-token-of-different-length-xx',
    )
    expect(res.status).toBe(401)
  })

  it('401 with non-Bearer scheme', async () => {
    const app = createApp({ agents: makeRegistry(), approvals: newApprovals(), token: TOKEN })
    const res = await postJson(
      app,
      '/agents/triage/sessions',
      { prompt: 'hi' },
      `Basic ${TOKEN}`,
    )
    expect(res.status).toBe(401)
  })

  it('401 with same-length wrong token (constant-time guard)', async () => {
    const app = createApp({ agents: makeRegistry(), approvals: newApprovals(), token: TOKEN })
    const wrong = 'X'.repeat(TOKEN.length)
    const res = await postJson(
      app,
      '/agents/triage/sessions',
      { prompt: 'hi' },
      `Bearer ${wrong}`,
    )
    expect(res.status).toBe(401)
  })
})

// ─── POST /agents/:name/sessions ─────────────────────────────────────────

describe('POST /agents/:name/sessions', () => {
  it('404 unknown agent', async () => {
    const app = createApp({ agents: makeRegistry({ agents: ['triage'] }), approvals: newApprovals(), token: TOKEN })
    const res = await postJson(app, '/agents/nobody/sessions', { prompt: 'hi' })
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/unknown/i) })
  })

  it('400 missing prompt', async () => {
    const app = createApp({ agents: makeRegistry(), approvals: newApprovals(), token: TOKEN })
    const res = await postJson(app, '/agents/triage/sessions', {})
    expect(res.status).toBe(400)
  })

  it('400 non-JSON body', async () => {
    const app = createApp({ agents: makeRegistry(), approvals: newApprovals(), token: TOKEN })
    const res = await app.request('/agents/triage/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: 'not-json',
    })
    expect(res.status).toBe(400)
  })

  it('happy path: SSE stream — session.start → turn.start → ACP events → turn.end', async () => {
    const events: AgentEvent[] = [
      { type: 'message_chunk', sessionId: SID, content: { type: 'text', text: 'hi' } },
      { type: 'plan', sessionId: SID, entries: [] },
    ]
    const app = createApp({
      agents: makeRegistry({ events, stopReason: 'end_turn' }),
      approvals: newApprovals(),
      token: TOKEN,
    })
    const res = await postJson(app, '/agents/triage/sessions', { prompt: 'hi' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const frames = parseFrames(await res.text()) as Array<Record<string, unknown>>
    expect(frames[0]).toEqual({ type: 'session.start', session_id: SID })
    expect(frames[1]).toEqual({ type: 'turn.start' })
    expect(frames.slice(2, -1).map((f) => f.type)).toEqual(['message_chunk', 'plan'])
    const last = frames[frames.length - 1]
    expect(last.type).toBe('turn.end')
    expect(last.stop_reason).toBe('end_turn')
  })

  it('calls registry.prompt(name, { threadId, content }) with a server-generated threadId', async () => {
    const promptMock = vi.fn(async () => ({ stopReason: 'end_turn' as const }))
    const app = createApp({
      agents: makeRegistry({ prompt: promptMock }),
      approvals: newApprovals(),
      token: TOKEN,
    })
    const res = await postJson(app, '/agents/triage/sessions', { prompt: 'hello' })
    await res.text()
    expect(promptMock).toHaveBeenCalledTimes(1)
    const [name, input] = promptMock.mock.calls[0]
    expect(name).toBe('triage')
    expect(input.threadId).toMatch(/^[0-9a-f-]{8,}$/)
    expect(Array.isArray(input.content)).toBe(true)
    expect(input.content[0]).toMatchObject({ type: 'text', text: 'hello' })
  })
})

// ─── GET /agents/:name/sessions/:id/events ───────────────────────────────

describe('GET /agents/:name/sessions/:id/events', () => {
  it('404 when no turn is currently in flight for that session id', async () => {
    const app = createApp({ agents: makeRegistry(), approvals: newApprovals(), token: TOKEN })
    const res = await app.request(`/agents/triage/sessions/${SID}/events`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(res.status).toBe(404)
  })

  it('400 on non-UUID id', async () => {
    const app = createApp({ agents: makeRegistry(), approvals: newApprovals(), token: TOKEN })
    const res = await app.request('/agents/triage/sessions/not-a-uuid/events', {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(res.status).toBe(400)
  })

  it('404 unknown agent', async () => {
    const app = createApp({ agents: makeRegistry({ agents: ['triage'] }), approvals: newApprovals(), token: TOKEN })
    const res = await app.request(`/agents/ghost/sessions/${SID}/events`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(res.status).toBe(404)
  })

  it('401 without auth', async () => {
    const app = createApp({ agents: makeRegistry(), approvals: newApprovals(), token: TOKEN })
    const res = await app.request(`/agents/triage/sessions/${SID}/events`)
    expect(res.status).toBe(401)
  })
})

// ─── legacy routes ──────────────────────────────────────────────────────

describe('legacy /sessions and /run routes are gone', () => {
  it('POST /run → 404', async () => {
    const app = createApp({ agents: makeRegistry(), approvals: newApprovals(), token: TOKEN })
    const res = await postJson(app, '/run', { prompt: 'hi' })
    expect(res.status).toBe(404)
  })

  it('POST /sessions → 404', async () => {
    const app = createApp({ agents: makeRegistry(), approvals: newApprovals(), token: TOKEN })
    const res = await postJson(app, '/sessions', { prompt: 'hi' })
    expect(res.status).toBe(404)
  })
})

// ─── approval round-trip (Plan-02) ───────────────────────────────────────

const APPROVAL_ID_RE = /^[0-9a-f-]{30,}$/

function approvalRequest(toolCallId: string): ApprovalRequest {
  return {
    sessionId: SID,
    toolCallId,
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
    ],
  }
}

describe('SSE approval.request emission', () => {
  it('emits approval.request when the agent requests permission', async () => {
    const approvals = newApprovals()
    const reg: AcpRegistry = makeRegistry({
      prompt: async (name) => {
        // The transport replaces registry.onApprovalRequest with one that
        // registers on the correlator + emits approval.request on the SSE.
        // The AcpClient would call it — we do so directly to simulate.
        const decisionPromise = reg.onApprovalRequest(name, approvalRequest('tc-1'))
        // Wait until the approval is registered, then resolve it.
        await new Promise((r) => setTimeout(r, 30))
        const pending = approvals.listPending(SID)
        expect(pending.length).toBeGreaterThan(0)
        approvals.resolve(SID, pending[0].approvalId, {
          decision: 'allow',
          optionId: 'allow-once',
        })
        const decision = await decisionPromise
        return { stopReason: decision.decision === 'allow' ? 'end_turn' : 'refusal' }
      },
    })

    const app = createApp({ agents: reg, approvals, token: TOKEN })
    const res = await postJson(app, '/agents/triage/sessions', { prompt: 'hi' })
    expect(res.status).toBe(200)
    const frames = parseFrames(await res.text()) as Array<Record<string, unknown>>
    const approvalFrame = frames.find((f) => f.type === 'approval.request')
    expect(approvalFrame).toBeDefined()
    expect((approvalFrame as { approval_id: string }).approval_id).toMatch(APPROVAL_ID_RE)
    const last = frames[frames.length - 1]
    expect(last.type).toBe('turn.end')
  })
})

describe('POST /agents/:name/sessions/:sid/approvals/:approval_id', () => {
  it('401 without bearer token', async () => {
    const app = createApp({ agents: makeRegistry(), approvals: newApprovals(), token: TOKEN })
    const res = await postJson(
      app,
      `/agents/triage/sessions/${SID}/approvals/abc`,
      { decision: 'cancel' },
      null,
    )
    expect(res.status).toBe(401)
  })

  it('404 for unknown agent', async () => {
    const app = createApp({
      agents: makeRegistry({ agents: ['triage'] }),
      approvals: newApprovals(),
      token: TOKEN,
    })
    const res = await postJson(
      app,
      `/agents/ghost/sessions/${SID}/approvals/abc`,
      { decision: 'cancel' },
    )
    expect(res.status).toBe(404)
  })

  it('404 for unknown approval id (correlator returns false)', async () => {
    const app = createApp({ agents: makeRegistry(), approvals: newApprovals(), token: TOKEN })
    const res = await postJson(
      app,
      `/agents/triage/sessions/${SID}/approvals/nope`,
      { decision: 'cancel' },
    )
    expect(res.status).toBe(404)
  })

  it('400 for body missing decision', async () => {
    const approvals = newApprovals()
    const app = createApp({ agents: makeRegistry(), approvals, token: TOKEN })
    const res = await postJson(
      app,
      `/agents/triage/sessions/${SID}/approvals/anything`,
      {},
    )
    expect(res.status).toBe(400)
  })

  it('400 when allow lacks option_id', async () => {
    const approvals = newApprovals()
    const handle = approvals.register('triage', SID, approvalRequest('tc-1'))
    const app = createApp({ agents: makeRegistry(), approvals, token: TOKEN })
    const res = await postJson(
      app,
      `/agents/triage/sessions/${SID}/approvals/${handle.approvalId}`,
      { decision: 'allow' },
    )
    expect(res.status).toBe(400)
    void handle.decisionPromise.catch(() => {})
  })

  it('200 + resolves the in-flight Promise on valid allow', async () => {
    const approvals = newApprovals()
    const handle = approvals.register('triage', SID, approvalRequest('tc-1'))
    const app = createApp({ agents: makeRegistry(), approvals, token: TOKEN })
    const res = await postJson(
      app,
      `/agents/triage/sessions/${SID}/approvals/${handle.approvalId}`,
      { decision: 'allow', option_id: 'allow-once' },
    )
    expect(res.status).toBe(200)
    await expect(handle.decisionPromise).resolves.toEqual({
      decision: 'allow',
      optionId: 'allow-once',
    })
  })

  it('200 + resolves with cancel on { decision: "cancel" }', async () => {
    const approvals = newApprovals()
    const handle = approvals.register('triage', SID, approvalRequest('tc-1'))
    const app = createApp({ agents: makeRegistry(), approvals, token: TOKEN })
    const res = await postJson(
      app,
      `/agents/triage/sessions/${SID}/approvals/${handle.approvalId}`,
      { decision: 'cancel' },
    )
    expect(res.status).toBe(200)
    await expect(handle.decisionPromise).resolves.toEqual({ decision: 'cancel' })
  })
})

describe('POST /agents/:name/sessions/:sid/cancel', () => {
  it('401 without bearer token', async () => {
    const app = createApp({ agents: makeRegistry(), approvals: newApprovals(), token: TOKEN })
    const res = await postJson(app, `/agents/triage/sessions/${SID}/cancel`, {}, null)
    expect(res.status).toBe(401)
  })

  it('404 for unknown agent', async () => {
    const app = createApp({
      agents: makeRegistry({ agents: ['triage'] }),
      approvals: newApprovals(),
      token: TOKEN,
    })
    const res = await postJson(app, `/agents/ghost/sessions/${SID}/cancel`, {})
    expect(res.status).toBe(404)
  })

  it('204 and cancels every pending approval for the session', async () => {
    const approvals = newApprovals()
    const a = approvals.register('triage', SID, approvalRequest('tc-1'))
    const b = approvals.register('triage', SID, approvalRequest('tc-2'))
    const app = createApp({ agents: makeRegistry(), approvals, token: TOKEN })
    const res = await postJson(app, `/agents/triage/sessions/${SID}/cancel`, {})
    expect(res.status).toBe(204)
    await expect(a.decisionPromise).resolves.toEqual({ decision: 'cancel' })
    await expect(b.decisionPromise).resolves.toEqual({ decision: 'cancel' })
    expect(approvals.size()).toBe(0)
  })

  it('204 even with no pending approvals (idempotent)', async () => {
    const app = createApp({ agents: makeRegistry(), approvals: newApprovals(), token: TOKEN })
    const res = await postJson(app, `/agents/triage/sessions/${SID}/cancel`, {})
    expect(res.status).toBe(204)
  })
})

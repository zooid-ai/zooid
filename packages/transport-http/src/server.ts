import { Hono, type Context } from 'hono'
import { streamSSE, type SSEStreamingApi } from 'hono/streaming'
import { timingSafeEqual, randomUUID } from 'node:crypto'
import type {
  AcpRegistry,
  ApprovalCorrelator,
  RegisteredApproval,
} from '@zooid/core'
import type {
  AgentEvent,
  ApprovalDecision,
} from '@zooid/acp-client'

export interface CreateAppOptions {
  /** Long-lived registry that fronts every ACP agent. */
  agents: AcpRegistry
  /**
   * Correlator that pairs ACP `requestPermission` calls with HTTP-side
   * decisions. The transport listens to its `'registered'` and `'timeout'`
   * events to drive the SSE wire and resolves it via the POST decision route.
   */
  approvals: ApprovalCorrelator
  /** Bearer token; constant-time compared against `Authorization`. */
  token: string
  /**
   * Keepalive interval for open SSE streams (proxies kill idle connections).
   * 0 disables. Default: 30_000ms.
   */
  keepaliveMs?: number
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

interface PromptBody {
  prompt: string
}

function isAuthorized(token: string, header: string | undefined): boolean {
  if (!header || !header.startsWith('Bearer ')) return false
  const provided = header.slice('Bearer '.length)
  if (provided.length !== token.length) return false
  return timingSafeEqual(Buffer.from(provided), Buffer.from(token))
}

function parsePromptBody(raw: unknown): PromptBody | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'body must be a JSON object' }
  const obj = raw as Record<string, unknown>
  if (typeof obj.prompt !== 'string' || obj.prompt.length === 0) {
    return { error: 'missing or empty prompt' }
  }
  return { prompt: obj.prompt }
}

async function readJson(c: Context): Promise<unknown | { error: string }> {
  const raw = await c.req.text()
  try {
    return JSON.parse(raw)
  } catch {
    return { error: 'body must be valid JSON' }
  }
}

interface DecisionBody {
  decision: 'allow' | 'cancel'
  option_id?: string
}

function parseDecisionBody(raw: unknown): DecisionBody | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'body must be a JSON object' }
  const obj = raw as Record<string, unknown>
  if (obj.decision !== 'allow' && obj.decision !== 'cancel') {
    return { error: 'decision must be "allow" or "cancel"' }
  }
  if (obj.decision === 'allow' && typeof obj.option_id !== 'string') {
    return { error: 'option_id is required when decision is "allow"' }
  }
  return {
    decision: obj.decision,
    option_id: typeof obj.option_id === 'string' ? obj.option_id : undefined,
  }
}

function approvalRequestFrame(handle: RegisteredApproval): string {
  return JSON.stringify({
    type: 'approval.request',
    approval_id: handle.approvalId,
    session_id: handle.sessionId,
    tool_call_id: handle.toolCallId,
    options: handle.options,
  })
}

export function createApp({
  agents,
  approvals,
  token,
  keepaliveMs = 30_000,
}: CreateAppOptions) {
  const app = new Hono()

  // Per-session SSE handle. The registry's onEvent dispatcher and the
  // correlator's `'registered'` / `'timeout'` listeners look up the
  // currently-attached stream by session id.
  const streams = new Map<string, SSEStreamingApi>()

  agents.onEvent = (_name, event: AgentEvent) => {
    const stream = streams.get(event.sessionId)
    if (!stream) return
    void stream.writeSSE({ data: JSON.stringify(event) })
  }
  // Always wire the registry's approval handler to the correlator. The
  // per-agent `approval_timeout_ms` is read off the registry so YAML-driven
  // timeouts still apply.
  agents.onApprovalRequest = async (name, req) => {
    const handle = approvals.register(name, req.sessionId, req, {
      timeoutMs: agents.getApprovalTimeoutMs(name),
    })
    return handle.decisionPromise
  }

  approvals.on('registered', (handle: RegisteredApproval) => {
    const stream = streams.get(handle.sessionId)
    if (!stream) return
    void stream.writeSSE({ data: approvalRequestFrame(handle) })
  })

  approvals.on('timeout', ({ approvalId, sessionId }: { approvalId: string; sessionId: string }) => {
    const stream = streams.get(sessionId)
    if (!stream) return
    void stream.writeSSE({
      data: JSON.stringify({ type: 'approval.timeout', approval_id: approvalId, session_id: sessionId }),
    })
  })

  function checkAgent(c: Context, name: string): Response | null {
    if (!agents.hasAgent(name)) {
      return c.json({ error: 'unknown agent' }, 404)
    }
    return null
  }

  function attachKeepalive(sse: SSEStreamingApi): NodeJS.Timeout | null {
    if (!keepaliveMs || keepaliveMs <= 0) return null
    const timer = setInterval(() => {
      void sse.writeSSE({ data: '', event: 'keepalive' }).catch(() => {})
    }, keepaliveMs)
    timer.unref?.()
    return timer
  }

  /**
   * POST /agents/:name/sessions — start a new ACP session.
   *
   *   { session.start, session_id }
   *   { turn.start }
   *   ... ACP AgentEvents
   *   { approval.request, ... } / { approval.timeout, ... } as they arrive
   *   { turn.end, stop_reason }
   */
  app.post('/agents/:name/sessions', async (c) => {
    if (!isAuthorized(token, c.req.header('authorization'))) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    const name = c.req.param('name')
    const reject = checkAgent(c, name)
    if (reject) return reject

    const parsed = await readJson(c)
    if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      return c.json({ error: (parsed as { error: string }).error }, 400)
    }
    const body = parsePromptBody(parsed)
    if ('error' in body) return c.json({ error: body.error }, 400)

    const threadId = randomUUID()
    return streamSSE(c, async (sse) => {
      let sessionId: string | null = null
      let keepalive: NodeJS.Timeout | null = null
      try {
        sessionId = await agents.ensureSession(name, threadId)
        streams.set(sessionId, sse)
        keepalive = attachKeepalive(sse)
        await sse.writeSSE({
          data: JSON.stringify({ type: 'session.start', session_id: sessionId }),
        })
        await sse.writeSSE({ data: JSON.stringify({ type: 'turn.start' }) })
        const result = await agents.prompt(name, {
          threadId,
          content: [{ type: 'text', text: body.prompt }],
        })
        await sse.writeSSE({
          data: JSON.stringify({ type: 'turn.end', stop_reason: result.stopReason }),
        })
      } catch (err) {
        await sse.writeSSE({
          data: JSON.stringify({
            type: 'turn.end',
            stop_reason: 'error',
            error: (err as Error).message,
          }),
        })
      } finally {
        if (keepalive) clearInterval(keepalive)
        if (sessionId) {
          // The turn is over; cancel any approvals that the shim left
          // dangling so future POSTs against them 404 fast.
          approvals.cancelSession(sessionId)
          if (streams.get(sessionId) === sse) {
            streams.delete(sessionId)
          }
        }
      }
    })
  })

  /**
   * GET /agents/:name/sessions/:id/events — reattach to an in-flight stream.
   *
   * When a turn is in flight: replays any pending approvals via
   * `approvals.listPending(sid)`, then forwards live events until the turn
   * ends. When no turn is in flight: 404.
   */
  app.get('/agents/:name/sessions/:id/events', async (c) => {
    if (!isAuthorized(token, c.req.header('authorization'))) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    const name = c.req.param('name')
    const reject = checkAgent(c, name)
    if (reject) return reject
    const id = c.req.param('id')
    if (!UUID_RE.test(id)) {
      return c.json({ error: 'session id must be a UUID' }, 400)
    }
    if (!streams.has(id)) {
      return c.json({ error: 'no in-flight session' }, 404)
    }
    return streamSSE(c, async (sse) => {
      // Take ownership of dispatch for this session id.
      streams.set(id, sse)
      const keepalive = attachKeepalive(sse)
      // Replay any approvals that are still pending so the reconnecting
      // client can decide on them.
      for (const handle of approvals.listPending(id)) {
        await sse.writeSSE({ data: approvalRequestFrame(handle) })
      }
      try {
        while (streams.get(id) === sse) {
          await new Promise((r) => setTimeout(r, 250))
        }
      } finally {
        if (keepalive) clearInterval(keepalive)
      }
    })
  })

  /**
   * POST /agents/:name/sessions/:sid/approvals/:approval_id — resolve a
   * pending permission request.
   */
  app.post('/agents/:name/sessions/:sid/approvals/:approval_id', async (c) => {
    if (!isAuthorized(token, c.req.header('authorization'))) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    const name = c.req.param('name')
    const reject = checkAgent(c, name)
    if (reject) return reject

    const sid = c.req.param('sid')
    const approvalId = c.req.param('approval_id')
    const parsed = await readJson(c)
    if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      return c.json({ error: (parsed as { error: string }).error }, 400)
    }
    const body = parseDecisionBody(parsed)
    if ('error' in body) return c.json({ error: body.error }, 400)

    const decision: ApprovalDecision =
      body.decision === 'cancel'
        ? { decision: 'cancel' }
        : { decision: 'allow', optionId: body.option_id! }
    const ok = approvals.resolve(sid, approvalId, decision)
    if (!ok) return c.json({ error: 'unknown approval' }, 404)
    return c.json({ ok: true })
  })

  /**
   * POST /agents/:name/sessions/:sid/cancel — cancel every pending approval
   * for the session. Idempotent. Returns 204.
   */
  app.post('/agents/:name/sessions/:sid/cancel', async (c) => {
    if (!isAuthorized(token, c.req.header('authorization'))) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    const name = c.req.param('name')
    const reject = checkAgent(c, name)
    if (reject) return reject
    const sid = c.req.param('sid')
    approvals.cancelSession(sid)
    return c.body(null, 204)
  })

  return app
}

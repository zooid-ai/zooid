import { Hono, type Context } from 'hono'
import { streamSSE, type SSEStreamingApi } from 'hono/streaming'
import { timingSafeEqual, randomUUID } from 'node:crypto'
import type { AcpRegistry } from '@zooid/core'
import type { AgentEvent, ApprovalDecision, ApprovalRequest } from '@zooid/acp-client'

export interface CreateAppOptions {
  /** Long-lived registry that fronts every ACP agent. */
  agents: AcpRegistry
  /** Bearer token; constant-time compared against `Authorization`. */
  token: string
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

export function createApp({ agents, token }: CreateAppOptions) {
  const app = new Hono()

  // Per-session SSE streams. Populated when the registry creates a session
  // for a turn; cleared on turn completion. Used by the registry's onEvent
  // callback (set just below) to dispatch events to the right SSE response,
  // and by the GET /events route to reattach an in-flight stream.
  const streams = new Map<string, SSEStreamingApi>()

  agents.onEvent = (_name, event: AgentEvent) => {
    const stream = streams.get(event.sessionId)
    if (!stream) return
    void stream.writeSSE({ data: JSON.stringify(event) })
  }
  agents.onApprovalRequest = async (
    _name: string,
    _req: ApprovalRequest,
  ): Promise<ApprovalDecision> => {
    // Plan-01 default — approvals always cancel. Plan-02 wires the HTTP
    // round-trip via an `approval.request` SSE event + decision endpoint.
    return { decision: 'cancel' }
  }

  function checkAgent(c: Context, name: string): Response | null {
    if (!agents.hasAgent(name)) {
      return c.json({ error: 'unknown agent' }, 404)
    }
    return null
  }

  /**
   * POST /agents/:name/sessions — start a new ACP session.
   *
   * Wire format (greenfield, no back-compat):
   *   { type: "session.start", session_id }
   *   { type: "turn.start" }
   *   ... ACP AgentEvent JSON lines (message_chunk, tool_call, ...)
   *   { type: "turn.end", stop_reason }
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
      try {
        sessionId = await agents.ensureSession(name, threadId)
        streams.set(sessionId, sse)
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
        if (sessionId) streams.delete(sessionId)
      }
    })
  })

  /**
   * GET /agents/:name/sessions/:id/events — reattach to an in-flight stream.
   *
   * No replay-from-disk. If there's no live SSE stream for this session id,
   * return 404. The supported reattach mode is "subscribe to the in-flight
   * turn" — once the turn ends, the stream closes.
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
    // Reattach is intentionally minimal in Plan-01: we just hold the
    // connection open while the in-flight session is live. Events fan out
    // via the registry's onEvent dispatcher to each registered stream;
    // a future epic can store an event log for replay.
    return streamSSE(c, async (sse) => {
      // Replace the active dispatch target with this new SSE so the
      // reattached client gets fresh events for this session id.
      streams.set(id, sse)
      while (streams.get(id) === sse) {
        await new Promise((r) => setTimeout(r, 250))
      }
    })
  })

  return app
}

import { Hono } from 'hono'
import { timingSafeEqual } from 'node:crypto'
import type { AcpRegistry, ApprovalCorrelator, RegisteredApproval } from '@zooid/core'
import type { AgentEvent } from '@zooid/acp-client'
import { MatrixClient } from './matrix-client.js'
import { BotPool } from './bot-pool.js'
import { route, type AgentBinding } from './router.js'

export interface CreateMatrixTransportOptions {
  agents: AcpRegistry
  approvals: ApprovalCorrelator
  client: MatrixClient
  bindings: AgentBinding[]
  hsToken: string
  /** Admin Matrix user ID. When set, BotPool.bootstrap invites this user into rooms it creates. */
  adminUserId?: string
}

interface SessionContext {
  agent: AgentBinding
  roomId: string
  threadRoot: string
}

interface MatrixEvent {
  type?: string
  event_id?: string
  room_id?: string
  sender?: string
  content?: Record<string, unknown> & {
    msgtype?: string
    body?: string
    'm.relates_to'?: { rel_type?: string; event_id?: string }
  }
}

export function createMatrixTransport(opts: CreateMatrixTransportOptions) {
  const { agents, approvals, client, bindings, hsToken, adminUserId } = opts
  const pool = new BotPool(client, bindings)
  const sessions = new Map<string, SessionContext>()
  const buffers = new Map<string, string>()

  agents.onEvent = (_name, event: AgentEvent) => {
    if (event.type !== 'message_chunk') return
    const ctx = sessions.get(event.sessionId)
    if (!ctx) return
    const block = event.content as { type?: string; text?: string }
    if (block.type === 'text' && typeof block.text === 'string') {
      buffers.set(event.sessionId, (buffers.get(event.sessionId) ?? '') + block.text)
    }
  }

  agents.onApprovalRequest = async (name, req) => {
    const handle = approvals.register(name, (req as { sessionId: string }).sessionId, req, {
      timeoutMs: agents.getApprovalTimeoutMs(name),
    })
    return handle.decisionPromise
  }

  approvals.on('registered', (handle: RegisteredApproval) => {
    const ctx = sessions.get(handle.sessionId)
    if (!ctx) return
    void client.sendCustomEvent({
      roomId: ctx.roomId,
      asUserId: ctx.agent.userId,
      eventType: 'eco.zoon.approval_request',
      content: {
        approval_id: handle.approvalId,
        session_id: handle.sessionId,
        tool_call_id: handle.toolCallId,
        options: handle.options,
        'm.relates_to': { rel_type: 'm.thread', event_id: ctx.threadRoot },
      },
    })
  })

  const app = new Hono()

  function authOk(authHeader: string | undefined): boolean {
    const h = authHeader ?? ''
    if (!h.startsWith('Bearer ')) return false
    const got = h.slice(7)
    if (got.length !== hsToken.length) return false
    return timingSafeEqual(Buffer.from(got), Buffer.from(hsToken))
  }

  app.put('/_matrix/app/v1/transactions/:txnId', async (c) => {
    if (!authOk(c.req.header('authorization'))) {
      return c.json({ errcode: 'M_FORBIDDEN' }, 403)
    }
    const body = (await c.req.json().catch(() => ({}))) as { events?: MatrixEvent[] }
    for (const evt of body.events ?? []) {
      if (evt.type === 'eco.zoon.approval_response') {
        const content = (evt.content ?? {}) as {
          approval_id?: string
          session_id?: string
          decision?: string
          option_id?: string
        }
        if (!content.session_id || !content.approval_id || !content.decision) continue
        const decision = content.option_id
          ? { decision: content.decision, optionId: content.option_id }
          : { decision: content.decision }
        const ok = approvals.resolve(
          content.session_id,
          content.approval_id,
          decision as never,
        )
        if (!ok) console.warn(`[matrix] unknown approval ${content.approval_id}`)
        continue
      }
      const matches = route(evt, bindings)
      for (const a of matches) await runTurn(a, evt)
    }
    return c.json({})
  })

  app.get('/_matrix/app/v1/users/:userId', (c) => {
    if (!authOk(c.req.header('authorization'))) {
      return c.json({ errcode: 'M_FORBIDDEN' }, 403)
    }
    return c.json({})
  })
  app.get('/_matrix/app/v1/rooms/:alias', (c) => {
    if (!authOk(c.req.header('authorization'))) {
      return c.json({ errcode: 'M_FORBIDDEN' }, 403)
    }
    return c.json({ errcode: 'M_NOT_FOUND' }, 404)
  })
  app.post('/_matrix/app/v1/ping', (c) => {
    if (!authOk(c.req.header('authorization'))) {
      return c.json({ errcode: 'M_FORBIDDEN' }, 403)
    }
    return c.json({})
  })
  app.get('/healthz', (c) => c.text('ok'))

  async function runTurn(agent: AgentBinding, evt: MatrixEvent): Promise<void> {
    const relates = evt.content?.['m.relates_to']
    const threadRoot =
      relates?.rel_type === 'm.thread' && relates.event_id ? relates.event_id : evt.event_id
    if (!threadRoot || !evt.room_id) return
    const sessionId = await agents.ensureSession(agent.name, threadRoot)
    sessions.set(sessionId, { agent, roomId: evt.room_id, threadRoot })
    buffers.set(sessionId, '')
    try {
      await agents.prompt(agent.name, {
        threadId: threadRoot,
        content: [{ type: 'text', text: evt.content?.body ?? '' }],
      })
      const text = buffers.get(sessionId) ?? ''
      if (text.length > 0) {
        await client.sendMessage({
          roomId: evt.room_id,
          asUserId: agent.userId,
          content: { msgtype: 'm.text', body: text },
          threadRoot,
        })
      }
    } finally {
      buffers.delete(sessionId)
    }
  }

  return {
    app,
    bootstrap: () => pool.bootstrap({ adminUserId }),
    pool,
  }
}

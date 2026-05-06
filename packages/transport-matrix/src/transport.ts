import { Hono } from 'hono'
import { timingSafeEqual } from 'node:crypto'
import type { AcpRegistry, ApprovalCorrelator, RegisteredApproval } from '@zooid/core'
import type { AgentEvent } from '@zooid/acp-client'
import { MatrixClient } from './matrix-client.js'
import { BotPool } from './bot-pool.js'
import { route, type AgentBinding } from './router.js'
import { stripMention } from './mentions.js'

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
  /** Set only when the originating message was part of a Matrix thread. */
  threadRoot?: string
}

interface MatrixEvent {
  type?: string
  event_id?: string
  origin_server_ts?: number
  room_id?: string
  sender?: string
  content?: Record<string, unknown> & {
    msgtype?: string
    body?: string
    'm.relates_to'?: { rel_type?: string; event_id?: string }
  }
}

const STARTUP_GRACE_MS = 5_000
const SEEN_EVENT_CAP = 5_000

export function createMatrixTransport(opts: CreateMatrixTransportOptions) {
  const { agents, approvals, client, bindings, hsToken, adminUserId } = opts
  const pool = new BotPool(client, bindings)
  const sessions = new Map<string, SessionContext>()
  const buffers = new Map<string, string>()
  // Drop events older than this — Tuwunel may replay a backlog after the
  // daemon was offline, and we don't want yesterday's "@docs hi" to fire now.
  const cutoffTs = Date.now() - STARTUP_GRACE_MS
  // Idempotency: appservice transactions are retried on 4xx/5xx/timeout, and
  // the same event_id can arrive twice. Skip ones we've already taken.
  const seenEventIds = new Set<string>()

  agents.onEvent = (name, event: AgentEvent) => {
    if (event.type !== 'message_chunk') {
      console.warn(`[matrix:${name}] dropped non-chunk event`, event.type)
      return
    }
    const ctx = sessions.get(event.sessionId)
    if (!ctx) {
      console.warn(`[matrix:${name}] no session ctx for ${event.sessionId}`)
      return
    }
    const block = event.content as { type?: string; text?: string }
    if (block.type === 'text' && typeof block.text === 'string') {
      buffers.set(event.sessionId, (buffers.get(event.sessionId) ?? '') + block.text)
    } else {
      console.warn(`[matrix:${name}] dropped chunk block type=${block.type}`, block)
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
    const content: Record<string, unknown> = {
      approval_id: handle.approvalId,
      session_id: handle.sessionId,
      tool_call_id: handle.toolCallId,
      options: handle.options,
    }
    if (ctx.threadRoot) {
      content['m.relates_to'] = { rel_type: 'm.thread', event_id: ctx.threadRoot }
    }
    if (handle.toolKind !== undefined) content.tool_kind = handle.toolKind
    if (handle.toolTitle !== undefined) content.tool_title = handle.toolTitle
    if (handle.toolInput !== undefined) content.tool_input = handle.toolInput
    void client.sendCustomEvent({
      roomId: ctx.roomId,
      asUserId: ctx.agent.userId,
      eventType: 'eco.zoon.approval_request',
      content,
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
      if (evt.event_id) {
        if (seenEventIds.has(evt.event_id)) {
          // Tuwunel retried this transaction (or sent it twice). Already taken.
          continue
        }
        seenEventIds.add(evt.event_id)
        if (seenEventIds.size > SEEN_EVENT_CAP) {
          // Bound memory by dropping the oldest insertion. JS Sets keep insertion order.
          const first = seenEventIds.values().next().value
          if (first !== undefined) seenEventIds.delete(first)
        }
      }
      if (
        evt.origin_server_ts !== undefined &&
        evt.origin_server_ts < cutoffTs &&
        evt.type === 'm.room.message'
      ) {
        console.log(
          `[matrix] dropping stale message event ${evt.event_id} ` +
            `(ts=${evt.origin_server_ts}, daemon started at ${cutoffTs + STARTUP_GRACE_MS})`,
        )
        continue
      }
      if (evt.type === 'eco.zoon.session_reset') {
        // /clear from the composer: drop any session keyed on the room (or
        // in-thread root, if the reset was sent inside a thread). We blanket
        // every binding — endSession() on a key with no session is a no-op,
        // and the key itself is room-scoped, so no cross-room collateral.
        const relates = evt.content?.['m.relates_to'] as
          | { rel_type?: string; event_id?: string }
          | undefined
        const threaded =
          relates?.rel_type === 'm.thread' && relates.event_id ? relates.event_id : undefined
        const sessionKey = threaded ?? evt.room_id
        console.log(`[matrix] inbound eco.zoon.session_reset in ${evt.room_id} (key=${sessionKey})`)
        if (sessionKey) {
          for (const a of bindings) {
            agents.endSession(a.name, sessionKey)
            console.log(`[matrix] session reset → endSession(${a.name}, ${sessionKey})`)
          }
        }
        continue
      }
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
      logInbound(evt)
      const matches = route(evt, bindings)
      // Suppress the no-match warning for events sent by our own bots: an
      // agent's reply echoes back through the appservice and (correctly)
      // matches no one. Real "nothing matched your mention" cases — from
      // human senders — still warn.
      const senderIsBot = bindings.some((b) => b.userId === evt.sender)
      if (evt.type === 'm.room.message' && matches.length === 0 && !senderIsBot) {
        console.warn(
          `[matrix] no agent matched message in ${evt.room_id} from ${evt.sender}` +
            ` (bindings: ${bindings.map((b) => `${b.name}@${b.userId}[${b.trigger}]`).join(', ')})`,
        )
      }
      for (const a of matches) {
        console.log(`[matrix] → ${a.name} (${a.userId})`)
        // Fire-and-forget: ACP turns can take minutes (long opencode runs),
        // far longer than Tuwunel's PUT timeout. If we await here, Tuwunel
        // retries the transaction and we re-process the same message.
        void runTurn(a, evt).catch((err) => {
          console.error(`[matrix] runTurn failed for ${a.name}:`, err)
        })
      }
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
    if (!evt.room_id) return
    const relates = evt.content?.['m.relates_to']
    // Reply in-thread only when the user message was in-thread. Otherwise the
    // reply is a normal room message.
    const replyThreadRoot =
      relates?.rel_type === 'm.thread' && relates.event_id ? relates.event_id : undefined
    // Session boundary: a Matrix thread, when one was started; otherwise the
    // room itself. Same room → same session → same context, until /clear.
    const sessionKey = replyThreadRoot ?? evt.room_id
    const sessionId = await agents.ensureSession(agent.name, sessionKey)
    sessions.set(sessionId, { agent, roomId: evt.room_id, threadRoot: replyThreadRoot })
    buffers.set(sessionId, '')
    try {
      const rawBody = evt.content?.body ?? ''
      const promptText = stripMention(rawBody, agent.userId)
      await agents.prompt(agent.name, {
        threadId: sessionKey,
        content: [{ type: 'text', text: promptText }],
      })
      const text = buffers.get(sessionId) ?? ''
      if (text.length > 0) {
        await client.sendMessage({
          roomId: evt.room_id,
          asUserId: agent.userId,
          content: { msgtype: 'm.text', body: text },
          threadRoot: replyThreadRoot,
        })
      } else {
        console.warn(
          `[matrix:${agent.name}] turn finished with empty buffer (session=${sessionId}); nothing sent to ${evt.room_id}`,
        )
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

function logInbound(evt: MatrixEvent): void {
  const sender = evt.sender ?? '?'
  const room = evt.room_id ?? '?'
  const type = evt.type ?? '?'
  if (type === 'm.room.message') {
    const body = evt.content?.body ?? ''
    const mentions = (evt.content?.['m.mentions'] as { user_ids?: string[] } | undefined)?.user_ids
    const mentionsStr = mentions?.length ? ` mentions=${JSON.stringify(mentions)}` : ''
    console.log(
      `[matrix] inbound msg in ${room} from ${sender}${mentionsStr}: ${truncate(body, 200)}`,
    )
  } else {
    console.log(`[matrix] inbound ${type} in ${room} from ${sender}`)
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

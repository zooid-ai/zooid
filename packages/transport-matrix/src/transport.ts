import { Hono } from 'hono'
import { timingSafeEqual } from 'node:crypto'
import type { AcpRegistry, ApprovalCorrelator, RegisteredApproval } from '@zooid/core'
import type { AgentEvent, ContentBlock } from '@zooid/acp-client'
import { MatrixClient } from './matrix-client.js'
import { BotPool } from './bot-pool.js'
import { route, isMediaMsgtype, type AgentBinding, type ThreadState } from './router.js'
import { stripMention, extractMentions } from './mentions.js'
import { toToolCallBody, toUpdateBody, toPlanBody, toAvailableCommandsBody, toErrorBody } from './event-encoders.js'
import { classify } from '@zooid/acp-client'
import { toMatrixHtml } from './markdown-to-matrix-html.js'
import {
  PendingMediaStore,
  type PendingMediaItem,
} from './pending-media.js'
import {
  MediaClient,
  MAX_INLINE_IMAGE_BYTES,
  INLINE_IMAGE_MIMES,
} from './media-client.js'
import { writeAttachment } from './attachments.js'

export interface MediaClientLike {
  download(input: {
    mxcUri: string
    asUserId: string
    maxBytes?: number
  }): Promise<{ data: Uint8Array; contentType: string }>
  upload(input: {
    data: Uint8Array
    contentType: string
    filename?: string
    asUserId: string
  }): Promise<{ content_uri: string }>
}

export interface CreateMatrixTransportOptions {
  agents: AcpRegistry
  approvals: ApprovalCorrelator
  client: MatrixClient
  bindings: AgentBinding[]
  hsToken: string
  /** Admin Matrix user ID. When set, BotPool.bootstrap invites this user into rooms it creates. */
  adminUserId?: string
  /** Post-turn drain: keep collecting trailing `agent_message_chunk`s until the
   *  buffer is quiet for this long before flushing. Defaults to `DRAIN_QUIET_MS`.
   *  Set to 0 to disable the drain (e.g. in tests). */
  drainQuietMs?: number
  /** Hard cap on the post-turn drain. Defaults to `DRAIN_MAX_MS`. */
  drainMaxMs?: number
  /** Injected media client for downloading/uploading Matrix media. */
  media?: MediaClientLike
  /** Injected attachment writer (defaults to the real writeAttachment). */
  writeAttachmentFn?: typeof writeAttachment
  /** AS sender-bot MXID (@<sender_localpart>:<server>). Together with the agent
   *  bindings this forms the set of "our bot users" whose ad-hoc invites are
   *  declined. */
  botUserId?: string
}

interface SessionContext {
  agent: AgentBinding
  roomId: string
  /** Always set — every session is thread-scoped via agent-promotion. */
  threadRoot: string
}

interface MatrixEvent {
  type?: string
  event_id?: string
  origin_server_ts?: number
  room_id?: string
  sender?: string
  /** Present on state events (m.room.member → the affected user). */
  state_key?: string
  content?: Record<string, unknown> & {
    msgtype?: string
    body?: string
    membership?: string
    'm.relates_to'?: { rel_type?: string; event_id?: string }
  }
}

const STARTUP_GRACE_MS = 5_000

interface MediaBlocksResult {
  blocks: ContentBlock[]
  pathLines: string[]
}

async function buildMediaBlocks(
  items: PendingMediaItem[],
  opts: {
    agent: AgentBinding
    media: MediaClientLike | undefined
    writeAttachmentFn: typeof writeAttachment
    onError: (item: PendingMediaItem, err: unknown) => void
  },
): Promise<MediaBlocksResult> {
  const blocks: ContentBlock[] = []
  const pathLines: string[] = []

  if (!opts.media || items.length === 0) return { blocks, pathLines }

  for (const item of items) {
    try {
      const isInlineCandidate =
        item.msgtype === 'm.image' &&
        INLINE_IMAGE_MIMES.includes(item.info?.mimetype ?? '') &&
        (item.info?.size === undefined || item.info.size <= MAX_INLINE_IMAGE_BYTES)

      if (isInlineCandidate) {
        const { data, contentType } = await opts.media.download({
          mxcUri: item.url,
          asUserId: opts.agent.userId,
        })
        // Double-check actual size (info can lie)
        if (data.byteLength <= MAX_INLINE_IMAGE_BYTES) {
          blocks.push({
            type: 'image',
            data: Buffer.from(data).toString('base64'),
            mimeType: contentType,
          })
          continue
        }
        // Actual size exceeded cap — fall through to file route with the already-downloaded bytes
        if (opts.agent.workspaceDir) {
          const paths = opts.writeAttachmentFn({
            workspaceDir: opts.agent.workspaceDir,
            agentWorkspacePath: opts.agent.agentWorkspacePath ?? opts.agent.workspaceDir,
            eventId: item.eventId,
            filename: item.filename ?? item.body,
            data,
          })
          blocks.push({
            type: 'resource_link',
            uri: `file://${paths.agentPath}`,
            name: item.filename ?? item.body,
          })
          pathLines.push(`Attached file: ${paths.agentPath}`)
        }
      } else {
        // File route (m.file, m.video, m.audio, or oversized image)
        if (!opts.agent.workspaceDir) continue
        const { data } = await opts.media.download({
          mxcUri: item.url,
          asUserId: opts.agent.userId,
        })
        const paths = opts.writeAttachmentFn({
          workspaceDir: opts.agent.workspaceDir,
          agentWorkspacePath: opts.agent.agentWorkspacePath ?? opts.agent.workspaceDir,
          eventId: item.eventId,
          filename: item.filename ?? item.body,
          data,
        })
        blocks.push({
          type: 'resource_link',
          uri: `file://${paths.agentPath}`,
          name: item.filename ?? item.body,
          mimeType: item.info?.mimetype,
          size: item.info?.size,
        })
        pathLines.push(`Attached file: ${paths.agentPath}`)
      }
    } catch (err) {
      opts.onError(item, err)
    }
  }

  return { blocks, pathLines }
}

async function sendMediaError(
  ctx: { agent: AgentBinding; roomId: string; threadRoot: string },
  _err: unknown,
  message: string,
  client: MatrixClient,
): Promise<void> {
  await client
    .sendCustomEvent({
      roomId: ctx.roomId,
      asUserId: ctx.agent.userId,
      eventType: 'eco.zoon.error',
      content: toErrorBody(
        {
          kind: 'error' as const,
          agentId: ctx.agent.name,
          sessionId: null,
          turnId: null,
          code: 'media_failed',
          message: message.slice(0, 250),
          transient: false,
        },
        ctx.threadRoot,
      ),
    })
    .catch((e) => console.warn(`[matrix:${ctx.agent.name}] eco.zoon.error send failed:`, e))
}
const SEEN_EVENT_CAP = 5_000

// ACP only guarantees that an agent flushes pending `session/update`
// notifications before the `session/prompt` response in the *cancellation*
// path; for a normal turn the ordering is unspecified. Some agents (e.g.
// opencode) emit trailing `agent_message_chunk`s a few ms after the stopReason
// response, so finalizing the moment `prompt()` resolves truncates the reply.
// After the turn resolves we wait for the buffer to stay unchanged for
// DRAIN_QUIET_MS (debounce — re-arms on each late chunk) before flushing,
// capped at DRAIN_MAX_MS so a misbehaving stream can't hang the turn.
const DRAIN_QUIET_MS = 300
// 30s upper bound on how long we wait after `session/prompt` resolves before
// flushing whatever we have (or declaring an empty turn). Set high because
// some agents — opencode especially — resolve the prompt promise *before*
// the agent_message_chunk stream starts, and the chunk burst can be 5–15s
// after that. The drain still short-circuits via DRAIN_QUIET_MS once any
// content has settled, so this cap only kicks in for genuinely-stuck turns.
const DRAIN_MAX_MS = 30_000

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function inboundThreadRoot(evt: MatrixEvent): string | undefined {
  const r = evt.content?.['m.relates_to']
  return r?.rel_type === 'm.thread' && r.event_id ? r.event_id : undefined
}

export function createMatrixTransport(opts: CreateMatrixTransportOptions) {
  const { agents, approvals, client, bindings, hsToken, adminUserId, botUserId } = opts
  const drainQuietMs = opts.drainQuietMs ?? DRAIN_QUIET_MS
  const drainMaxMs = opts.drainMaxMs ?? DRAIN_MAX_MS
  const mediaClient = opts.media
  const writeAttachmentFn = opts.writeAttachmentFn ?? writeAttachment
  const pendingMedia = new PendingMediaStore()
  const pool = new BotPool(client, bindings)
  const ourBotUserIds = new Set<string>([
    ...(botUserId ? [botUserId] : []),
    ...bindings.map((b) => b.userId),
  ])
  const DECLINE_REASON =
    'Bots are placed in rooms only by the zooid daemon (workforce-as-code). ' +
    'Ad-hoc invites are declined — add the bot to the room in zooid.yaml.'
  const sessions = new Map<string, SessionContext>()
  const buffers = new Map<string, string>()
  // Last messageId seen per session's buffer. opencode streams each assistant
  // message under its own id with no delimiter chunk between them, so a change
  // here marks a message boundary we must break on.
  const bufferMessageIds = new Map<string, string>()
  // Per-session promise tail so out-of-band events (tool_call, plan, etc.)
  // serialize on the wire even though the ACP producer doesn't await us.
  const sendQueue = new Map<string, Promise<void>>()
  // Thread participation index: keyed by thread root event_id.
  const threadStates = new Map<string, ThreadState>()
  // Drop events older than this — Tuwunel may replay a backlog after the
  // daemon was offline, and we don't want yesterday's "@docs hi" to fire now.
  const cutoffTs = Date.now() - STARTUP_GRACE_MS
  // Idempotency: appservice transactions are retried on 4xx/5xx/timeout, and
  // the same event_id can arrive twice. Skip ones we've already taken.
  const seenEventIds = new Set<string>()
  // Messages flushed per session this turn. Lets the drain loop tell "stream
  // not started yet" (0 flushes, empty buffer → keep waiting) from "turn done,
  // last message already flushed mid-stream" (>0 flushes, empty buffer → stop).
  const flushedCounts = new Map<string, number>()
  // Commands a shim advertises during session load/new — i.e. before runTurn
  // registers the session ctx (sessions.set). Stashed here keyed by sessionId
  // and replayed once the ctx exists, so `available_commands_update` (which is
  // only ever emitted at session establishment, never mid-turn) isn't dropped.
  const pendingCommands = new Map<string, AgentEvent>()

  // Build the m.text content for a chunk of assistant prose, attaching a
  // formatted_body only when the HTML render adds rich text the plain body
  // can't carry (marked wraps plain prose in <p>…</p>; skip that — most
  // clients render `body` better than a stripped re-encode).
  const buildTextContent = (
    text: string,
  ): { msgtype: string; body: string; [k: string]: unknown } => {
    const content: { msgtype: string; body: string; [k: string]: unknown } = {
      msgtype: 'm.text',
      body: text,
    }
    const html = toMatrixHtml(text)
    if (html) {
      const escapedPlain =
        '<p>' +
        text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') +
        '</p>'
      const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
      if (norm(html) !== norm(escapedPlain)) {
        content.format = 'org.matrix.custom.html'
        content.formatted_body = html
      }
    }
    return content
  }

  // Flush a session's buffered assistant text as its own Matrix message and
  // clear the buffer. No-op on an empty buffer. The send is chained onto
  // sendQueue so it orders correctly against tool_call/plan events from the
  // same turn. The buffer is cleared synchronously (before the first await),
  // so a chunk for the *next* message that arrives during the send starts
  // fresh. Returns true when a message was enqueued.
  const flushBuffer = (sessionId: string): boolean => {
    const ctx = sessions.get(sessionId)
    const text = buffers.get(sessionId) ?? ''
    if (!ctx || text.length === 0) return false
    buffers.set(sessionId, '')
    flushedCounts.set(sessionId, (flushedCounts.get(sessionId) ?? 0) + 1)
    const content = buildTextContent(text)
    const tail = (sendQueue.get(sessionId) ?? Promise.resolve()).then(async () => {
      try {
        await client.sendMessage({
          roomId: ctx.roomId,
          asUserId: ctx.agent.userId,
          content,
          threadRoot: ctx.threadRoot,
        })
      } catch (err) {
        console.warn(`[matrix:${ctx.agent.name}] sendMessage flush failed:`, err)
      }
    })
    sendQueue.set(sessionId, tail)
    return true
  }

  agents.onEvent = async (name, event: AgentEvent) => {
    const ctx = sessions.get(event.sessionId)
    if (!ctx) {
      // available_commands_update is advertised during ensureSession (session
      // load/new), before runTurn calls sessions.set — so the ctx isn't there
      // yet. Stash the latest roster and replay it once runTurn registers the
      // ctx. Other event types arriving without a ctx are genuinely orphaned
      // (e.g. replayed history for a thread we're not handling) — drop them.
      if (event.type === 'available_commands') {
        pendingCommands.set(event.sessionId, event)
      } else {
        console.warn(`[matrix:${name}] no session ctx for ${event.sessionId}`)
      }
      return
    }

    if (event.type === 'agent_message_chunk') {
      const block = event.content as { type?: string; text?: string; data?: string; mimeType?: string }
      if (block.type === 'text' && typeof block.text === 'string') {
        // A change in ACP messageId marks the previous assistant message as
        // complete. opencode streams each assistant message under its own id
        // with no delimiter chunk between them, so a change here is the only
        // boundary signal. Flush the previous message as its own Matrix
        // message — each ACP message lands separately (and interleaves with
        // tool_call/plan events) instead of welding into one turn-end blob.
        const prevMessageId = bufferMessageIds.get(event.sessionId)
        const messageChanged =
          event.messageId !== undefined &&
          prevMessageId !== undefined &&
          event.messageId !== prevMessageId
        if (event.messageId !== undefined)
          bufferMessageIds.set(event.sessionId, event.messageId)
        // flushBuffer clears the buffer synchronously, so the new message's
        // text below starts fresh.
        if (messageChanged) flushBuffer(event.sessionId)
        // Within a single message, tokens carry their own leading spaces, so we
        // concatenate raw. An empty chunk (some agents emit one between blocks,
        // e.g. after a tool call within the same message) is a paragraph break.
        const current = buffers.get(event.sessionId) ?? ''
        const needsBreak = current.length > 0 && block.text === ''
        const prefix = needsBreak ? '\n\n' : ''
        buffers.set(event.sessionId, current + prefix + block.text)
      } else if (
        block.type === 'image' &&
        typeof block.data === 'string' &&
        typeof block.mimeType === 'string' &&
        mediaClient
      ) {
        // Outbound agent image: upload immediately and send as a threaded m.image.
        const ctx = sessions.get(event.sessionId)
        if (ctx) {
          const bytes = Buffer.from(block.data, 'base64')
          const ext = (block.mimeType.split('/')[1] ?? 'png').replace(/[^a-z0-9]/gi, '')
          const filename = `image.${ext}`
          void mediaClient
            .upload({ data: bytes, contentType: block.mimeType, filename, asUserId: ctx.agent.userId })
            .then(({ content_uri }) =>
              client.sendMessage({
                roomId: ctx.roomId,
                asUserId: ctx.agent.userId,
                threadRoot: ctx.threadRoot,
                content: {
                  msgtype: 'm.image',
                  body: filename,
                  url: content_uri,
                  info: { mimetype: block.mimeType, size: bytes.length },
                },
              }),
            )
            .catch((err) => {
              console.warn(`[matrix:${name}] outbound image upload failed:`, err)
              void sendMediaError(ctx, err, 'agent image upload failed', client)
            })
        }
      } else {
        console.warn(`[matrix:${name}] dropped chunk block type=${block.type}`, block)
      }
      return
    }

    // An out-of-band event (tool_call / tool_call_update / plan) after some
    // buffered text means that assistant message is complete — flush it first
    // so it lands before this event on the wire, preserving interleaving.
    flushBuffer(event.sessionId)

    const eventType =
      event.type === 'tool_call'
        ? 'eco.zoon.tool_call'
        : event.type === 'tool_call_update'
          ? 'eco.zoon.tool_call_update'
          : event.type === 'available_commands'
            ? 'eco.zoon.available_commands_update'
            : 'eco.zoon.plan'
    const body =
      event.type === 'tool_call'
        ? toToolCallBody(event)
        : event.type === 'tool_call_update'
          ? toUpdateBody(event)
          : event.type === 'available_commands'
            ? toAvailableCommandsBody(event)
            : toPlanBody(event)
    body['m.relates_to'] = { rel_type: 'm.thread', event_id: ctx.threadRoot }
    const tail = (sendQueue.get(event.sessionId) ?? Promise.resolve()).then(async () => {
      try {
        await client.sendCustomEvent({
          roomId: ctx.roomId,
          asUserId: ctx.agent.userId,
          eventType,
          content: body,
        })
      } catch (err) {
        console.warn(`[matrix:${name}] sendCustomEvent(${eventType}) failed:`, err)
      }
    })
    sendQueue.set(event.sessionId, tail)
    await tail
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
    content['m.relates_to'] = { rel_type: 'm.thread', event_id: ctx.threadRoot }
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
          continue
        }
        seenEventIds.add(evt.event_id)
        if (seenEventIds.size > SEEN_EVENT_CAP) {
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
      if (evt.type === 'm.room.member' && evt.content?.membership === 'invite') {
        const target = evt.state_key
        const inviter = evt.sender
        if (
          target &&
          evt.room_id &&
          ourBotUserIds.has(target) &&
          (!inviter || !ourBotUserIds.has(inviter))
        ) {
          console.log(
            `[matrix] declining ad-hoc invite for ${target} in ${evt.room_id} ` +
              `from ${inviter ?? 'unknown'}`,
          )
          await client
            .leaveRoom(evt.room_id, target, { reason: DECLINE_REASON })
            .catch((err) =>
              console.warn(`[matrix] leaveRoom(${evt.room_id}, ${target}) failed:`, err),
            )
        }
        continue
      }
      if (evt.type === 'eco.zoon.session_reset') {
        // Spec § /clear: room-scope reset is unsupported. Only thread-scoped
        // resets carry a thread relation; drop bare room-level resets silently.
        const relates = evt.content?.['m.relates_to'] as
          | { rel_type?: string; event_id?: string }
          | undefined
        const threadRoot =
          relates?.rel_type === 'm.thread' && relates.event_id ? relates.event_id : undefined
        if (!threadRoot) {
          console.log('[matrix] dropping eco.zoon.session_reset without thread relation')
          continue
        }
        console.log(`[matrix] inbound eco.zoon.session_reset in ${evt.room_id} thread=${threadRoot}`)
        for (const a of bindings) {
          agents.endSession(a.name, threadRoot)
        }
        // NB: keep threadStates intact. Per ZOD039 § /clear, only the agent's
        // session memory is wiped — thread-routing state (participants /
        // root-mentions) must survive so the next bare reply still routes to
        // the most-recently-posting agent under the same sessionKey.
        continue
      }
      if (evt.type === 'eco.zoon.interrupt') {
        const content = (evt.content ?? {}) as { session_id?: string; reason?: string }
        // Thread-relation form (client-friendly): /interrupt in a thread sends
        // an empty event with `m.relates_to: thread/<root>`. Cancel every
        // session whose threadRoot matches.
        const relates = evt.content?.['m.relates_to'] as
          | { rel_type?: string; event_id?: string }
          | undefined
        const threadRoot =
          relates?.rel_type === 'm.thread' && relates.event_id ? relates.event_id : undefined
        if (threadRoot) {
          const targets: Array<{ sessionId: string; agent: string }> = []
          for (const [sessionId, ctx] of sessions) {
            if (ctx.threadRoot === threadRoot) {
              targets.push({ sessionId, agent: ctx.agent.name })
            }
          }
          for (const t of targets) {
            console.log(
              `[matrix] interrupt session=${t.sessionId} agent=${t.agent} thread=${threadRoot}` +
                (content.reason ? ` reason=${content.reason}` : ''),
            )
            await agents.cancelSession(t.agent, t.sessionId).catch((err) => {
              console.error(`[matrix] cancelSession(${t.agent}, ${t.sessionId}) failed:`, err)
            })
          }
          continue
        }
        // Legacy form: explicit session_id in content.
        if (!content.session_id) {
          console.warn(`[matrix] eco.zoon.interrupt missing session_id (event_id=${evt.event_id})`)
          continue
        }
        const ctx = sessions.get(content.session_id)
        if (!ctx) {
          continue
        }
        console.log(
          `[matrix] interrupt session=${content.session_id} agent=${ctx.agent.name}` +
            (content.reason ? ` reason=${content.reason}` : ''),
        )
        await agents.cancelSession(ctx.agent.name, content.session_id).catch((err) => {
          console.error(`[matrix] cancelSession(${ctx.agent.name}, ${content.session_id}) failed:`, err)
        })
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

      // Capture media events in the pending store; never route them to agents.
      if (
        evt.type === 'm.room.message' &&
        isMediaMsgtype(evt.content?.msgtype) &&
        evt.room_id &&
        evt.event_id &&
        evt.sender &&
        evt.content?.url &&
        !bindings.some((b) => b.userId === evt.sender)
      ) {
        pendingMedia.add(evt.room_id, inboundThreadRoot(evt), {
          eventId: evt.event_id,
          sender: evt.sender,
          msgtype: evt.content.msgtype as string,
          body: (evt.content.body as string | undefined) ?? '',
          filename: evt.content.filename as string | undefined,
          url: evt.content.url as string,
          info: evt.content.info as PendingMediaItem['info'],
        })
        continue
      }

      // Agent-promotion: top-level inbound event becomes the thread root.
      // For in-thread messages the existing root is preserved.
      const promotedRoot = inboundThreadRoot(evt) ?? evt.event_id
      // Self-heal: if this is a thread reply but we have no in-memory state
      // for the root (e.g. daemon was just restarted), reconstruct it by
      // fetching the thread root + relations from the server.
      const inboundRel = inboundThreadRoot(evt)
      if (
        evt.type === 'm.room.message' &&
        inboundRel &&
        !threadStates.has(inboundRel) &&
        evt.room_id
      ) {
        try {
          const rebuilt = await rebuildThreadState(client, evt.room_id, inboundRel, bindings)
          threadStates.set(inboundRel, rebuilt)
          console.log(
            `[matrix] rebuilt threadState for ${inboundRel}: participants=${rebuilt.participants.join(',')} rootMentions=${rebuilt.rootMentions.join(',')}`,
          )
        } catch (err) {
          console.warn(`[matrix] failed to rebuild threadState for ${inboundRel}:`, err)
        }
      }
      const matches = route(evt, bindings, threadStates)
      // Suppress the no-match warning for events sent by our own bots.
      const senderIsBot = bindings.some((b) => b.userId === evt.sender)
      if (evt.type === 'm.room.message' && matches.length === 0 && !senderIsBot) {
        console.warn(
          `[matrix] no agent matched message in ${evt.room_id} from ${evt.sender}` +
            ` (bindings: ${bindings.map((b) => `${b.name}@${b.userId}[${b.trigger}]`).join(', ')})`,
        )
      }
      // Seed thread state for any agent mentions in this event.
      if (matches.length > 0 && promotedRoot) {
        let st = threadStates.get(promotedRoot)
        if (!st) {
          st = { participants: [], rootMentions: [] }
          threadStates.set(promotedRoot, st)
        }
        const msgMentions = new Set(extractMentions(evt as never))
        for (const a of bindings) {
          if (msgMentions.has(a.userId) && !st.rootMentions.includes(a.name)) {
            st.rootMentions.push(a.name)
          }
        }
      }
      for (const a of matches) {
        console.log(`[matrix] → ${a.name} (${a.userId})`)
        void runTurn(a, evt)
          .then(() => {
            if (!promotedRoot) return
            let st = threadStates.get(promotedRoot)
            if (!st) {
              st = { participants: [], rootMentions: [] }
              threadStates.set(promotedRoot, st)
            }
            if (st.participants.at(-1) !== a.name) st.participants.push(a.name)
          })
          .catch((err) => {
            console.error(`[matrix] runTurn failed for ${a.name}:`, err)
            const c = classify(err)
            const threadRoot = inboundThreadRoot(evt) ?? evt.event_id
            if (!threadRoot || !evt.room_id) return
            const body = toErrorBody(
              {
                kind: 'error',
                agentId: a.name,
                sessionId: null,
                turnId: null,
                code: c.code,
                message: err instanceof Error ? err.message : String(err),
                detail: err instanceof Error && err.stack ? err.stack.slice(0, 2000) : undefined,
                transient: c.transient,
                acp_error: c.acp_error,
              },
              threadRoot,
            )
            void client
              .sendCustomEvent({
                roomId: evt.room_id,
                asUserId: a.userId,
                eventType: 'eco.zoon.error',
                content: body,
              })
              .catch((e) => console.warn(`[matrix:${a.name}] eco.zoon.error send failed:`, e))
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
    if (!evt.room_id || !evt.event_id) return
    const inbound = inboundThreadRoot(evt)
    // Agent-promotion: top-level inbound becomes a thread root via the agent's
    // first reply. sessionKey is always a thread root id, never the room id.
    const threadRoot = inbound ?? evt.event_id
    const sessionKey = threadRoot
    const sessionId = await agents.ensureSession(agent.name, sessionKey, evt.room_id)
    sessions.set(sessionId, { agent, roomId: evt.room_id, threadRoot })
    buffers.set(sessionId, '')
    bufferMessageIds.delete(sessionId)
    flushedCounts.set(sessionId, 0)
    // Commands the shim advertised during ensureSession (session load/new)
    // arrived before the ctx above existed and were stashed — replay the latest
    // now that the session is fully registered, so the palette actually fills.
    const stashedCommands = pendingCommands.get(sessionId)
    if (stashedCommands) {
      pendingCommands.delete(sessionId)
      void agents.onEvent?.(agent.name, stashedCommands)
    }

    const roomId = evt.room_id
    const TYPING_TTL_MS = 30_000
    const TYPING_REFRESH_MS = 25_000
    const safeTyping = (typing: boolean) =>
      client
        .setTyping({ roomId, asUserId: agent.userId, typing, timeoutMs: TYPING_TTL_MS })
        .catch((err) => console.warn(`[matrix:${agent.name}] setTyping(${typing}) failed:`, err))
    const safePresence = (presence: 'online' | 'unavailable' | 'offline') =>
      client
        .setPresence({ asUserId: agent.userId, presence })
        .catch((err) =>
          console.warn(`[matrix:${agent.name}] setPresence(${presence}) failed:`, err),
        )

    await safeTyping(true)
    await safePresence('unavailable')
    const refresh = setInterval(() => {
      void safeTyping(true)
    }, TYPING_REFRESH_MS)

    try {
      const rawBody = evt.content?.body ?? ''
      const promptText = stripMention(rawBody, agent.userId)

      // Drain pending media for this sender+thread and prepend as ACP content blocks.
      const pendingItems = pendingMedia.drain(
        evt.room_id,
        inboundThreadRoot(evt),
        evt.sender ?? '',
      )
      const { blocks, pathLines } = await buildMediaBlocks(pendingItems, {
        agent,
        media: mediaClient,
        writeAttachmentFn,
        onError: (item, err) => {
          console.warn(`[matrix:${agent.name}] media_failed for ${item.body}:`, err)
          void sendMediaError(
            { agent, roomId: evt.room_id!, threadRoot },
            err,
            `Could not process attachment: ${item.body}`,
            client,
          )
        },
      })

      const fullPromptText = [promptText, ...pathLines].filter(Boolean).join('\n')
      await agents.prompt(agent.name, {
        threadId: sessionKey,
        channelId: evt.room_id,
        content: [...blocks, { type: 'text', text: fullPromptText }],
      })
      // Drain: the prompt promise resolves on the stopReason response, but
      // trailing chunks may still arrive (see DRAIN_* above). Wait until the
      // buffer is quiet for DRAIN_QUIET_MS, re-arming on each new chunk.
      //
      // Subtlety: some agents (opencode in particular) resolve `session/prompt`
      // *before* the agent_message_chunk stream starts. So the buffer can be
      // empty for several seconds after prompt resolves, and only then do the
      // chunks arrive. We can't break the drain just because the buffer is
      // empty — we have to wait up to drainMaxMs for chunks to *start*. Once
      // any content arrives, the "quiet for drainQuietMs" rule kicks in.
      const drainStart = Date.now()
      let drained = buffers.get(sessionId) ?? ''
      while (drainQuietMs > 0 && Date.now() - drainStart < drainMaxMs) {
        await delay(drainQuietMs)
        const next = buffers.get(sessionId) ?? ''
        // Stop when the buffer is quiet (unchanged) and either it holds the
        // final message to flush, or we already flushed a message this turn
        // (so an empty, quiet buffer means the turn is genuinely done — the
        // last message was flushed mid-stream). An unchanged *empty* buffer
        // with nothing flushed yet means the stream hasn't started; keep
        // waiting up to drainMaxMs.
        if (next === drained && (next.length > 0 || (flushedCounts.get(sessionId) ?? 0) > 0))
          break
        drained = next
      }
      // Flush the final assistant message — the one with no following messageId
      // change or out-of-band event to have triggered an earlier flush.
      flushBuffer(sessionId)
      // Wait for every queued send (mid-turn flushes, tool/plan events, final
      // flush) to settle before tearing the session down.
      await (sendQueue.get(sessionId) ?? Promise.resolve())
      if ((flushedCounts.get(sessionId) ?? 0) === 0) {
        console.warn(
          `[matrix:${agent.name}] turn finished with empty buffer (session=${sessionId}); nothing sent to ${evt.room_id}`,
        )
      }
    } finally {
      clearInterval(refresh)
      await safeTyping(false)
      await safePresence('online')
      buffers.delete(sessionId)
      bufferMessageIds.delete(sessionId)
      flushedCounts.delete(sessionId)
      sendQueue.delete(sessionId)
    }
  }

  return {
    app,
    bootstrap: async (
      bootstrapOpts: {
        spaceRoomId?: string
        asUserId?: string
        adminUserIds?: string[]
      } = {},
    ) => {
      await pool.bootstrap({ adminUserId, ...bootstrapOpts })
      await Promise.allSettled(
        bindings.map((b) =>
          client.setPresence({ asUserId: b.userId, presence: 'online' }).catch((err) => {
            console.warn(`[matrix:${b.name}] initial setPresence(online) failed:`, err)
          }),
        ),
      )
    },
    pool,
  }
}

/**
 * Reconstruct the in-memory ThreadState for a thread root by fetching the
 * root event + its thread relations from the server. Used to recover the
 * implicit-routing rule from ZOD039 § Implicit triggers in threads after a
 * daemon restart wipes the in-memory cache.
 */
export async function rebuildThreadState(
  client: MatrixClient,
  roomId: string,
  rootEventId: string,
  bindings: AgentBinding[],
): Promise<ThreadState> {
  const state: ThreadState = { participants: [], rootMentions: [] }
  // Impersonate an agent that's actually a member of this room (AS reads
  // require room membership). Falling through to the first binding would
  // 403 if that agent never joined the target room.
  const asUser = (bindings.find((b) => b.rooms.some((r) => r.alias === roomId)) ?? bindings[0])?.userId
  if (!asUser) return state

  const root = await client.fetchEvent(roomId, rootEventId, asUser)
  if (root) {
    const rootMentions = new Set(extractMentions(root as never))
    for (const a of bindings) {
      if (rootMentions.has(a.userId) && !state.rootMentions.includes(a.name)) {
        state.rootMentions.push(a.name)
      }
    }
  }

  const { chunk: thread } = await client.fetchThreadRelations({
    roomId,
    rootEventId,
    asUserId: asUser,
  })
  // Also seed root-mentions from any subsequent agent @mentions in the thread.
  for (const ev of thread) {
    const mentions = new Set(extractMentions(ev as never))
    for (const a of bindings) {
      if (mentions.has(a.userId) && !state.rootMentions.includes(a.name)) {
        state.rootMentions.push(a.name)
      }
    }
    const sender = (ev as { sender?: string }).sender
    const type = (ev as { type?: string }).type
    if (type === 'm.room.message' && sender) {
      const a = bindings.find((b) => b.userId === sender)
      if (a && state.participants.at(-1) !== a.name) state.participants.push(a.name)
    }
  }
  return state
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

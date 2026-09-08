import { Hono } from 'hono'
import { timingSafeEqual } from 'node:crypto'
import type {
  AcpRegistry,
  ApprovalCorrelator,
  RegisteredApproval,
  TaskActions,
  PendingInputRegistry,
  StartTaskResult,
  StartTaskSpec,
  ThreadCompletion,
  ThreadStartContent,
} from '@zooid/core'
import { THREAD_RESULT_FIELD, THREAD_START_FIELD } from '@zooid/core'
import type { AgentEvent, ContentBlock } from '@zooid/acp-client'
import { MatrixClient } from './matrix-client.js'
import { BotPool } from './bot-pool.js'
import { route, isMediaMsgtype, type AgentBinding, type ThreadState } from './router.js'
import { sessionKeyFor, composeHandoffKey } from './session-keys.js'
import { stripMention, extractMentions } from './mentions.js'
import {
  toToolCallBody,
  toUpdateBody,
  toPlanBody,
  toAvailableCommandsBody,
  toErrorBody,
  toTurnEndBody,
} from './event-encoders.js'
import { classify } from '@zooid/acp-client'
import { toMatrixHtml } from './markdown-to-matrix-html.js'
import { PendingMediaStore, type PendingMediaItem } from './pending-media.js'
import { MediaClient, MAX_INLINE_IMAGE_BYTES, INLINE_IMAGE_MIMES } from './media-client.js'
import { writeAttachment } from './attachments.js'
import { SyncLoop } from './sync-loop.js'
import { NO_PENDING_INPUT } from '@zooid/core'
import { TaskRegistry, MAX_OPEN_TASKS_PER_ROOM, type TaskJournal, type TaskRecord } from './task-registry.js'
import { InvocationRegistry } from './invocation-registry.js'
import { evaluateCompletion, type StopReason } from './task-completion.js'
import {
  buildAssignmentContent,
  checkDelegable,
  renderCompletionPrompt,
  renderInvocationReturn,
  renderAssigneeEnvelope,
  renderDelivery,
} from './task-dispatch.js'

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
  /**
   * Transport ingestion mode.
   * - `'appservice'` (default): Tuwunel pushes events to the HTTP transaction endpoint.
   * - `'client'`: daemon polls via impersonated `/sync` per agent (pull mode).
   */
  mode?: 'appservice' | 'client'
  /** Pull mode: load the persisted `since` cursor for an agent user ID. */
  loadSince?: (agentUserId: string) => string | null
  /** Pull mode: persist the `since` cursor after each sync poll. */
  saveSince?: (agentUserId: string, since: string) => void
  /** Durable lifecycle state; supplied by the daemon when it has a data directory. */
  taskJournal?: TaskJournal
  taskRunId?: string
  pendingInput?: PendingInputRegistry
}

interface SessionContext {
  agent: AgentBinding
  roomId: string
  /** Always set — every session is thread-scoped via agent-promotion. */
  threadRoot: string
}
interface TurnInput {
  roomId: string
  threadRoot: string
  sessionKey: string
  promptText?: string
  event?: MatrixEvent
  /**
   * Set only on the root turn of a task thread, for the assignee. Wraps the
   * computed promptText with `renderAssigneeEnvelope` in runTurn — later
   * turns in the same thread carry no envelope.
   */
  taskEnvelope?: { parentAgent: string }
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
      eventType: 'dev.zooid.error',
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
    .catch((e) => console.warn(`[matrix:${ctx.agent.name}] dev.zooid.error send failed:`, e))
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
  const {
    agents,
    approvals,
    client,
    bindings,
    hsToken,
    adminUserId,
    botUserId,
    mode = 'appservice',
  } = opts
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
  const taskRegistry = new TaskRegistry({ journal: opts.taskJournal, runId: opts.taskRunId })
  const interruptedTasks = taskRegistry.restore()
  const invocations = new InvocationRegistry()
  const pendingInput = opts.pendingInput ?? NO_PENDING_INPUT
  const bindingFor = (name: string) => bindings.find((b) => b.name === name)
  const turnQueues = new Map<string, Promise<void>>()
  // Drop events older than this — in push (appservice) mode Tuwunel may replay
  // a backlog after the daemon was offline, and we don't want yesterday's
  // "@docs hi" to fire now. In pull (client) mode the persisted `since` cursor
  // is the authoritative replay boundary (process everything after it — that's
  // exactly the offline-resume feature), so the timestamp guard must NOT apply:
  // the missed-while-offline mention is older than startup by design.
  const cutoffTs = mode === 'client' ? Number.NEGATIVE_INFINITY : Date.now() - STARTUP_GRACE_MS
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
      // m.notice, not m.text: .m.rule.suppress_notices silences the
      // chunk-storm of agent prose server-side (ZNC025 §10) instead of every
      // client having to filter it. dev.zooid.error carries the same tweak
      // for the same reason.
      msgtype: 'm.notice',
      body: text,
    }
    const html = toMatrixHtml(text)
    if (html) {
      const escapedPlain =
        '<p>' + text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</p>'
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
  const lastFlushed = new Map<string, string>()

  const flushBuffer = (sessionId: string): boolean => {
    const ctx = sessions.get(sessionId)
    const text = buffers.get(sessionId) ?? ''
    if (!ctx || text.length === 0) return false
    buffers.set(sessionId, '')
    // Kept for turn.end's push preview: the prose goes out as `m.notice` and
    // is deliberately silenced server-side, so turn.end is the only event that
    // can tell the user what the agent actually said.
    lastFlushed.set(sessionId, text)
    flushedCounts.set(sessionId, (flushedCounts.get(sessionId) ?? 0) + 1)
    const content = buildTextContent(text)
    const pendingInvocations = registerOutgoingHandoffs(sessionId, text)
    const tail = (sendQueue.get(sessionId) ?? Promise.resolve()).then(async () => {
      try {
        const { event_id } = await client.sendMessage({
          roomId: ctx.roomId,
          asUserId: ctx.agent.userId,
          content,
          threadRoot: ctx.threadRoot,
        })
        for (const invocation of pendingInvocations)
          invocations.attachCallEvent(
            invocation.invocationId,
            event_id,
            composeHandoffKey(ctx.threadRoot, event_id),
          )
      } catch (err) {
        console.warn(`[matrix:${ctx.agent.name}] sendMessage flush failed:`, err)
      }
    })
    sendQueue.set(sessionId, tail)
    return true
  }

  function registerOutgoingHandoffs(sessionId: string, text: string) {
    const ctx = sessions.get(sessionId)
    if (!ctx) return []
    const task = taskRegistry.taskForRoot(ctx.threadRoot)
    if (!task || task.phase !== 'open') return []
    const sessionKey = sessionKeyFor(ctx.agent.name, ctx.threadRoot, threadStates.get(ctx.threadRoot))
    const opened = []
    for (const userId of extractMentions({ content: { body: text } })) {
      const callee = bindings.find((binding) => binding.userId === userId)
      if (!callee || callee.name === ctx.agent.name) continue
      if (invocations.isOutstandingAncestor(sessionKey, callee.name)) {
        void client.sendCustomEvent({
          roomId: ctx.roomId, asUserId: ctx.agent.userId, eventType: 'dev.zooid.error',
          content: { body: `⚠ [handoff_circular] Cannot hand off to ${callee.name}: it is waiting on ${ctx.agent.name}`, code: 'handoff_circular', message: `Cannot hand off to ${callee.name}: it is waiting on ${ctx.agent.name}`, transient: false, 'm.relates_to': { rel_type: 'm.thread', event_id: ctx.threadRoot } },
        })
        continue
      }
      opened.push(invocations.open({ taskId: task.taskId, callerAgent: ctx.agent.name, callerSessionKey: sessionKey, calleeAgent: callee.name }))
      taskRegistry.clearSummary(task.taskId)
    }
    return opened
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
      const block = event.content as {
        type?: string
        text?: string
        data?: string
        mimeType?: string
      }
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
        if (event.messageId !== undefined) bufferMessageIds.set(event.sessionId, event.messageId)
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
            .upload({
              data: bytes,
              contentType: block.mimeType,
              filename,
              asUserId: ctx.agent.userId,
            })
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
        ? 'dev.zooid.tool_call'
        : event.type === 'tool_call_update'
          ? 'dev.zooid.tool_call_update'
          : event.type === 'available_commands'
            ? 'dev.zooid.available_commands_update'
            : 'dev.zooid.plan'
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
    content['m.relates_to'] = {
      rel_type: 'm.thread',
      event_id: ctx.threadRoot,
    }
    if (handle.toolKind !== undefined) content.tool_kind = handle.toolKind
    if (handle.toolTitle !== undefined) content.tool_title = handle.toolTitle
    if (handle.toolInput !== undefined) content.tool_input = handle.toolInput
    void client.sendCustomEvent({
      roomId: ctx.roomId,
      asUserId: ctx.agent.userId,
      eventType: 'dev.zooid.approval_request',
      content,
    })
  })

  function reportTurnFailure(agent: AgentBinding, input: TurnInput, err: unknown): void {
    console.error(`[matrix] runTurn failed for ${agent.name}:`, err)
    const c = classify(err)
    const body = toErrorBody(
      {
        kind: 'error',
        agentId: agent.name,
        sessionId: null,
        turnId: null,
        code: c.code,
        message: err instanceof Error ? err.message : String(err),
        detail: err instanceof Error && err.stack ? err.stack.slice(0, 2000) : undefined,
        transient: c.transient,
        acp_error: c.acp_error,
      },
      input.threadRoot,
    )
    void client
      .sendCustomEvent({
        roomId: input.roomId,
        asUserId: agent.userId,
        eventType: 'dev.zooid.error',
        content: body,
      })
      .catch((e) => console.warn(`[matrix:${agent.name}] dev.zooid.error send failed:`, e))
  }

  function enqueueTurn(agent: AgentBinding, input: TurnInput): Promise<void> {
    const key = `${agent.name}::${input.sessionKey}`
    const chained = (turnQueues.get(key) ?? Promise.resolve())
      .then(() => runTurn(agent, input))
      .then(() => {
        let st = threadStates.get(input.threadRoot)
        if (!st) {
          st = {
            participants: [],
            rootMentions: [],
            callers: {},
            handoffs: {},
          }
          threadStates.set(input.threadRoot, st)
        }
        if (st.participants.at(-1) !== agent.name) st.participants.push(agent.name)
      })
      .catch((err) => reportTurnFailure(agent, input, err))
    turnQueues.set(key, chained)
    void chained.finally(() => {
      if (turnQueues.get(key) === chained) turnQueues.delete(key)
    })
    return chained
  }

  async function handleInboundEvent(evt: MatrixEvent): Promise<void> {
    if (evt.event_id) {
      if (seenEventIds.has(evt.event_id)) {
        return
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
      return
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
      return
    }
    if (evt.type === 'dev.zooid.session_reset') {
      // Spec § /clear: room-scope reset is unsupported. Only thread-scoped
      // resets carry a thread relation; drop bare room-level resets silently.
      const relates = evt.content?.['m.relates_to'] as
        | { rel_type?: string; event_id?: string }
        | undefined
      const threadRoot =
        relates?.rel_type === 'm.thread' && relates.event_id ? relates.event_id : undefined
      if (!threadRoot) {
        console.log('[matrix] dropping dev.zooid.session_reset without thread relation')
        return
      }
      console.log(`[matrix] inbound dev.zooid.session_reset in ${evt.room_id} thread=${threadRoot}`)
      // [[ZOD071]]: a thread's sessions are the thread-level one plus one per
      // handoff arc — end them all. Reset events aren't m.room.message, so
      // the self-heal rebuild above doesn't cover them; rebuild here if the
      // daemon restarted since the arcs were minted.
      if (!threadStates.has(threadRoot) && evt.room_id) {
        try {
          threadStates.set(
            threadRoot,
            await rebuildThreadState(client, evt.room_id, threadRoot, bindings),
          )
        } catch (err) {
          console.warn(`[matrix] failed to rebuild threadState for reset ${threadRoot}:`, err)
        }
      }
      const st = threadStates.get(threadRoot)
      for (const a of bindings) {
        agents.endSession(a.name, threadRoot)
        taskRegistry.bumpGeneration(a.name, threadRoot)
        for (const arc of st?.handoffs[a.name] ?? []) {
          const key = composeHandoffKey(threadRoot, arc)
          agents.endSession(a.name, key)
          taskRegistry.bumpGeneration(a.name, key)
        }
      }
      // NB: keep threadStates intact. Per ZOD039 § /clear, only the agent's
      // session memory is wiped — thread-routing state (participants /
      // root-mentions) must survive so the next bare reply still routes to
      // the most-recently-posting agent under the same sessionKey.
      return
    }
    if (evt.type === 'dev.zooid.interrupt') {
      const content = (evt.content ?? {}) as {
        session_id?: string
        reason?: string
      }
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
        // A live session will report ACP's `cancelled` stop reason and finish
        // in its turn boundary, preserving any prose it already emitted. A
        // restored/no-session task has no such boundary, so close it here.
        const task = taskRegistry.taskForRoot(threadRoot)
        if (task?.phase === 'open' && !targets.some((t) => t.agent === task.assignee)) {
          const assignee = bindingFor(task.assignee)
          if (assignee)
            await finishTask(task, {
              agent: assignee,
              completion: { agent: assignee.name, thread_id: threadRoot, status: 'cancelled' },
            })
        }
        return
      }
      // Legacy form: explicit session_id in content.
      if (!content.session_id) {
        console.warn(`[matrix] dev.zooid.interrupt missing session_id (event_id=${evt.event_id})`)
        return
      }
      const ctx = sessions.get(content.session_id)
      if (!ctx) {
        return
      }
      console.log(
        `[matrix] interrupt session=${content.session_id} agent=${ctx.agent.name}` +
          (content.reason ? ` reason=${content.reason}` : ''),
      )
      await agents.cancelSession(ctx.agent.name, content.session_id).catch((err) => {
        console.error(
          `[matrix] cancelSession(${ctx.agent.name}, ${content.session_id}) failed:`,
          err,
        )
      })
      return
    }
    if (evt.type === 'dev.zooid.approval_response') {
      const content = (evt.content ?? {}) as {
        approval_id?: string
        session_id?: string
        decision?: string
        option_id?: string
      }
      if (!content.session_id || !content.approval_id || !content.decision) return
      const decision = content.option_id
        ? { decision: content.decision, optionId: content.option_id }
        : { decision: content.decision }
      const ok = approvals.resolve(content.session_id, content.approval_id, decision as never)
      if (!ok) console.warn(`[matrix] unknown approval ${content.approval_id}`)
      return
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
      return
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
    const startField = evt.content?.[THREAD_START_FIELD] as ThreadStartContent | undefined
    if (startField?.attempt_id && !inboundRel && evt.event_id)
      taskRegistry.adopt(startField.attempt_id, evt.event_id)
    if (evt.content?.[THREAD_RESULT_FIELD] !== undefined) return
    const taskRec = promotedRoot ? taskRegistry.taskForRoot(promotedRoot) : undefined
    const taskCtx =
      taskRec && taskRec.phase !== 'reserved'
        ? {
            assignee: taskRec.assignee,
            isRoot: !inboundRel && evt.event_id === taskRec.threadRoot,
          }
        : undefined
    let matches = route(evt, bindings, threadStates, taskCtx)
    // In a delegated task, agent-to-agent messages dispatch only when the
    // outgoing flush registered a matching invocation. This prevents a
    // circular handoff that was visibly refused from still waking its target.
    if (taskCtx && !taskCtx.isRoot && evt.event_id && bindings.some((b) => b.userId === evt.sender)) {
      const invocation = invocations.byCallEvent(evt.event_id)
      matches = invocation ? matches.filter((match) => match.name === invocation.calleeAgent) : []
    }
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
        st = { participants: [], rootMentions: [], callers: {}, handoffs: {} }
        threadStates.set(promotedRoot, st)
      }
      if (taskCtx?.isRoot) {
        if (!st.rootMentions.includes(taskRec!.assignee)) st.rootMentions.push(taskRec!.assignee)
      } else {
        const msgMentions = new Set(extractMentions(evt as never))
        const senderAgent = bindings.find((b) => b.userId === evt.sender)
        for (const a of bindings) {
          if (!msgMentions.has(a.userId)) continue
          if (!st.rootMentions.includes(a.name)) st.rootMentions.push(a.name)
          if (senderAgent && a.name !== senderAgent.name) {
            st.callers[a.name] = senderAgent.name
            if (evt.event_id) {
              const arcs = (st.handoffs[a.name] ??= [])
              if (!arcs.includes(evt.event_id)) arcs.push(evt.event_id)
            }
          }
        }
      }
    }
    for (const a of matches) {
      console.log(`[matrix] → ${a.name} (${a.userId})`)
      if (!promotedRoot || !evt.room_id) continue
      const sessionKey = sessionKeyFor(a.name, promotedRoot, threadStates.get(promotedRoot))
      const taskEnvelope =
        taskCtx?.isRoot && a.name === taskRec!.assignee
          ? { parentAgent: taskRec!.parent.agent }
          : undefined
      void enqueueTurn(a, {
        roomId: evt.room_id,
        threadRoot: promotedRoot,
        sessionKey,
        event: evt,
        ...(taskEnvelope ? { taskEnvelope } : {}),
      })
    }
  }

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
    const body = (await c.req.json().catch(() => ({}))) as {
      events?: MatrixEvent[]
    }
    for (const evt of body.events ?? []) {
      await handleInboundEvent(evt)
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

  async function runTurn(agent: AgentBinding, input: TurnInput): Promise<void> {
    const { roomId, threadRoot, sessionKey } = input
    // Agent-promotion: top-level inbound becomes a thread root via the agent's
    // first reply.
    // [[ZOD071]]: the session key is the agent's current handoff arc when it
    // has one, else the thread-level key. The raw threadRoot still travels
    // separately: outbound events relate to it, and it is the context ref so
    // zooid_get_history reads the real thread.
    const sessionId = await agents.ensureSession(agent.name, sessionKey, roomId, threadRoot)
    sessions.set(sessionId, { agent, roomId, threadRoot })
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

    const TYPING_TTL_MS = 30_000
    const TYPING_REFRESH_MS = 25_000
    const safeTyping = (typing: boolean) =>
      client
        .setTyping({
          roomId,
          asUserId: agent.userId,
          typing,
          timeoutMs: TYPING_TTL_MS,
        })
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

    let turnError: unknown
    let stopReason: StopReason | undefined
    try {
      const rawBody = input.event?.content?.body ?? ''
      const strippedPromptText = input.promptText ?? stripMention(rawBody, agent.userId)
      const promptText = input.taskEnvelope
        ? renderAssigneeEnvelope({
            parentAgent: input.taskEnvelope.parentAgent,
            prompt: strippedPromptText,
          })
        : strippedPromptText

      // Drain pending media for this sender+thread and prepend as ACP content blocks.
      const pendingItems = pendingMedia.drain(
        roomId,
        input.event ? inboundThreadRoot(input.event) : undefined,
        input.event?.sender ?? '',
      )
      const { blocks, pathLines } = await buildMediaBlocks(pendingItems, {
        agent,
        media: mediaClient,
        writeAttachmentFn,
        onError: (item, err) => {
          console.warn(`[matrix:${agent.name}] media_failed for ${item.body}:`, err)
          void sendMediaError(
            { agent, roomId, threadRoot },
            err,
            `Could not process attachment: ${item.body}`,
            client,
          )
        },
      })

      const fullPromptText = [promptText, ...pathLines].filter(Boolean).join('\n')
      const promptResult = await agents.prompt(agent.name, {
        threadId: sessionKey,
        channelId: roomId,
        contextThreadId: threadRoot,
        content: [...blocks, { type: 'text', text: fullPromptText }],
      })
      stopReason = promptResult.stopReason as StopReason
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
        if (next === drained && (next.length > 0 || (flushedCounts.get(sessionId) ?? 0) > 0)) break
        drained = next
      }
      // Flush the final assistant message — the one with no following messageId
      // change or out-of-band event to have triggered an earlier flush.
      flushBuffer(sessionId)
    } catch (err) {
      turnError = err
      throw err
    } finally {
      clearInterval(refresh)
      await safeTyping(false)
      await safePresence('online')
      // Wait for every queued send (mid-turn flushes, tool/plan events, final
      // flush) to settle before announcing the turn's end — and run this even
      // when the turn above threw, so the room never hangs on a spinner.
      await (sendQueue.get(sessionId) ?? Promise.resolve())
      const producedOutput = (flushedCounts.get(sessionId) ?? 0) > 0
      if (!producedOutput) {
        console.warn(
          `[matrix:${agent.name}] turn finished with empty buffer (session=${sessionId}); nothing sent to ${roomId}`,
        )
      }
      // Turn boundary for [[ZOD076]] and push notifications. Sent after the
      // send queue drains so it lands *after* the prose it announces — a
      // turn.end arriving first would notify the user to look at a room that
      // has nothing in it yet.
      await client
        .sendCustomEvent({
          roomId,
          asUserId: agent.userId,
          eventType: 'dev.zooid.turn.end',
          content: toTurnEndBody(
            {
              agentId: agent.name,
              sessionId,
              producedOutput,
              lastMessage: lastFlushed.get(sessionId),
            },
            threadRoot,
          ),
        })
        .catch((e) => console.warn(`[matrix:${agent.name}] turn.end send failed:`, e))
      const task = taskRegistry.taskForRoot(threadRoot)
      const invocation = invocations.forCalleeSession(sessionKey)
      const isAssignee = task?.phase === 'open' && task.assignee === agent.name && task.threadRoot === sessionKey
      if (task?.phase === 'open' && (isAssignee || invocation?.state === 'outstanding')) {
        const decision = evaluateCompletion({
          agent: agent.name,
          threadId: isAssignee ? threadRoot : (invocation?.calleeSessionKey ?? sessionKey),
          stopReason,
          error: turnError,
          summary: isAssignee ? task.summary : undefined,
          prose: lastFlushed.get(sessionId),
          outstanding: invocations.outstandingFor(sessionKey).length,
          awaitingHuman: pendingInput.countFor(sessionKey),
        })
        if (decision.decision === 'finish') {
          if (isAssignee) await finishTask(task, { agent, completion: decision.completion })
          else if (invocation) returnInvocation(invocation, decision.completion, task)
        }
      }
      buffers.delete(sessionId)
      bufferMessageIds.delete(sessionId)
      flushedCounts.delete(sessionId)
      lastFlushed.delete(sessionId)
      sendQueue.delete(sessionId)
    }
  }

  async function finishTask(
    task: TaskRecord,
    ctx: { agent: AgentBinding; completion: ThreadCompletion },
  ): Promise<void> {
    const threadId = task.threadRoot!
    const completion = ctx.completion
    if (!taskRegistry.close(task.taskId)) return
    const cancelled = invocations.cancelForTask(task.taskId)
    pendingInput.cancelFor([threadId, ...cancelled.map((i) => i.calleeSessionKey).filter((x): x is string => Boolean(x))])
    await client.sendCustomEvent({
      roomId: task.roomId,
      asUserId: ctx.agent.userId,
      eventType: THREAD_RESULT_FIELD,
      content: {
        ...completion,
        'm.relates_to': { rel_type: 'm.thread', event_id: threadId },
      },
    })
    if (task.summary && task.summary !== completion.output?.text)
      await client.sendMessage({
        roomId: task.roomId,
        asUserId: ctx.agent.userId,
        threadRoot: threadId,
        content: buildTextContent(task.summary),
      })
    if (task.notify === 'none') return
    const parent = bindingFor(task.parent.agent)
    await client.sendMessage({
      roomId: task.roomId,
      asUserId: ctx.agent.userId,
      threadRoot: task.parent.threadRoot,
      content: {
        msgtype: 'm.notice',
        body: renderCompletionPrompt(completion),
        [THREAD_RESULT_FIELD]: completion,
      },
    })
    if (
      !parent ||
      taskRegistry.generationOf(task.parent.agent, task.parent.sessionKey) !==
        task.parent.generation
    )
      return
    void enqueueTurn(parent, {
      roomId: task.roomId,
      threadRoot: task.parent.threadRoot,
      sessionKey: task.parent.sessionKey,
      promptText: renderCompletionPrompt(completion),
    })
  }

  function returnInvocation(invocation: import('@zooid/core').InvocationRecord, completion: ThreadCompletion, task: TaskRecord): void {
    const resolved = invocations.resolve(invocation.invocationId)
    if (!resolved || task.phase !== 'open') return
    const caller = bindingFor(resolved.callerAgent)
    if (!caller || !task.threadRoot) return
    void enqueueTurn(caller, {
      roomId: task.roomId,
      threadRoot: task.threadRoot,
      sessionKey: resolved.callerSessionKey,
      promptText: renderInvocationReturn(completion),
    })
  }

  const taskActions: TaskActions = {
    async startTasks(caller, input) {
      const notify = input.notify ?? 'caller'
      const results: StartTaskResult[] = new Array(input.tasks.length)
      const callerBinding = bindingFor(caller.agentName)
      const enclosing = taskRegistry.taskForRoot(caller.threadRoot)
      const admitted: Array<{
        index: number
        spec: StartTaskSpec
        rec: TaskRecord
      }> = []
      for (const [index, spec] of input.tasks.entries()) {
        if (!callerBinding) {
          results[index] = {
            agent: spec.agent,
            status: 'refused',
            reason: 'unknown_caller',
          }
          continue
        }
        if (enclosing) {
          results[index] = {
            agent: spec.agent,
            status: 'refused',
            reason:
              'depth_limit: this thread is itself a delegated task. Do the work here, or @mention another agent in this thread to hand off.',
          }
          continue
        }
        const admission = checkDelegable(spec.agent, caller.channelId, bindings)
        if (!admission.ok) {
          results[index] = {
            agent: spec.agent,
            status: 'refused',
            reason: admission.reason,
          }
          continue
        }
        const rec = taskRegistry.reserve({
          roomId: caller.channelId,
          assignee: spec.agent,
          notify,
          parent: {
            agent: caller.agentName,
            threadRoot: caller.threadRoot,
            sessionKey: caller.sessionKey,
            generation: taskRegistry.generationOf(caller.agentName, caller.sessionKey),
          },
        })
        if (!rec) {
          results[index] = {
            agent: spec.agent,
            status: 'refused',
            reason: `at_capacity: ${MAX_OPEN_TASKS_PER_ROOM} tasks are already open in this room. Wait for one to finish.`,
          }
          continue
        }
        admitted.push({ index, spec, rec })
      }
      await Promise.all(
        admitted.map(async ({ index, spec, rec }) => {
          const assignee = bindingFor(spec.agent)!
          const content = buildAssignmentContent({
            assigneeUserId: assignee.userId,
            prompt: spec.prompt,
            start: {
              version: 1,
              assignee: spec.agent,
              attempt_id: rec.attemptId,
              parent: {
                agent: rec.parent.agent,
                thread_root: rec.parent.threadRoot,
                session_key: rec.parent.sessionKey,
              },
              notify,
            },
          })
          const post = () =>
            client.sendMessage({
              roomId: caller.channelId,
              asUserId: callerBinding!.userId,
              content,
              txnId: rec.attemptId,
            })
          try {
            const { event_id } = await post()
            taskRegistry.activate(rec.taskId, event_id)
            results[index] = {
              agent: spec.agent,
              status: 'started',
              thread_id: event_id,
            }
          } catch {
            try {
              const { event_id } = await post()
              taskRegistry.activate(rec.taskId, event_id)
              results[index] = {
                agent: spec.agent,
                status: 'started',
                thread_id: event_id,
              }
            } catch (second) {
              const status = (second as { status?: number }).status
              if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
                taskRegistry.abandon(rec.taskId)
                results[index] = {
                  agent: spec.agent,
                  status: 'failed',
                  reason: `post_failed: ${String((second as Error).message)}`,
                }
              } else {
                taskRegistry.markUncertain(rec.taskId)
                results[index] = {
                  agent: spec.agent,
                  status: 'failed',
                  reason: `post_uncertain: ${String((second as Error).message)}`,
                  attempt_id: rec.attemptId,
                }
              }
            }
          }
        }),
      )
      return { results, notify, delivery: renderDelivery(notify) }
    },
    async completeTask(caller, input) {
      const summary = input.summary.trim()
      if (!summary) return { status: 'refused', reason: 'summary must be non-empty' }
      const rec = taskRegistry.openTaskFor(caller.agentName, caller.threadRoot)
      if (!rec || rec.threadRoot !== caller.sessionKey)
        return {
          status: 'refused',
          reason: 'no_open_task: this session is not the assignee of an open task',
        }
      if (invocations.outstandingFor(caller.sessionKey).length)
        return { status: 'refused', reason: 'outstanding_handoff: wait for delegated work to return' }
      return { status: taskRegistry.recordSummary(rec.taskId, summary) }
    },
    async describeRole(caller) {
      const enclosing = taskRegistry.taskForRoot(caller.threadRoot)
      const openTask = taskRegistry.openTaskFor(caller.agentName, caller.threadRoot)
      return {
        is_task_assignee: openTask !== undefined && openTask.threadRoot === caller.sessionKey,
        can_start_task_threads: enclosing === undefined,
      }
    },
  }

  // Journal reconciliation happens after functions are initialized, but before
  // the daemon starts accepting work. A prior run has no ACP turn to supply a
  // terminal boundary, so publish its durable cancellation directly.
  queueMicrotask(() => {
    for (const task of interruptedTasks) {
      if (!task.threadRoot) continue
      const assignee = bindingFor(task.assignee)
      if (!assignee) continue
      const completion: ThreadCompletion = {
        agent: task.assignee, thread_id: task.threadRoot, status: 'cancelled', reason: 'interrupted_by_restart',
      }
      void client.sendCustomEvent({
        roomId: task.roomId, asUserId: assignee.userId, eventType: THREAD_RESULT_FIELD,
        content: { ...completion, 'm.relates_to': { rel_type: 'm.thread', event_id: task.threadRoot } },
      })
      if (task.notify !== 'none') {
        const parent = bindingFor(task.parent.agent)
        if (
          parent &&
          taskRegistry.generationOf(task.parent.agent, task.parent.sessionKey) === task.parent.generation
        ) {
          void client.sendMessage({
            roomId: task.roomId,
            asUserId: assignee.userId,
            threadRoot: task.parent.threadRoot,
            content: {
              msgtype: 'm.notice',
              body: renderCompletionPrompt(completion),
              [THREAD_RESULT_FIELD]: completion,
            },
          })
          void enqueueTurn(parent, { roomId: task.roomId, threadRoot: task.parent.threadRoot, sessionKey: task.parent.sessionKey, promptText: renderCompletionPrompt(completion) })
        }
      }
    }
  })

  const syncLoops: SyncLoop[] | undefined =
    mode === 'client'
      ? bindings.map(
          (b) =>
            new SyncLoop({
              client: client as never,
              asUserId: b.userId,
              loadSince: () => opts.loadSince?.(b.userId) ?? null,
              saveSince: (since) => opts.saveSince?.(b.userId, since),
              onEvent: (evt) => handleInboundEvent(evt as MatrixEvent),
            }),
        )
      : undefined

  return {
    app,
    taskActions,
    syncLoops,
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
  const state: ThreadState = {
    participants: [],
    rootMentions: [],
    callers: {},
    handoffs: {},
  }
  // Impersonate an agent that's actually a member of this room (AS reads
  // require room membership). Falling through to the first binding would
  // 403 if that agent never joined the target room.
  const asUser = (bindings.find((b) => b.rooms.some((r) => r.alias === roomId)) ?? bindings[0])
    ?.userId
  if (!asUser) return state

  const root = await client.fetchEvent(roomId, rootEventId, asUser)
  if (root) {
    const rootMentions = new Set(extractMentions(root as never))
    const rootSender = (root as { sender?: string }).sender
    const rootSenderAgent = rootSender ? bindings.find((b) => b.userId === rootSender) : undefined
    for (const a of bindings) {
      if (!rootMentions.has(a.userId)) continue
      if (!state.rootMentions.includes(a.name)) state.rootMentions.push(a.name)
      if (rootSenderAgent && a.name !== rootSenderAgent.name) {
        state.callers[a.name] = rootSenderAgent.name
        const arcs = (state.handoffs[a.name] ??= [])
        if (!arcs.includes(rootEventId)) arcs.push(rootEventId)
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
    const evSender = (ev as { sender?: string }).sender
    const evSenderAgent = evSender ? bindings.find((b) => b.userId === evSender) : undefined
    const evId = (ev as { event_id?: string }).event_id
    for (const a of bindings) {
      if (!mentions.has(a.userId)) continue
      if (!state.rootMentions.includes(a.name)) state.rootMentions.push(a.name)
      if (evSenderAgent && a.name !== evSenderAgent.name) {
        state.callers[a.name] = evSenderAgent.name
        if (evId) {
          const arcs = (state.handoffs[a.name] ??= [])
          if (!arcs.includes(evId)) arcs.push(evId)
        }
      }
    }
    const type = (ev as { type?: string }).type
    if (type === 'm.room.message' && evSender) {
      const a = bindings.find((b) => b.userId === evSender)
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

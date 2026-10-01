import {
  ElicitationUnsupportedError,
  type ElicitationResponse,
} from '@zooid/acp-client'
import {
  unsupportedSchemaReasons,
  validateElicitationContent,
  type ElicitationCorrelator,
  type ElicitationResolution,
  type PendingElicitation,
} from '@zooid/core'
import {
  ElicitationEventType,
  parseElicitationResponse,
  toElicitationRejectedBody,
  toElicitationRequestBody,
  toElicitationResolvedBody,
} from './elicitation-events.js'
import { Hono } from 'hono'
import { timingSafeEqual, randomUUID } from 'node:crypto'
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
  HandoffInput,
  HandoffOutput,
} from '@zooid/core'
import { THREAD_RESULT_FIELD, THREAD_START_FIELD } from '@zooid/core'
import type { AgentEvent, ContentBlock } from '@zooid/acp-client'
import { MatrixClient } from './matrix-client.js'
import { BotPool } from './bot-pool.js'
import {
  route,
  isMediaMsgtype,
  isReturnRoute,
  wouldCycleCallers,
  type AgentBinding,
  type ThreadState,
} from './router.js'
import { sessionKeyFor, composeHandoffKey } from './session-keys.js'
import { PendingReturns, type ReleasedReturn } from './pending-returns.js'
import { stripMention, extractMentions } from './mentions.js'
import { WorkforceDirectory } from './workforce-publisher.js'
import { buildHandoffContent, readHandoff, resolveHandoffTarget, type HandoffCandidate } from './handoff.js'
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
  renderHandoffReturn,
  renderHandoffDelivery,
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
  elicitations?: ElicitationCorrelator
  elicitationRetryDelayMs?: number
  /** Deferred-return fallback window. Defaults to `RETURN_GRACE_MS`. */
  returnGraceMs?: number
  /** Fallback for a hold on a callee on another workstation ([[ZOD092]] §5). Defaults to `REMOTE_RETURN_GRACE_MS`. */
  remoteReturnGraceMs?: number
}

interface SessionContext {
  agent: AgentBinding
  roomId: string
  /** Always set — every session is thread-scoped via agent-promotion. */
  threadRoot: string
  /** This turn's session key ([[ZOD071]] arc, or the thread-level key). */
  sessionKey: string
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

/**
 * Fallback for a held return whose callee turn this process cannot account
 * for: a restart mid-turn, a lost `dev.zooid.turn.end`, someone posting as
 * the agent's user. Never a deadline on a running turn ([[ZOD088]]).
 */
const RETURN_GRACE_MS = 90_000

/**
 * A remote callee's running turn is invisible here; one long tool call emits a
 * single tool_call. The window exists only for a remote daemon that died
 * mid-turn ([[ZOD092]] §5). A human interrupt releases immediately.
 */
const REMOTE_RETURN_GRACE_MS = 30 * 60_000

/** Sender-attributable liveness that re-arms a timed return ([[ZOD088]]). */
const ACTIVITY_EVENTS = new Set(['dev.zooid.tool_call', 'dev.zooid.tool_call_update', 'dev.zooid.plan'])

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
  const returnGraceMs = opts.returnGraceMs ?? RETURN_GRACE_MS
  const remoteReturnGraceMs = opts.remoteReturnGraceMs ?? REMOTE_RETURN_GRACE_MS
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
  const pendingInput = opts.pendingInput ?? opts.elicitations ?? NO_PENDING_INPUT
  const bindingFor = (name: string) => bindings.find((b) => b.name === name)
  const turnQueues = new Map<string, Promise<void>>()
  // Every workstation's agents, from the space's roster state events; the
  // router uses it to tell another daemon's agent from a human.
  const workforce = new WorkforceDirectory()
  /**
   * Ordinary-thread handoff returns, held until the callee's turn ends
   * leaving no open call ([[ZOD088]]). Delegated task threads never reach
   * this: [[ZOD072]] / [[ZOD079]] own their returns.
   */
  const returns = new PendingReturns({ graceMs: returnGraceMs, remoteGraceMs: remoteReturnGraceMs, onRelease: deliverReturn })

  const isLocal = (userId: string) => bindings.some((b) => b.userId === userId)
  const agentName = (userId: string) =>
    bindings.find((b) => b.userId === userId)?.name ?? workforce.nameOf(userId) ?? userId
  /** [[ZOD092]] One open handoff per caller per thread: `<callerMxid>::<threadRoot>` → callee MXID. */
  const openHandoffs = new Map<string, string>()
  const openKey = (caller: string, threadRoot: string) => `${caller}::${threadRoot}`
  function handoffCandidates(): HandoffCandidate[] {
    const byId = new Map<string, HandoffCandidate>()
    for (const e of workforce.entries()) byId.set(e.userId, e)
    for (const b of bindings)
      byId.set(b.userId, {
        userId: b.userId,
        name: b.name,
        workstation: byId.get(b.userId)?.workstation,
        rooms: b.rooms.map((r) => r.alias),
      })
    return [...byId.values()]
  }

  // Release and queue are one transition: the caller's turn is enqueued on its
  // session FIFO in the same tick the hold clears.
  function deliverReturn(r: ReleasedReturn): void {
    for (const target of r.targets) {
      openHandoffs.delete(openKey(target.userId, r.threadRoot))
      console.log(`[matrix] → ${target.name} (${target.userId}) [return from ${agentName(r.callee)}]`)
      void enqueueTurn(target, {
        roomId: r.roomId,
        threadRoot: r.threadRoot,
        sessionKey: sessionKeyFor(target.userId, r.threadRoot, threadStates.get(r.threadRoot)),
        promptText: renderHandoffReturn({ callee: agentName(r.callee), text: r.text }),
      })
    }
  }
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

  const elicitations = opts.elicitations
  const elicitationRetryDelayMs = opts.elicitationRetryDelayMs ?? 500
  // Per request: the publish attempt, so 'resolved' never races the card.
  const elicitationPublishes = new Map<string, Promise<void>>()

  async function sendWithRetry(input: {
    roomId: string
    asUserId: string
    eventType: string
    content: Record<string, unknown>
    txnId: string
  }): Promise<{ event_id: string }> {
    let last: unknown
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        // Same txnId every attempt: a lost ack cannot duplicate the event.
        return await client.sendCustomEvent(input)
      } catch (err) {
        last = err
        console.warn(`[matrix] ${input.eventType} attempt ${attempt} failed:`, err)
        if (attempt < 3 && elicitationRetryDelayMs > 0) await delay(elicitationRetryDelayMs * attempt)
      }
    }
    throw last
  }

  if (elicitations) {
    agents.onElicitationRequest = async (name, req, signal) => {
      const ctx = sessions.get(req.sessionId)
      if (!ctx || ctx.agent.name !== name) {
        console.warn(`[matrix:${name}] elicitation for ${req.sessionId} has no Matrix thread`)
        throw new ElicitationUnsupportedError(`session ${req.sessionId} has no Matrix thread`)
      }
      const reasons = unsupportedSchemaReasons(req.requestedSchema)
      if (reasons.length > 0) {
        console.warn(`[matrix:${name}] unsupported elicitation schema: ${reasons.join('; ')}`)
        throw new ElicitationUnsupportedError(reasons.join('; '))
      }
      const { record, response } = elicitations.register({
        agentName: name,
        sessionId: req.sessionId,
        sessionKey: ctx.sessionKey,
        roomId: ctx.roomId,
        threadRoot: ctx.threadRoot,
        request: req,
        signal,
      })
      // Prose the agent wrote before asking lands above the card.
      flushBuffer(req.sessionId)
      void client
        .setTyping({ roomId: ctx.roomId, asUserId: ctx.agent.userId, typing: false })
        .catch(() => {})
      const publish = (sendQueue.get(req.sessionId) ?? Promise.resolve()).then(async () => {
        if (elicitations.get(record.requestId)?.state !== 'pending') return
        try {
          const { event_id } = await sendWithRetry({
            roomId: ctx.roomId,
            asUserId: ctx.agent.userId,
            eventType: ElicitationEventType.Request,
            content: toElicitationRequestBody(record),
            txnId: `elicit-req-${record.requestId}`,
          })
          elicitations.attachRequestEvent(record.requestId, event_id)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error(`[matrix:${name}] could not publish elicitation ${record.requestId}: ${msg}`)
          elicitations.fail(record.requestId, new Error(`could not publish elicitation card: ${msg}`))
        }
      })
      elicitationPublishes.set(record.requestId, publish)
      // The send queue waits for the card, never for the answer — later
      // sends and the turn's final drain must not block on a human.
      sendQueue.set(req.sessionId, publish)
      try { return await response } finally { elicitationPublishes.delete(record.requestId) }
    }

    elicitations.on('resolved', (res: ElicitationResolution) => {
      const { record } = res
      const agent = bindingFor(record.agentName)
      if (!agent) return
      void (elicitationPublishes.get(record.requestId) ?? Promise.resolve()).then(async () => {
        elicitationPublishes.delete(record.requestId)
        const current = elicitations.get(record.requestId)
        if (!current?.requestEventId) return // never shown; nothing to close
        await sendWithRetry({
          roomId: record.roomId,
          asUserId: agent.userId,
          eventType: ElicitationEventType.Resolved,
          content: toElicitationResolvedBody({ ...res, record: current }),
          txnId: `elicit-res-${record.requestId}`,
        }).catch((err) => console.error(`[matrix] elicitation_resolved ${record.requestId} not sent:`, err))
        // Answered mid-turn: show the agent working again right away.
        if (
          elicitations.countForSession(record.sessionId) === 0 &&
          turnQueues.has(`${record.agentName}::${record.sessionKey}`)
        ) {
          void client
            .setTyping({ roomId: record.roomId, asUserId: agent.userId, typing: true, timeoutMs: 30_000 })
            .catch(() => {})
        }
      })
    })
  }

  function sendElicitationRejected(
    record: PendingElicitation,
    responseEventId: string,
    reason: 'invalid' | 'stale',
    errors?: Record<string, string>,
  ): void {
    const agent = bindingFor(record.agentName)
    if (!agent) return
    void sendWithRetry({
      roomId: record.roomId,
      asUserId: agent.userId,
      eventType: ElicitationEventType.Rejected,
      content: toElicitationRejectedBody({ record, responseEventId, reason, errors }),
      txnId: `elicit-rej-${responseEventId}`,
    }).catch((err) => console.warn(`[matrix] elicitation_rejected not sent:`, err))
  }

  async function handleElicitationResponse(evt: MatrixEvent): Promise<void> {
    if (!elicitations) return
    const parsed = parseElicitationResponse(evt)
    const sender = evt.sender
    if (!parsed || !sender || !evt.event_id || !evt.room_id) return
    // Agents and service identities never answer on a human's behalf.
    if (ourBotUserIds.has(sender) || workforce.agentIds.has(sender)) {
      console.warn(`[matrix] ignoring elicitation response from agent ${sender}`)
      return
    }
    // A response can arrive while a lost publication acknowledgement is being retried.
    await elicitationPublishes.get(parsed.requestId)
    const record = elicitations.get(parsed.requestId)
    // Unknown: another daemon's question, or one from before a restart.
    if (!record) return
    if (
      record.roomId !== evt.room_id ||
      record.threadRoot !== parsed.threadRoot ||
      record.requestEventId !== parsed.requestEventId
    ) {
      console.warn(`[matrix] elicitation response ${evt.event_id} does not match request ${record.requestId}`)
      return
    }
    const agent = bindingFor(record.agentName)
    if (!agent) return
    try {
      const { joined } = await client.getJoinedMembers(record.roomId, agent.userId)
      if (!Object.hasOwn(joined, sender)) {
        console.warn(`[matrix] elicitation response from non-member ${sender}`)
        return
      }
    } catch (err) {
      console.warn(`[matrix] membership check failed for ${sender}; response ignored:`, err)
      return
    }
    if (elicitations.get(record.requestId)?.state !== 'pending') return sendElicitationRejected(record, evt.event_id, 'stale')
    let response: ElicitationResponse
    if (parsed.action === 'accept') {
      const v = validateElicitationContent(record.requestedSchema, parsed.content)
      if (!v.ok) {
        if (elicitations.get(record.requestId)?.state === 'pending') {
          sendElicitationRejected(record, evt.event_id, 'invalid', v.errors)
        } else {
          sendElicitationRejected(record, evt.event_id, 'stale')
        }
        return
      }
      response = { action: 'accept', content: v.content }
    } else {
      response = { action: parsed.action }
    }
    // Atomic: the first eligible response wins; the rest are stale.
    if (!elicitations.settle(record.requestId, response, { respondedBy: sender, responseEventId: evt.event_id })) {
      sendElicitationRejected(record, evt.event_id, 'stale')
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

  let workforceSpaceId: string | undefined

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
    if (evt.type === 'dev.zooid.workforce') {
      if (evt.room_id === workforceSpaceId && evt.state_key !== undefined)
        workforce.apply(evt.state_key, evt.content)
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
      // /clear must not allow a pre-reset deferred return to wake an agent up
      // later via either its old turn.end or the fallback timer.
      returns.dropThread(threadRoot)
      // Spec § Cancellation: clearing cancels a waiting turn's questions and the
      // turn itself before its memory is replaced. Sessions without an open
      // question are left alone (ZOD039 behaviour unchanged).
      if (elicitations) {
        for (const [sessionId, ctx] of [...sessions]) {
          if (ctx.threadRoot !== threadRoot || elicitations.countForSession(sessionId) === 0) continue
          elicitations.cancelSession(sessionId, 'clear')
          await agents.cancelSession(ctx.agent.name, sessionId).catch((err) => {
            console.error(`[matrix] cancelSession(${ctx.agent.name}, ${sessionId}) on clear failed:`, err)
          })
        }
      }
      // [[ZOD092]] No open handoff in this thread survives a reset.
      for (const k of [...openHandoffs.keys()]) if (k.endsWith(`::${threadRoot}`)) openHandoffs.delete(k)
      // [[ZOD071]]: a thread's sessions are the thread-level one plus one per
      // handoff arc — end them all. Reset events aren't m.room.message, so
      // the self-heal rebuild above doesn't cover them; rebuild here if the
      // daemon restarted since the arcs were minted.
      if (!threadStates.has(threadRoot) && evt.room_id) {
        try {
          threadStates.set(
            threadRoot,
            await rebuildThreadState(client, evt.room_id, threadRoot, bindings, workforce.agentIds),
          )
        } catch (err) {
          console.warn(`[matrix] failed to rebuild threadState for reset ${threadRoot}:`, err)
        }
      }
      const st = threadStates.get(threadRoot)
      const cleanup: Array<{ name: string; key: string; result: Promise<void> }> = []
      for (const a of bindings) {
        cleanup.push({
          name: a.name,
          key: threadRoot,
          result: Promise.resolve().then(() => agents.endSession(a.name, threadRoot)),
        })
        taskRegistry.bumpGeneration(a.name, threadRoot)
        for (const arc of st?.handoffs[a.userId] ?? []) {
          const key = composeHandoffKey(threadRoot, arc)
          cleanup.push({
            name: a.name,
            key,
            result: Promise.resolve().then(() => agents.endSession(a.name, key)),
          })
          taskRegistry.bumpGeneration(a.name, key)
        }
      }
      const results = await Promise.allSettled(cleanup.map((item) => item.result))
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          console.warn(`[matrix] session reset cleanup failed for ${cleanup[index]!.name}/${cleanup[index]!.key}:`, result.reason)
        }
      })
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
        returns.interrupt(threadRoot)
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
      returns.interrupt(ctx.threadRoot)
      await agents.cancelSession(ctx.agent.name, content.session_id).catch((err) => {
        console.error(
          `[matrix] cancelSession(${ctx.agent.name}, ${content.session_id}) failed:`,
          err,
        )
      })
      return
    }
    if (evt.type === ElicitationEventType.Response) {
      await handleElicitationResponse(evt)
      return
    }
    // Our own request/resolved/rejected echoes are control events, never prompts.
    if (
      evt.type === ElicitationEventType.Request ||
      evt.type === ElicitationEventType.Resolved ||
      evt.type === ElicitationEventType.Rejected
    ) {
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

    // The callee's turn boundary: the daemon sends this only after that turn's
    // whole send queue has drained, so every message it produced has already
    // arrived above. Release the return it was holding.
    if (evt.type === 'dev.zooid.turn.end') {
      const endedRoot = inboundThreadRoot(evt)
      // [[ZOD092]] Keyed by the Matrix sender, which the homeserver
      // authenticates: a forged turn.end from anyone else names a different
      // MXID and releases nothing. Local and remote callees alike.
      if (endedRoot && evt.sender) returns.turnEnded(evt.sender, endedRoot)
      return
    }

    // [[ZOD088]] Tool activity is liveness: it re-arms a timed hold's fallback.
    // These events never route, so nothing below applies to them.
    if (ACTIVITY_EVENTS.has(evt.type ?? '')) {
      const root = inboundThreadRoot(evt)
      if (evt.sender && root) returns.activity(evt.sender, root)
      return
    }

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
        const rebuilt = await rebuildThreadState(
          client,
          evt.room_id,
          inboundRel,
          bindings,
          workforce.agentIds,
        )
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
    // Another workstation's agent posting makes it the thread's last poster,
    // so a human's bare reply goes to it and not to our last local poster.
    // Our own agents are recorded at their turn end (enqueueTurn).
    const inboundState = inboundRel ? threadStates.get(inboundRel) : undefined
    if (
      inboundState &&
      evt.type === 'm.room.message' &&
      evt.sender &&
      isRemoteAgent(evt.sender, evt.content?.msgtype, bindings, workforce.agentIds) &&
      inboundState.participants.at(-1) !== evt.sender
    )
      inboundState.participants.push(evt.sender)
    let matches = route(evt, bindings, threadStates, taskCtx, workforce.agentIds)
    // In a delegated task, agent-to-agent messages dispatch only when the
    // outgoing flush registered a matching invocation. This prevents a
    // circular handoff that was visibly refused from still waking its target.
    // Only while the task is open: handoff() registers invocations only then,
    // so a closed task's thread routes like an ordinary thread.
    if (
      taskCtx &&
      taskRec!.phase === 'open' &&
      !taskCtx.isRoot &&
      evt.event_id &&
      bindings.some((b) => b.userId === evt.sender)
    ) {
      let invocation = invocations.byCallEvent(evt.event_id)
      // The sync echo of a handoff can arrive before its send resolves, so
      // handoff() hasn't attached the event id yet. Match on the call_id the
      // event carries and attach it here instead.
      const call = readHandoff(evt.content)
      if (!invocation && call && call.caller === evt.sender) {
        invocation = invocations.byCallId(call.call_id)
        if (invocation && !invocation.callEventId)
          invocations.attachCallEvent(
            invocation.invocationId,
            evt.event_id,
            composeHandoffKey(inboundRel ?? evt.event_id, evt.event_id),
          )
      }
      matches = invocation ? matches.filter((match) => match.name === invocation!.calleeAgent) : []
    }
    // [[ZOD039]] A return fires at the callee's turn boundary, not per message.
    // Every tool call forces a buffer flush, so one turn posts many
    // `m.room.message`s; routing each as a return woke the caller once per
    // chunk and the pair read as re-triggering each other. Hold them and let
    // the sender's `dev.zooid.turn.end` release the lot as a single wake.
    if (evt.type === 'm.room.message' && promotedRoot && evt.room_id && evt.sender) {
      const senderIsAgentId = isLocal(evt.sender) || workforce.agentIds.has(evt.sender)
      if (senderIsAgentId) {
        const st = threadStates.get(promotedRoot)
        const held = matches.filter((m) => isReturnRoute(evt, m, st))
        if (held.length > 0) {
          matches = matches.filter((m) => !held.includes(m))
          returns.hold(evt.sender, promotedRoot, evt.room_id, held, evt.content?.body, {
            remote: !isLocal(evt.sender),
          })
          console.log(
            `[matrix] holding return ${agentName(evt.sender)} → ${held.map((m) => m.name).join(',')} ` +
              `until turn end (thread=${promotedRoot})`,
          )
        }
      }
    }

    // Suppress the no-match warning for events sent by our own bots.
    const senderIsBot = bindings.some((b) => b.userId === evt.sender)
    if (evt.type === 'm.room.message' && matches.length === 0 && !senderIsBot) {
      console.warn(
        `[matrix] no agent matched message in ${evt.room_id} from ${evt.sender}` +
          ` (bindings: ${bindings.map((b) => `${b.name}@${b.userId}[${b.trigger}]`).join(', ')})`,
      )
    }
    // [[ZOD092]] Call edges come only from structured handoffs, keyed by MXID,
    // whichever workstations the two ends live on — so every daemon holds the
    // whole call graph and acts on the edges where it hosts an end. Recorded
    // BEFORE dispatch: the callee's session key is the arc minted here.
    const handoff = readHandoff(evt.content)
    const callEdge =
      handoff && evt.type === 'm.room.message' && handoff.caller === evt.sender && promotedRoot
        ? handoff
        : undefined
    if (promotedRoot && (matches.length > 0 || callEdge)) {
      let st = threadStates.get(promotedRoot)
      if (!st) {
        st = { participants: [], rootMentions: [], callers: {}, handoffs: {} }
        threadStates.set(promotedRoot, st)
      }
      if (taskCtx?.isRoot) {
        if (!st.rootMentions.includes(taskRec!.assignee)) st.rootMentions.push(taskRec!.assignee)
      } else {
        const senderIsAgentId =
          !!evt.sender && (isLocal(evt.sender) || workforce.agentIds.has(evt.sender))
        if (!senderIsAgentId) {
          const msgMentions = new Set(extractMentions(evt as never))
          for (const a of bindings)
            if (msgMentions.has(a.userId) && !st.rootMentions.includes(a.name))
              st.rootMentions.push(a.name)
        }
        if (
          callEdge &&
          callEdge.callee !== callEdge.caller &&
          !wouldCycleCallers(st.callers, callEdge.callee, callEdge.caller)
        ) {
          st.callers[callEdge.callee] = callEdge.caller
          if (evt.event_id) {
            const arcs = (st.handoffs[callEdge.callee] ??= [])
            if (!arcs.includes(evt.event_id)) arcs.push(evt.event_id)
          }
          // [[ZOD088]] The caller's daemon owns the return: open the callee's
          // pending return here, and keep the caller's own return (if it is
          // itself serving a call) pending on this one.
          if (!taskCtx && evt.room_id) {
            const callerBinding = bindings.find((b) => b.userId === callEdge.caller)
            if (callerBinding?.trigger === 'mention')
              returns.open(callEdge.callee, promotedRoot, evt.room_id, callerBinding, {
                remote: !isLocal(callEdge.callee),
              })
            returns.markDelegated(callEdge.caller, promotedRoot)
          }
        }
      }
    }
    for (const a of matches) {
      console.log(`[matrix] → ${a.name} (${a.userId})`)
      if (!promotedRoot || !evt.room_id) continue
      const sessionKey = sessionKeyFor(a.userId, promotedRoot, threadStates.get(promotedRoot))
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

  async function runTurnBody(agent: AgentBinding, input: TurnInput): Promise<void> {
    const { roomId, threadRoot, sessionKey } = input
    // Agent-promotion: top-level inbound becomes a thread root via the agent's
    // first reply.
    // [[ZOD071]]: the session key is the agent's current handoff arc when it
    // has one, else the thread-level key. The raw threadRoot still travels
    // separately: outbound events relate to it, and it is the context ref so
    // zooid_get_history reads the real thread.
    const sessionId = await agents.ensureSession(agent.name, sessionKey, roomId, threadRoot)
    sessions.set(sessionId, { agent, roomId, threadRoot, sessionKey })
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
      if (elicitations && elicitations.countForSession(sessionId) > 0) return
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

  // [[ZOD088]] A turn running here is closed by its own turn end; the return
  // fallback never races it. A turn blocked on an approval or a human answer
  // is still inside agents.prompt, so it counts as running too.
  async function runTurn(agent: AgentBinding, input: TurnInput): Promise<void> {
    returns.turnStarted(agent.userId, input.threadRoot)
    try {
      await runTurnBody(agent, input)
    } finally {
      returns.turnFinished(agent.userId, input.threadRoot)
    }
  }

  async function finishTask(
    task: TaskRecord,
    ctx: { agent: AgentBinding; completion: ThreadCompletion },
  ): Promise<void> {
    const threadId = task.threadRoot!
    const completion = ctx.completion
    if (!taskRegistry.close(task.taskId)) return
    // [[ZOD092]] Any pre-task caller's open handoff into this task thread.
    for (const k of [...openHandoffs.keys()]) if (k.endsWith(`::${threadId}`)) openHandoffs.delete(k)
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
              'depth_limit: this thread is itself a delegated task. Do the work here, or call zooid_handoff to hand off in this thread.',
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
        can_handoff: bindingFor(caller.agentName) !== undefined,
      }
    },
    async handoff(caller, input: HandoffInput): Promise<HandoffOutput> {
      const callerBinding = bindingFor(caller.agentName)
      if (!callerBinding) return { status: 'refused', reason: 'unknown_caller' }
      const prompt = input.prompt.trim()
      if (!prompt) return { status: 'refused', reason: 'prompt must be non-empty' }
      const resolved = resolveHandoffTarget(input.agent, caller.channelId, handoffCandidates())
      if (!resolved.ok) return { status: 'refused', reason: resolved.reason }
      const target = resolved.target
      if (target.userId === callerBinding.userId)
        return { status: 'refused', reason: 'self: you cannot hand off to yourself' }
      const st = threadStates.get(caller.threadRoot)
      if (st && wouldCycleCallers(st.callers, target.userId, callerBinding.userId))
        return {
          status: 'refused',
          reason: `already_waiting_on_you: ${target.name} is waiting on your result. End your turn — your result returns to ${target.name} automatically.`,
        }
      const task = taskRegistry.taskForRoot(caller.threadRoot)
      const inTask = task?.phase === 'open'
      if (inTask && !isLocal(target.userId))
        return {
          status: 'refused',
          reason: 'remote_in_task: a task thread hands off only to agents on this workstation',
        }
      const key = openKey(callerBinding.userId, caller.threadRoot)
      const busy = inTask
        ? invocations.outstandingFor(caller.sessionKey).length > 0
        : openHandoffs.has(key)
      if (busy)
        return {
          status: 'refused',
          reason:
            'already_open: you already have a handoff open in this thread. End your turn and wait for it, or use zooid_start_task_threads for parallel work.',
        }
      const callId = randomUUID()
      const invocation = inTask
        ? invocations.open({
            taskId: task!.taskId,
            callerAgent: callerBinding.name,
            callerSessionKey: caller.sessionKey,
            calleeAgent: target.name,
            callId,
          })
        : undefined
      if (invocation) taskRegistry.clearSummary(task!.taskId)
      else openHandoffs.set(key, target.userId)

      const content = buildHandoffContent({
        callId,
        caller: callerBinding.userId,
        callee: target.userId,
        prompt,
      })
      // Post through the caller's own send queue, after any prose it flushed
      // before the tool call, so the thread reads in order.
      const liveSession = [...sessions].find(
        ([, c]) => c.agent.name === callerBinding.name && c.sessionKey === caller.sessionKey,
      )?.[0]
      if (liveSession) flushBuffer(liveSession)
      let eventId: string | undefined
      const send = async () => {
        const { event_id } = await client.sendMessage({
          roomId: caller.channelId,
          asUserId: callerBinding.userId,
          content,
          threadRoot: caller.threadRoot,
        })
        eventId = event_id
      }
      const tail = (liveSession ? (sendQueue.get(liveSession) ?? Promise.resolve()) : Promise.resolve()).then(send)
      if (liveSession) sendQueue.set(liveSession, tail.catch(() => {}))
      try {
        await tail
      } catch (err) {
        openHandoffs.delete(key)
        if (invocation) invocations.resolve(invocation.invocationId)
        return { status: 'refused', reason: `post_failed: ${String((err as Error).message)}` }
      }
      if (invocation && eventId)
        invocations.attachCallEvent(invocation.invocationId, eventId, composeHandoffKey(caller.threadRoot, eventId))
      return {
        status: 'started',
        call_id: callId,
        callee: target.userId,
        delivery: renderHandoffDelivery(target.name),
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
      const { spaceRoomId, asUserId } = bootstrapOpts
      if (spaceRoomId && asUserId) {
        workforceSpaceId = spaceRoomId
        try {
          workforce.load(await client.fetchRoomState(spaceRoomId, asUserId))
        } catch (err) {
          console.warn('[matrix] workforce roster load failed:', err)
        }
      }
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
  knownAgentIds?: ReadonlySet<string>,
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

  const { chunk: thread } = await client.fetchThreadRelations({
    roomId,
    rootEventId,
    asUserId: asUser,
  })
  const root = await client.fetchEvent(roomId, rootEventId, asUser)
  const events = [...(root ? [root] : []), ...thread]
  for (const ev of events) {
    const evSender = (ev as { sender?: string }).sender
    const evId = (ev as { event_id?: string }).event_id
    const content = (ev as { content?: unknown }).content
    const senderIsAgentId =
      !!evSender && (bindings.some((b) => b.userId === evSender) || knownAgentIds?.has(evSender) === true)
    // Human mentions seed rootMentions (names, local agents only).
    if (!senderIsAgentId) {
      const mentions = new Set(extractMentions(ev as never))
      for (const a of bindings)
        if (mentions.has(a.userId) && !state.rootMentions.includes(a.name)) state.rootMentions.push(a.name)
    }
    // [[ZOD092]] Call edges only from structured handoffs whose caller is the sender.
    const h = readHandoff(content)
    if (h && h.caller === evSender && h.callee !== h.caller && !wouldCycleCallers(state.callers, h.callee, h.caller)) {
      state.callers[h.callee] = h.caller
      if (evId) {
        const arcs = (state.handoffs[h.callee] ??= [])
        if (!arcs.includes(evId)) arcs.push(evId)
      }
    }
    // participants: unchanged logic (local name or remote MXID), for m.room.message only,
    // and never for the root event (keep the existing behaviour: only thread events add participants).
  }
  for (const ev of thread) {
    const type = (ev as { type?: string }).type
    const evSender = (ev as { sender?: string }).sender
    if (type === 'm.room.message' && evSender) {
      const a = bindings.find((b) => b.userId === evSender)
      const msgtype = (ev as { content?: { msgtype?: string } }).content?.msgtype
      const participant = a
        ? a.name
        : isRemoteAgent(evSender, msgtype, bindings, knownAgentIds)
          ? evSender
          : undefined
      if (participant && state.participants.at(-1) !== participant)
        state.participants.push(participant)
    }
  }
  return state
}

/**
 * Another workstation's agent: not ours, but in the space's merged roster —
 * or posting an m.notice, which Matrix bots do and clients never do.
 */
function isRemoteAgent(
  sender: string,
  msgtype: string | undefined,
  bindings: AgentBinding[],
  knownAgentIds: ReadonlySet<string> | undefined,
): boolean {
  if (bindings.some((b) => b.userId === sender)) return false
  return knownAgentIds?.has(sender) === true || msgtype === 'm.notice'
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

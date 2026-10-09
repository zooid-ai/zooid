import type {
  TransportContextProvider,
  HistoryOptions,
  HistoryPage,
  Member,
  RoomInfo,
  SendMessageInput,
  SendMessageResult,
  Message,
  ThreadOverview,
  ThreadOverviewPage,
} from '@zooid/core'
import type { MatrixClient } from './matrix-client.js'
import type { RoomBinding } from '@zooid/core'

interface MatrixMessageEvent {
  event_id: string
  sender: string
  origin_server_ts: number
  type: string
  content?: {
    msgtype?: string
    body?: string
    'm.relates_to'?: { rel_type?: string; event_id?: string }
  }
  unsigned?: {
    'm.relations'?: {
      'm.thread'?: {
        count?: number
        latest_event?: { origin_server_ts?: number }
      }
    }
  }
}

export interface MatrixContextProviderOpts {
  client: MatrixClient
  /**
   * The **agent's own** Matrix user (`@{workstation}.{name}:server`), which
   * every read is impersonated as via `?user_id=`. Not the AS bot: that would
   * read every room on the homeserver and make this class the only thing
   * standing between an agent and someone else's conversation.
   *
   * This is load-bearing. It is what makes the homeserver — not our own
   * bookkeeping — the authorization boundary for context reads, so a room or
   * thread the agent is not in fails at Matrix with 403/404. Anything that
   * widens who can name a room (a CLI, a new tool parameter) is safe only
   * while this holds.
   */
  asUserId: string
  /** Map of Matrix user IDs → agent names, for is_agent / agent_name flags. */
  agentBots: Map<string, string>
  /**
   * This agent's own room bindings — the live array `BotPool.bootstrap`
   * rewrites `.alias` on in place, so reads through this field after
   * bootstrap see canonical room IDs. Backs `getRooms()` and the
   * `sendMessage()` authorization check. Absent/empty = no rooms known
   * (context providers built before this field existed, or in tests that
   * don't exercise either method).
   */
  rooms?: RoomBinding[]
}

/** Events fetched per round when collecting recent threads. */
const RECENT_THREADS_BATCH = 50
/** Max /messages rounds per getRecentThreads call (peeks not counted). */
const RECENT_THREADS_MAX_ROUNDS = 5

/** Index of the nth non-null item (1-based n), or -1 if there are fewer. */
function indexOfNth<T>(items: Array<T | null>, n: number): number {
  let seen = 0
  for (let i = 0; i < items.length; i++) {
    if (items[i] !== null && ++seen === n) return i
  }
  return -1
}

export class MatrixContextProvider implements TransportContextProvider {
  constructor(private readonly opts: MatrixContextProviderOpts) {}

  async getRoomHistory(channelId: string, hopts: HistoryOptions): Promise<HistoryPage> {
    // Server-side filter: only `m.room.message` events. Without this we'd
    // burn the page budget on reactions, `dev.zooid.*` custom events, typing
    // notifications, etc., and routinely return empty pages with a stale
    // `has_more` cursor.
    const filter = { types: ['m.room.message'] }
    const { chunk, end } = await this.opts.client.fetchRoomMessages({
      roomId: channelId,
      asUserId: this.opts.asUserId,
      limit: hopts.limit,
      from: hopts.before,
      filter,
    })
    const messages: Message[] = []
    for (let i = chunk.length - 1; i >= 0; i--) {
      const ev = chunk[i] as unknown as MatrixMessageEvent
      const msg = this.toMessage(ev)
      if (msg) messages.push(msg)
    }
    const hasMore = await this.hasMessagesPast(channelId, end, filter)
    return {
      messages,
      next_before: hasMore ? end : undefined,
      has_more: hasMore,
    }
  }

  async getRecentThreads(
    channelId: string,
    hopts: HistoryOptions,
  ): Promise<ThreadOverviewPage> {
    // Server-side filter: `m.room.message` only, and ask to exclude thread
    // replies (`not_rel_types: ['m.thread']`). Tuwunel honors `types` but
    // ignores `not_rel_types` (zooid-ai/zooid#123), so replies still arrive
    // and are dropped by toThreadOverview(). A page of `limit` events can
    // then hold few or no entries. Instead, fetch in batches and keep going
    // until `limit` entries are collected, history runs out, or the round
    // budget is spent.
    const filter = { types: ['m.room.message'], not_rel_types: ['m.thread'] }
    const limit = hopts.limit ?? 50
    const threads: ThreadOverview[] = []
    let cursor = hopts.before
    for (let round = 0; round < RECENT_THREADS_MAX_ROUNDS; round++) {
      const remaining = limit - threads.length
      const page = await this.opts.client.fetchRoomMessages({
        roomId: channelId,
        asUserId: this.opts.asUserId,
        limit: Math.max(remaining, RECENT_THREADS_BATCH),
        from: cursor,
        filter,
      })
      // /messages returns newest-first; keep that order for the overview.
      const entries = (page.chunk as unknown as MatrixMessageEvent[]).map((ev) =>
        this.toThreadOverview(ev),
      )
      const cut = indexOfNth(entries, remaining)
      if (cut !== -1) {
        // The batch holds more entries than we need. A Matrix cursor can't
        // point inside a page, so returning the first `remaining` entries
        // with `page.end` would skip the rest. Re-request exactly the events
        // through the last entry kept so `end` lands right after it.
        let end = page.end
        let kept = entries.slice(0, cut + 1)
        if (cut < entries.length - 1) {
          const exact = await this.opts.client.fetchRoomMessages({
            roomId: channelId,
            asUserId: this.opts.asUserId,
            limit: cut + 1,
            from: cursor,
            filter,
          })
          end = exact.end
          kept = (exact.chunk as unknown as MatrixMessageEvent[]).map((ev) =>
            this.toThreadOverview(ev),
          )
        }
        for (const t of kept) if (t) threads.push(t)
        const hasMore = await this.hasMessagesPast(channelId, end, filter)
        return { threads, next_before: hasMore ? end : undefined, has_more: hasMore }
      }
      for (const t of entries) if (t) threads.push(t)
      // An empty batch or a missing cursor means history is exhausted. A
      // non-empty batch doesn't prove the opposite (Tuwunel returns `end` on
      // the oldest page), but the next round's fetch settles it.
      if (page.chunk.length === 0 || page.end === undefined) {
        return { threads, next_before: undefined, has_more: false }
      }
      cursor = page.end
    }
    // Round budget spent: return what we have and let the caller page on.
    const hasMore = await this.hasMessagesPast(channelId, cursor, filter)
    return { threads, next_before: hasMore ? cursor : undefined, has_more: hasMore }
  }

  /** A top-level entry or thread root for the overview; null for anything else. */
  private toThreadOverview(ev: MatrixMessageEvent): ThreadOverview | null {
    if (ev.type !== 'm.room.message') return null
    // m.notice: agent prose sends as m.notice so
    // .m.rule.suppress_notices silences the chunk storm server-side
    // (ZNC025 §10) — a thread root sent by an agent must still surface here.
    if (
      (ev.content?.msgtype !== 'm.text' && ev.content?.msgtype !== 'm.notice') ||
      typeof ev.content.body !== 'string'
    )
      return null
    const relatesTo = ev.content['m.relates_to']
    if (relatesTo?.rel_type === 'm.thread') return null // skip thread replies
    const agent = this.opts.agentBots.get(ev.sender)
    const bundled = ev.unsigned?.['m.relations']?.['m.thread']
    const replyCount = bundled?.count ?? 0
    const latestTs = bundled?.latest_event?.origin_server_ts ?? ev.origin_server_ts
    return {
      id: ev.event_id,
      sender: ev.sender,
      text: ev.content.body,
      timestamp: new Date(ev.origin_server_ts).toISOString(),
      is_agent: agent !== undefined,
      ...(agent !== undefined ? { agent_name: agent } : {}),
      reply_count: replyCount,
      last_activity_at: new Date(latestTs).toISOString(),
    }
  }

  /**
   * Whether `/messages` has anything older than the cursor `end`. Cursor
   * presence says nothing: Tuwunel returns a cursor even on an exhausted
   * page (zooid-ai/zooid#21, #111), and a short page proves nothing either
   * because the filter can thin a page while older events remain and the
   * homeserver may clamp `limit`. So peek one event past the cursor with the
   * same filter.
   */
  private async hasMessagesPast(
    channelId: string,
    end: string | undefined,
    filter: { types?: string[]; not_rel_types?: string[] },
  ): Promise<boolean> {
    if (end === undefined) return false
    const peek = await this.opts.client.fetchRoomMessages({
      roomId: channelId,
      asUserId: this.opts.asUserId,
      limit: 1,
      from: end,
      filter,
    })
    return peek.chunk.length > 0
  }

  async getThreadHistory(
    channelId: string,
    threadId: string,
    hopts: HistoryOptions,
  ): Promise<HistoryPage> {
    // Root event first (only on the first page when no pagination cursor).
    const messages: Message[] = []
    if (!hopts.before) {
      const root = (await this.opts.client.fetchEvent(
        channelId,
        threadId,
        this.opts.asUserId,
      )) as unknown as MatrixMessageEvent | null
      if (root) {
        const rootMsg = this.toMessage(root)
        if (rootMsg) messages.push({ ...rootMsg, thread_id: threadId })
      }
    }
    const { chunk, next_batch } = await this.opts.client.fetchThreadRelations({
      roomId: channelId,
      rootEventId: threadId,
      asUserId: this.opts.asUserId,
      limit: hopts.limit,
      from: hopts.before,
    })
    for (const ev of chunk as unknown as MatrixMessageEvent[]) {
      const reply = this.toMessage(ev)
      if (reply) messages.push({ ...reply, thread_id: threadId })
    }
    // Tuwunel returns `next_batch` even when the page is exhausted, so cursor
    // presence says nothing about whether messages remain (zooid-ai/zooid#21).
    // A short page doesn't prove exhaustion either: homeservers clamp `limit`
    // on their side. So whenever a cursor is present, peek one event past it.
    let hasMore = false
    if (next_batch !== undefined) {
      const peek = await this.opts.client.fetchThreadRelations({
        roomId: channelId,
        rootEventId: threadId,
        asUserId: this.opts.asUserId,
        limit: 1,
        from: next_batch,
      })
      hasMore = peek.chunk.length > 0
    }
    return {
      messages,
      next_before: hasMore ? next_batch : undefined,
      has_more: hasMore,
    }
  }

  private toMessage(ev: MatrixMessageEvent): Message | null {
    if (ev.type !== 'm.room.message') return null
    const msgtype = ev.content?.msgtype
    const body = ev.content?.body
    const agent = this.opts.agentBots.get(ev.sender)
    const relatesTo = ev.content?.['m.relates_to']
    const threadId =
      relatesTo?.rel_type === 'm.thread' && relatesTo.event_id ? relatesTo.event_id : undefined

    // Media events render as context placeholders
    if (msgtype === 'm.image' || msgtype === 'm.file' || msgtype === 'm.video' || msgtype === 'm.audio') {
      const kind = msgtype.slice(2) // 'image', 'file', 'video', 'audio'
      const name = typeof body === 'string' && body ? body : 'untitled'
      return {
        id: ev.event_id,
        sender: ev.sender,
        text: `[${kind}: ${name}]`,
        timestamp: new Date(ev.origin_server_ts).toISOString(),
        is_agent: agent !== undefined,
        ...(agent !== undefined ? { agent_name: agent } : {}),
        ...(threadId !== undefined ? { thread_id: threadId } : {}),
      }
    }

    // Agent prose sends as m.notice (ZNC025 §10); m.text is human prose.
    if ((msgtype !== 'm.text' && msgtype !== 'm.notice') || typeof body !== 'string') return null
    return {
      id: ev.event_id,
      sender: ev.sender,
      text: body,
      timestamp: new Date(ev.origin_server_ts).toISOString(),
      is_agent: agent !== undefined,
      ...(agent !== undefined ? { agent_name: agent } : {}),
      ...(threadId !== undefined ? { thread_id: threadId } : {}),
    }
  }

  async getChannelMembers(channelId: string): Promise<Member[]> {
    const { joined } = await this.opts.client.getJoinedMembers(channelId, this.opts.asUserId)
    return Object.entries(joined).map(([id, info]) => {
      const agent = this.opts.agentBots.get(id)
      return {
        id,
        name: info.display_name ?? id,
        is_agent: agent !== undefined,
        ...(agent !== undefined ? { agent_name: agent } : {}),
      }
    })
  }

  async getRoomInfo(channelId: string): Promise<RoomInfo> {
    const name = await this.opts.client.fetchRoomName(channelId, this.opts.asUserId)
    return {
      id: channelId,
      name: name ?? channelId,
      transport: 'matrix',
    }
  }

  async getRooms(): Promise<RoomInfo[]> {
    const rooms = this.opts.rooms ?? []
    return Promise.all(
      rooms.map(async (r) => {
        const name = await this.opts.client.fetchRoomName(r.alias, this.opts.asUserId)
        return { id: r.alias, name: name ?? r.alias, transport: 'matrix' as const }
      }),
    )
  }

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const rooms = this.opts.rooms ?? []
    if (!rooms.some((r) => r.alias === input.room)) {
      throw new Error(`not_in_room: this agent is not a member of ${input.room}`)
    }
    const { event_id } = await this.opts.client.sendMessage({
      roomId: input.room,
      asUserId: this.opts.asUserId,
      // m.notice, not m.text: agent prose sends as m.notice so
      // .m.rule.suppress_notices silences it server-side (ZNC025 §10).
      content: { msgtype: 'm.notice', body: input.text },
      ...(input.thread_id ? { threadRoot: input.thread_id } : {}),
    })
    return { event_id, ...(input.thread_id ? { thread_id: input.thread_id } : {}) }
  }
}

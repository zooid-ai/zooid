import type {
  TransportContextProvider,
  HistoryOptions,
  HistoryPage,
  Member,
  ChannelInfo,
  Message,
  ThreadOverview,
  ThreadOverviewPage,
} from '@zooid/core'
import type { MatrixClient } from './matrix-client.js'

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
  /** AS sender_localpart user (read access). */
  asUserId: string
  /** Map of Matrix user IDs → agent names, for is_agent / agent_name flags. */
  agentBots: Map<string, string>
}

export class MatrixContextProvider implements TransportContextProvider {
  constructor(private readonly opts: MatrixContextProviderOpts) {}

  async getRoomHistory(channelId: string, hopts: HistoryOptions): Promise<HistoryPage> {
    // Server-side filter: only `m.room.message` events. Without this we'd
    // burn the page budget on reactions, `eco.zoon.*` custom events, typing
    // notifications, etc., and routinely return empty pages with a stale
    // `has_more` cursor.
    const { chunk, end } = await this.opts.client.fetchRoomMessages({
      roomId: channelId,
      asUserId: this.opts.asUserId,
      limit: hopts.limit,
      from: hopts.before,
      filter: { types: ['m.room.message'] },
    })
    const messages: Message[] = []
    for (let i = chunk.length - 1; i >= 0; i--) {
      const ev = chunk[i] as unknown as MatrixMessageEvent
      const msg = this.toMessage(ev)
      if (msg) messages.push(msg)
    }
    return {
      messages,
      next_before: end,
      has_more: end !== undefined,
    }
  }

  async getRecentThreads(
    channelId: string,
    hopts: HistoryOptions,
  ): Promise<ThreadOverviewPage> {
    // Server-side filter: `m.room.message` only, and exclude thread replies
    // (`not_rel_types: ['m.thread']`) so the overview shows top-level entries
    // and thread roots, not the reply noise underneath them.
    const { chunk, end } = await this.opts.client.fetchRoomMessages({
      roomId: channelId,
      asUserId: this.opts.asUserId,
      limit: hopts.limit,
      from: hopts.before,
      filter: { types: ['m.room.message'], not_rel_types: ['m.thread'] },
    })
    // /messages returns newest-first; keep that order for the overview.
    const threads: ThreadOverview[] = []
    for (const ev of chunk as unknown as MatrixMessageEvent[]) {
      if (ev.type !== 'm.room.message') continue
      if (ev.content?.msgtype !== 'm.text' || typeof ev.content.body !== 'string') continue
      const relatesTo = ev.content['m.relates_to']
      if (relatesTo?.rel_type === 'm.thread') continue // skip thread replies
      const agent = this.opts.agentBots.get(ev.sender)
      const bundled = ev.unsigned?.['m.relations']?.['m.thread']
      const replyCount = bundled?.count ?? 0
      const latestTs = bundled?.latest_event?.origin_server_ts ?? ev.origin_server_ts
      threads.push({
        id: ev.event_id,
        sender: ev.sender,
        text: ev.content.body,
        timestamp: new Date(ev.origin_server_ts).toISOString(),
        is_agent: agent !== undefined,
        ...(agent !== undefined ? { agent_name: agent } : {}),
        reply_count: replyCount,
        last_activity_at: new Date(latestTs).toISOString(),
      })
    }
    return {
      threads,
      next_before: end,
      has_more: end !== undefined,
    }
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
    return {
      messages,
      next_before: next_batch,
      has_more: next_batch !== undefined,
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

    if (msgtype !== 'm.text' || typeof body !== 'string') return null
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

  async getChannelInfo(channelId: string): Promise<ChannelInfo> {
    const name = await this.opts.client.fetchRoomName(channelId, this.opts.asUserId)
    return {
      id: channelId,
      name: name ?? channelId,
      transport: 'matrix',
    }
  }
}

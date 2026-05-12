export interface HistoryOptions {
  /** Max messages to return. Default 50, max 200 (enforced by the MCP server). */
  limit?: number
  /** Pagination cursor — opaque to the agent. Provider-defined shape. */
  before?: string
}

export interface Message {
  id: string
  sender: string
  text: string
  timestamp: string
  is_agent: boolean
  agent_name?: string
  /**
   * Thread root event id when this message belongs to a thread. Absent for
   * top-level messages. Lets agents group messages by thread or drill into
   * a specific thread root.
   */
  thread_id?: string
}

export interface Member {
  id: string
  name: string
  is_agent: boolean
  agent_name?: string
}

export interface ChannelInfo {
  id: string
  name: string
  transport: 'http' | 'matrix'
}

export interface HistoryPage {
  messages: Message[]
  next_before?: string
  has_more: boolean
}

/**
 * A top-level entry in a room — either a standalone message or a thread
 * root. Lets the agent scan a room without thread-reply noise. Drill into
 * a thread with `getThreadHistory(thread_id)` where `thread_id` is this
 * entry's `id`.
 */
export interface ThreadOverview {
  id: string
  sender: string
  text: string
  timestamp: string
  is_agent: boolean
  agent_name?: string
  /** Number of replies in the thread under this entry. 0 = no replies yet. */
  reply_count: number
  /**
   * ISO 8601 of the latest activity in the thread (latest reply, or this
   * entry's own timestamp when there are no replies). Useful for sorting.
   */
  last_activity_at: string
}

export interface ThreadOverviewPage {
  threads: ThreadOverview[]
  next_before?: string
  has_more: boolean
}

/**
 * Read-only conversation-context surface for a single transport.
 * Implemented per-transport when the transport owns (or fronts) durable
 * conversation context. Transports that don't (e.g. current HTTP) return
 * `null` from `Transport.getContextProvider()`.
 *
 * Lets agents navigate a room the way a human does:
 *   - `getRoomHistory`     — every message chronologically
 *   - `getRecentThreads`   — top-level entries only (scan-the-room view)
 *   - `getThreadHistory`   — drill into one specific thread
 */
export interface TransportContextProvider {
  getRoomHistory(channelId: string, opts: HistoryOptions): Promise<HistoryPage>
  getRecentThreads(channelId: string, opts: HistoryOptions): Promise<ThreadOverviewPage>
  getThreadHistory(
    channelId: string,
    threadId: string,
    opts: HistoryOptions,
  ): Promise<HistoryPage>
  getChannelMembers(channelId: string): Promise<Member[]>
  getChannelInfo(channelId: string): Promise<ChannelInfo>
}

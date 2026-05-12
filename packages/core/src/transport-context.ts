import type { ThreadRef } from './types.js'

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
 * Read-only conversation-context surface for a single transport.
 * Implemented per-transport when the transport owns (or fronts) durable
 * conversation context. Transports that don't (e.g. current HTTP) return
 * `null` from `Transport.getContextProvider()`.
 */
export interface TransportContextProvider {
  getThreadHistory(threadRef: ThreadRef, opts: HistoryOptions): Promise<HistoryPage>
  getChannelMembers(threadRef: ThreadRef): Promise<Member[]>
  getChannelInfo(threadRef: ThreadRef): Promise<ChannelInfo>
}

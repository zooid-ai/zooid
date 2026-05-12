import type {
  TransportContextProvider,
  HistoryOptions,
  HistoryPage,
  Member,
  ChannelInfo,
  ThreadRef,
  Message,
} from '@zooid/core'
import type { MatrixClient } from './matrix-client.js'

export interface MatrixContextProviderOpts {
  client: MatrixClient
  /** AS sender_localpart user (read access). */
  asUserId: string
  /** Map of Matrix user IDs → agent names, for is_agent / agent_name flags. */
  agentBots: Map<string, string>
}

export class MatrixContextProvider implements TransportContextProvider {
  constructor(private readonly opts: MatrixContextProviderOpts) {}

  async getThreadHistory(threadRef: ThreadRef, hopts: HistoryOptions): Promise<HistoryPage> {
    const { chunk, end } = await this.opts.client.fetchRoomMessages({
      roomId: threadRef.channelId,
      asUserId: this.opts.asUserId,
      threadId:
        threadRef.threadId !== threadRef.channelId ? threadRef.threadId : undefined,
      limit: hopts.limit,
      from: hopts.before,
    })
    const messages: Message[] = []
    for (let i = chunk.length - 1; i >= 0; i--) {
      const m = chunk[i] as {
        event_id: string
        sender: string
        origin_server_ts: number
        type: string
        content?: { msgtype?: string; body?: string }
      }
      if (m.type !== 'm.room.message') continue
      if (m.content?.msgtype !== 'm.text' || typeof m.content.body !== 'string') continue
      const agent = this.opts.agentBots.get(m.sender)
      messages.push({
        id: m.event_id,
        sender: m.sender,
        text: m.content.body,
        timestamp: new Date(m.origin_server_ts).toISOString(),
        is_agent: agent !== undefined,
        ...(agent !== undefined ? { agent_name: agent } : {}),
      })
    }
    return {
      messages,
      next_before: end,
      has_more: end !== undefined,
    }
  }

  async getChannelMembers(threadRef: ThreadRef): Promise<Member[]> {
    const { joined } = await this.opts.client.getJoinedMembers(
      threadRef.channelId,
      this.opts.asUserId,
    )
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

  async getChannelInfo(threadRef: ThreadRef): Promise<ChannelInfo> {
    const name = await this.opts.client.fetchRoomName(threadRef.channelId, this.opts.asUserId)
    return {
      id: threadRef.channelId,
      name: name ?? threadRef.channelId,
      transport: 'matrix',
    }
  }
}

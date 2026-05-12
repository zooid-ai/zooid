import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { TransportContextProvider } from '@zooid/core'

const MAX_LIMIT = 200
const DEFAULT_LIMIT = 50

export interface BuildContextMcpServerOpts {
  /**
   * Resolves the provider for the current spawn. In production this calls
   * back to the daemon over the Unix socket; in unit tests it returns a
   * fake provider directly.
   */
  resolve: () => Promise<TransportContextProvider>
}

export function buildContextMcpServer(opts: BuildContextMcpServerOpts): McpServer {
  const server = new McpServer({ name: 'zooid-context', version: '0.0.1' })

  server.tool(
    'zooid_get_history',
    "Read prior messages in the agent's current thread. Read-only; returns inline messages with explicit `limit` + `before` pagination.",
    {
      limit: z.number().int().positive().optional(),
      before: z.string().optional(),
    },
    async ({ limit, before }) => {
      const provider = await opts.resolve()
      const clamped = Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT)
      const page = await provider.getThreadHistory(
        { channelId: '', threadId: '' },
        { limit: clamped, before },
      )
      return { content: [{ type: 'text', text: JSON.stringify(page) }] }
    },
  )

  server.tool(
    'zooid_get_members',
    'List the humans and agents in the current thread/room.',
    {},
    async () => {
      const provider = await opts.resolve()
      const members = await provider.getChannelMembers({ channelId: '', threadId: '' })
      return { content: [{ type: 'text', text: JSON.stringify({ members }) }] }
    },
  )

  server.tool(
    'zooid_get_channel_info',
    'Describe the current channel/room: id, display name, transport kind.',
    {},
    async () => {
      const provider = await opts.resolve()
      const info = await provider.getChannelInfo({ channelId: '', threadId: '' })
      return { content: [{ type: 'text', text: JSON.stringify(info) }] }
    },
  )

  return server
}

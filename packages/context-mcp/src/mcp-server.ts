import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { TaskActions, TaskCallerRef, TransportContextProvider } from '@zooid/core'

const MAX_LIMIT = 200
const DEFAULT_LIMIT = 50

export interface BuildContextMcpServerOpts {
  /**
   * Resolves the provider for the current spawn. In production this calls
   * back to the daemon over the Unix socket; in unit tests it returns a
   * fake provider directly.
   */
  resolve: () => Promise<TransportContextProvider>
  resolveTasks?: () => Promise<TaskActions>
}
// The socket substitutes its authenticated spawn binding; models never supply an address.
const CALLER_FROM_BINDING: TaskCallerRef = {
  agentName: '',
  channelId: '',
  threadRoot: '',
  sessionKey: '',
}

export function buildContextMcpServer(opts: BuildContextMcpServerOpts): McpServer {
  const server = new McpServer({ name: 'zooid-context', version: '0.0.1' })

  server.tool(
    'zooid_get_history',
    'Read every message in the current room chronologically — top-level messages and all thread replies. Each message has an optional `thread_id` so the agent can group by thread. For a scan-the-room overview without reply noise, use `zooid_get_recent_threads` instead. Supports `limit` + `before` pagination.',
    {
      limit: z.number().int().positive().optional(),
      before: z.string().optional(),
    },
    async ({ limit, before }) => {
      const provider = await opts.resolve()
      const clamped = Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT)
      const page = await provider.getRoomHistory('', {
        limit: clamped,
        before,
      })
      return { content: [{ type: 'text', text: JSON.stringify(page) }] }
    },
  )

  if (opts.resolveTasks) {
    server.tool(
      'zooid_start_tasks',
      'Assign concurrent work to other agents in this room. Each task opens a separate thread.',
      {
        tasks: z.array(z.object({ agent: z.string(), prompt: z.string() })).min(1),
        notify: z.enum(['caller', 'none']).optional(),
      },
      async ({ tasks, notify }) => {
        const out = await opts.resolveTasks!().then((actions) =>
          actions.startTasks(CALLER_FROM_BINDING, {
            tasks,
            notify: notify ?? 'caller',
          }),
        )
        return { content: [{ type: 'text', text: JSON.stringify(out) }] }
      },
    )
    server.tool(
      'zooid_complete_task',
      'Record an explicit result for the delegated task you were assigned.',
      { summary: z.string().min(1) },
      async ({ summary }) => {
        const out = await opts.resolveTasks!().then((actions) =>
          actions.completeTask(CALLER_FROM_BINDING, { summary }),
        )
        return { content: [{ type: 'text', text: JSON.stringify(out) }] }
      },
    )
  }

  server.tool(
    'zooid_get_recent_threads',
    "Scan-the-room overview: top-level messages and thread roots in the current room, newest first. Each entry has `reply_count` and `last_activity_at` so the agent can spot active conversations. Drill into a thread with `zooid_get_thread_history(thread_id)` where `thread_id` is the entry's `id`.",
    {
      limit: z.number().int().positive().optional(),
      before: z.string().optional(),
    },
    async ({ limit, before }) => {
      const provider = await opts.resolve()
      const clamped = Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT)
      const page = await provider.getRecentThreads('', {
        limit: clamped,
        before,
      })
      return { content: [{ type: 'text', text: JSON.stringify(page) }] }
    },
  )

  server.tool(
    'zooid_get_thread_history',
    'Drill into a specific thread: the root message followed by all replies in chronological order. Pass the `thread_id` from a `zooid_get_recent_threads` entry or a `Message.thread_id` from `zooid_get_history`.',
    {
      thread_id: z.string(),
      limit: z.number().int().positive().optional(),
      before: z.string().optional(),
    },
    async ({ thread_id, limit, before }) => {
      const provider = await opts.resolve()
      const clamped = Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT)
      const page = await provider.getThreadHistory('', thread_id, {
        limit: clamped,
        before,
      })
      return { content: [{ type: 'text', text: JSON.stringify(page) }] }
    },
  )

  server.tool(
    'zooid_get_members',
    'List the humans and agents in the current room.',
    {},
    async () => {
      const provider = await opts.resolve()
      const members = await provider.getChannelMembers('')
      return { content: [{ type: 'text', text: JSON.stringify({ members }) }] }
    },
  )

  server.tool(
    'zooid_get_channel_info',
    'Describe the current room: id, display name, transport kind.',
    {},
    async () => {
      const provider = await opts.resolve()
      const info = await provider.getChannelInfo('')
      return { content: [{ type: 'text', text: JSON.stringify(info) }] }
    },
  )

  return server
}

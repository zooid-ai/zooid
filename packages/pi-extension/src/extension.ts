import { callDaemon, type DaemonRequest } from '@zooid/context-mcp'

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
  details?: Record<string, unknown>
  isError?: boolean
}
interface ExtensionContext {
  sessionManager?: { getSessionId?: () => string | undefined }
}
interface ExtensionAPI {
  registerTool(tool: {
    name: string
    label: string
    description: string
    parameters: unknown
    execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onUpdate: ((partial: unknown) => void) | undefined,
      ctx: ExtensionContext,
    ): Promise<ToolResult>
  }): void
}

type DaemonReply = { ok: true; result: unknown } | { ok: false; error: string }
interface Deps {
  resolve?: (request: DaemonRequest) => Promise<DaemonReply>
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const pageParameters = {
  type: 'object',
  properties: {
    limit: { type: 'integer', minimum: 1 },
    before: { type: 'string' },
  },
} as const
const noParameters = { type: 'object', properties: {} } as const

function error(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

/** Pi's extension entry point. Pi only passes `pi`; deps is a test seam. */
export default function createExtension(pi: ExtensionAPI, deps: Deps = {}): void {
  const resolve =
    deps.resolve ??
    (async (request: DaemonRequest): Promise<DaemonReply> => {
      const sockPath = process.env.ZOOID_DAEMON_SOCK
      if (!sockPath) throw new Error('ZOOID_DAEMON_SOCK is not set')
      try {
        return { ok: true, result: await callDaemon(sockPath, request) }
      } catch (cause) {
        return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
      }
    })

  const call = async (
    method: DaemonRequest['method'],
    params: Record<string, unknown>,
    ctx: ExtensionContext,
  ): Promise<ToolResult> => {
    const acpSessionId = ctx.sessionManager?.getSessionId?.()
    if (!acpSessionId) return error('zooid: this Pi session has no id; cannot address a Zooid session.')
    try {
      const reply = await resolve({ acpSessionId, method, params })
      if (!reply.ok) {
        return error(
          `zooid: this Pi session (${acpSessionId}) is not bound to a Zooid session — ${reply.error}.`,
        )
      }
      return { content: [{ type: 'text', text: JSON.stringify(reply.result) }] }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      return error(`zooid: could not reach the Zooid daemon (${message}).`)
    }
  }
  const page = (params: Record<string, unknown>) => ({
    limit: Math.min(Number(params.limit) || DEFAULT_LIMIT, MAX_LIMIT),
    ...(typeof params.before === 'string' ? { before: params.before } : {}),
  })
  const registerRead = (
    name: string,
    label: string,
    description: string,
    method: DaemonRequest['method'],
    parameters: unknown = pageParameters,
    map: (params: Record<string, unknown>) => Record<string, unknown> = page,
  ) => pi.registerTool({ name, label, description, parameters, execute: (_id, params, _signal, _update, ctx) => call(method, map(params), ctx) })

  registerRead('zooid_get_history', 'Read room history', 'Read every message in the current room chronologically. Supports limit and before pagination.', 'getRoomHistory')
  registerRead('zooid_get_recent_threads', 'Read recent threads', 'Scan the current room for top-level messages and thread roots, newest first.', 'getRecentThreads')
  registerRead('zooid_get_thread_history', 'Read thread', 'Read a thread root and all its replies in chronological order.', 'getThreadHistory', {
    ...pageParameters,
    properties: { ...pageParameters.properties, thread_id: { type: 'string' } },
    required: ['thread_id'],
  }, (params) => ({ threadId: params.thread_id, ...page(params) }))
  registerRead('zooid_get_members', 'List room members', 'List the humans and agents in the current room.', 'getChannelMembers', noParameters, () => ({}))
  registerRead('zooid_get_channel_info', 'Get room information', 'Describe the current room: id, display name, and transport kind.', 'getChannelInfo', noParameters, () => ({}))

  pi.registerTool({
    name: 'zooid_start_tasks',
    label: 'Start Zooid tasks',
    description: 'Assign concurrent work to other agents in this room. Each task opens a separate thread. A delegated task cannot start tasks of its own.',
    parameters: {
      type: 'object',
      properties: {
        tasks: { type: 'array', minItems: 1, items: { type: 'object', properties: { agent: { type: 'string' }, prompt: { type: 'string' } }, required: ['agent', 'prompt'] } },
        notify: { enum: ['caller', 'none'] },
      },
      required: ['tasks'],
    },
    async execute(_id, params, _signal, _update, ctx) {
      return call('startTasks', { tasks: params.tasks, notify: params.notify ?? 'caller' }, ctx)
    },
  })
  pi.registerTool({
    name: 'zooid_complete_task',
    label: 'Complete Zooid task',
    description: 'Record an explicit result for the delegated task you were assigned.',
    parameters: { type: 'object', properties: { summary: { type: 'string', minLength: 1 } }, required: ['summary'] },
    async execute(_id, params, _signal, _update, ctx) {
      if (typeof params.summary !== 'string' || !params.summary.trim()) return error('zooid: summary must not be empty.')
      return call('completeTask', { summary: params.summary }, ctx)
    },
  })
}

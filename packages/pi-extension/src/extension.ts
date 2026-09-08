import { callDaemon, type DaemonRequest } from '@zooid/context-mcp'

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
  details?: Record<string, unknown>
  isError?: boolean
}
interface ExtensionContext {
  sessionManager?: { getSessionId?: () => string | undefined }
}
interface RegisteredTool {
  name: string
  label: string
  description: string
  parameters: unknown
  /**
   * Flat bullets appended to the system prompt while this tool is active —
   * pi has no per-tool "Use this tool when…" slot, so anything that must
   * name the tool explicitly (the wake contract) goes here.
   */
  promptGuidelines?: string[]
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: ((partial: unknown) => void) | undefined,
    ctx: ExtensionContext,
  ): Promise<ToolResult>
}
interface ExtensionAPI {
  registerTool(tool: RegisteredTool): void
  /** Registered during load or after startup, including from a session_start handler. */
  on(event: string, handler: (evt: unknown, ctx: ExtensionContext) => void | Promise<void>): void
  getActiveTools(): string[]
  setActiveTools(names: string[]): void
  getAllTools(): Array<{ name: string }>
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
  registerRead('zooid_get_room_info', 'Get room information', 'Describe the current room: id, display name, and transport kind.', 'getRoomInfo', noParameters, () => ({}))
  registerRead('zooid_get_rooms', 'List rooms', 'List the rooms this agent is a member of. Valid targets for zooid_send_message.', 'getRooms', noParameters, () => ({}))

  pi.registerTool({
    name: 'zooid_send_message',
    label: 'Send Zooid message',
    description: 'Post a message into a room or thread this agent is bound to. Fire-and-forget: no assignee, no completion tracking, no notify. Use zooid_start_task_threads instead when the intent is delegation.',
    parameters: {
      type: 'object',
      properties: {
        room: { type: 'string' },
        thread_id: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['room', 'text'],
    },
    async execute(_id, params, _signal, _update, ctx) {
      return call('sendMessage', { room: params.room, thread_id: params.thread_id, text: params.text }, ctx)
    },
  })

  pi.registerTool({
    name: 'zooid_start_task_threads',
    label: 'Start Zooid task threads',
    description: 'Assign concurrent work to other agents in this room. Each task opens a separate thread. A delegated task cannot start tasks of its own. The return payload states how the result comes back — read `delivery` before deciding what to do next.',
    promptGuidelines: [
      'After calling zooid_start_task_threads, read the `delivery` field of its result and end your turn now when it tells you to — do not poll the task thread while waiting for a result.',
    ],
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

  // Role-conditional gating ([[ZOD084]]). Fail open on any error — the read
  // tools and zooid_start_task_threads/zooid_complete_task are already
  // registered above, so the failure mode of gating is removing a
  // capability rather than declining to add one. A daemon hiccup must not
  // strip an assignee's ability to finish its task.
  pi.on('session_start', async (_evt, ctx) => {
    const acpSessionId = ctx.sessionManager?.getSessionId?.()
    if (!acpSessionId) return
    let reply: DaemonReply
    try {
      reply = await resolve({ acpSessionId, method: 'describeRole', params: {} })
    } catch {
      return
    }
    if (!reply.ok) return
    const role = reply.result as { is_task_assignee: boolean; can_start_task_threads: boolean }
    const next = new Set(pi.getAllTools().map((t) => t.name))
    if (role.is_task_assignee) next.add('zooid_complete_task')
    else next.delete('zooid_complete_task')
    if (role.can_start_task_threads) next.add('zooid_start_task_threads')
    else next.delete('zooid_start_task_threads')
    pi.setActiveTools([...next])
  })
}

import {
  AGENT_NOTIFY_INSTRUCTIONS,
  callDaemon,
  HANDOFF_DESCRIPTION,
  SEND_MESSAGE_DESCRIPTION,
  type DaemonRequest,
} from '@zooid/context-mcp'

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
    description: SEND_MESSAGE_DESCRIPTION,
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

  // [[ZOD092]] / [[ZOD094]]: the only way a pi agent involves another agent in
  // its thread. Text is shared with the MCP surface so both runtimes teach the
  // same contract. A refusal is a normal result — the model reads `reason`.
  pi.registerTool({
    name: 'zooid_handoff',
    label: 'Hand off to a Zooid agent',
    description: HANDOFF_DESCRIPTION,
    promptGuidelines: [
      AGENT_NOTIFY_INSTRUCTIONS,
      'After zooid_handoff returns `status: "started"`, end your turn now — do not wait, poll, or post follow-ups. The result comes back to you as `[handoff return] from <agent>`.',
    ],
    parameters: {
      type: 'object',
      properties: { agent: { type: 'string' }, prompt: { type: 'string' } },
      required: ['agent', 'prompt'],
    },
    async execute(_id, params, _signal, _update, ctx) {
      return call('handoff', { agent: params.agent, prompt: params.prompt }, ctx)
    },
  })

  // Role-conditional gating ([[ZOD084]]). Fail open on any error — the read
  // tools and zooid_start_task_threads/zooid_complete_task/zooid_handoff are
  // already registered above, so the failure mode of gating is removing a
  // capability rather than declining to add one. A daemon hiccup must not
  // strip an assignee's ability to finish its task. Failing open is safe for
  // zooid_handoff too: the daemon refuses a handoff from an unbound caller.
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
    const role = reply.result as {
      is_task_assignee: boolean
      can_start_task_threads: boolean
      can_handoff?: boolean
    }
    const next = new Set(pi.getAllTools().map((t) => t.name))
    if (role.is_task_assignee) next.add('zooid_complete_task')
    else next.delete('zooid_complete_task')
    if (role.can_start_task_threads) next.add('zooid_start_task_threads')
    else next.delete('zooid_start_task_threads')
    // Absent = a daemon older than 0.16, which cannot serve `handoff`.
    if (role.can_handoff === true) next.add('zooid_handoff')
    else next.delete('zooid_handoff')
    pi.setActiveTools([...next])
  })
}

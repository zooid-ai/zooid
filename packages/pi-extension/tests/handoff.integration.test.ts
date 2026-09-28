import { afterEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { SpawnRegistry, startDaemonSocketServer } from '@zooid/context-mcp'
import type {
  HandoffInput,
  HandoffOutput,
  TaskActions,
  TaskCallerRef,
  TaskRole,
  TransportContextProvider,
} from '@zooid/core'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(__dirname, '..', 'dist', 'zooid-tasks.js')

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanup) await fn()
  cleanup.length = 0
  delete process.env.ZOOID_DAEMON_SOCK
})

function fakeProvider(): TransportContextProvider {
  return {
    getRoomHistory: async () => ({ messages: [], has_more: false }),
    getRecentThreads: async () => ({ threads: [], has_more: false }),
    getThreadHistory: async () => ({ messages: [], has_more: false }),
    getChannelMembers: async () => [],
    getRoomInfo: async () => ({ id: 'r', name: 'r', transport: 'matrix' }),
  } as unknown as TransportContextProvider
}

/** Minimal stand-in for pi's ExtensionAPI — only what the extension calls. */
function makeFakePi() {
  const tools: any[] = []
  const handlers: Record<string, Function> = {}
  let active: string[] = []
  return {
    tools,
    handlers,
    active: () => active,
    registerTool: (tool: any) => {
      tools.push(tool)
      active.push(tool.name)
    },
    on: (event: string, handler: Function) => {
      handlers[event] = handler
    },
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = names
    },
    getAllTools: () => tools.map((t) => ({ name: t.name })),
  }
}
const ctx = (sessionId: string) => ({ sessionManager: { getSessionId: () => sessionId } })

describe.skipIf(!existsSync(BUNDLE))('zooid-tasks bundle → daemon socket: zooid_handoff', () => {
  async function harness(opts: { role: TaskRole; reply: HandoffOutput }) {
    const seen: Array<{ caller: TaskCallerRef; input: HandoffInput }> = []
    const registry = new SpawnRegistry()
    registry.setTaskActions({
      startTasks: async () => ({ results: [] }),
      completeTask: async () => ({ status: 'recorded' }),
      describeRole: async () => opts.role,
      handoff: async (caller: TaskCallerRef, input: HandoffInput) => {
        seen.push({ caller, input })
        return opts.reply
      },
    } as unknown as TaskActions)
    registry.register({
      agentName: 'architect',
      threadRef: { channelId: '!room:hs', threadId: '$root' },
      sessionKey: '$root|$call',
      provider: fakeProvider(),
    })
    registry.linkSession('architect', '$root|$call', 'pi-session-1')
    const sockPath = join(tmpdir(), `zooid-pi-handoff-${randomUUID().slice(0, 8)}.sock`)
    const server = await startDaemonSocketServer({ sockPath, registry, agentName: 'architect' })
    cleanup.push(() => server.close())

    process.env.ZOOID_DAEMON_SOCK = sockPath
    const mod = (await import(BUNDLE)) as { default: (pi: unknown) => void }
    const pi = makeFakePi()
    mod.default(pi)
    return { pi, seen }
  }

  it('hands off with the daemon-bound caller; the model never supplies an address', async () => {
    const started: HandoffOutput = {
      status: 'started',
      call_id: 'call-1',
      callee: '@cloud.product:hs',
      delivery: 'Handed off to product. End your turn now.',
    }
    const { pi, seen } = await harness({
      role: { is_task_assignee: false, can_start_task_threads: true, can_handoff: true },
      reply: started,
    })
    await pi.handlers.session_start({ reason: 'startup' }, ctx('pi-session-1'))
    expect(pi.active()).toContain('zooid_handoff')

    const tool = pi.tools.find((t) => t.name === 'zooid_handoff')
    const res = await tool.execute(
      'tc-1', { agent: 'product', prompt: 'draft the spec' }, undefined, undefined, ctx('pi-session-1'),
    )
    expect(res.isError).toBeUndefined()
    expect(JSON.parse(res.content[0].text)).toEqual(started)
    expect(seen).toEqual([
      {
        caller: {
          agentName: 'architect',
          channelId: '!room:hs',
          threadRoot: '$root',
          // The exact session key — a handoff arc, not the bare thread root.
          sessionKey: '$root|$call',
        },
        input: { agent: 'product', prompt: 'draft the spec' },
      },
    ])
  })

  it('refuses an unlinked pi session without reaching TaskActions', async () => {
    const { pi, seen } = await harness({
      role: { is_task_assignee: false, can_start_task_threads: true, can_handoff: true },
      reply: { status: 'refused', reason: 'unused' },
    })
    const tool = pi.tools.find((t) => t.name === 'zooid_handoff')
    const res = await tool.execute(
      'tc-1', { agent: 'product', prompt: 'x' }, undefined, undefined, ctx('pi-orphan'),
    )
    expect(res.isError).toBe(true)
    expect(seen).toEqual([])
  })

  it('drops zooid_handoff when the daemon says can_handoff is false', async () => {
    const { pi } = await harness({
      role: { is_task_assignee: false, can_start_task_threads: true, can_handoff: false },
      reply: { status: 'refused', reason: 'unused' },
    })
    await pi.handlers.session_start({ reason: 'startup' }, ctx('pi-session-1'))
    expect(pi.active()).not.toContain('zooid_handoff')
  })
})

import { describe, expect, it } from 'vitest'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { TaskActions, TransportContextProvider } from '@zooid/core'
import { buildContextMcpServer } from './mcp-server.js'
import {
  AGENT_NOTIFY_INSTRUCTIONS,
  HANDOFF_DESCRIPTION,
  SEND_MESSAGE_DESCRIPTION,
} from './index.js'

const provider = {} as TransportContextProvider
const tasks: TaskActions = {
  startTasks: async () => ({ results: [] }),
  completeTask: async () => ({ status: 'recorded' }),
  describeRole: async () => ({ is_task_assignee: false, can_start_task_threads: true, can_handoff: true }),
  handoff: async () => ({ status: 'refused', reason: 'stub' }),
} as unknown as TaskActions

async function connect() {
  const server = buildContextMcpServer({
    resolve: async () => provider,
    resolveTasks: async () => tasks,
    role: { is_task_assignee: false, can_start_task_threads: true, can_handoff: true },
  })
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0.0.1' }, { capabilities: {} })
  await Promise.all([server.connect(serverT), client.connect(clientT)])
  return client
}

describe('shared tool text ([[ZOD094]])', () => {
  it('is exported from the package entry point with the 0.16 wording', () => {
    // Pinning the key phrases, not the whole string: the point of the module
    // is that there is exactly one copy, which the adapters import.
    expect(HANDOFF_DESCRIPTION).toMatch(/only way to involve another agent/i)
    expect(HANDOFF_DESCRIPTION).toMatch(/\[handoff return\] from <agent>/)
    expect(HANDOFF_DESCRIPTION).toMatch(/zooid_start_task_threads/)
    expect(AGENT_NOTIFY_INSTRUCTIONS).toMatch(/zooid_handoff/)
    expect(AGENT_NOTIFY_INSTRUCTIONS).toMatch(/do not notify agents/i)
    expect(SEND_MESSAGE_DESCRIPTION).toMatch(/zooid_handoff/)
    expect(SEND_MESSAGE_DESCRIPTION).toMatch(/do not notify agents/i)
  })

  it('is exactly what the MCP server serves', async () => {
    const client = await connect()
    const tools = (await client.listTools()).tools
    expect(tools.find((t) => t.name === 'zooid_handoff')?.description).toBe(HANDOFF_DESCRIPTION)
    expect(tools.find((t) => t.name === 'zooid_send_message')?.description).toBe(SEND_MESSAGE_DESCRIPTION)
    expect(client.getInstructions()).toBe(AGENT_NOTIFY_INSTRUCTIONS)
  })
})

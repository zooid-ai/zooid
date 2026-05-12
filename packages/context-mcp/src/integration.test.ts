import { describe, it, expect, afterEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SpawnRegistry } from './spawn-registry.js'
import { startDaemonSocketServer } from './daemon-socket.js'
import type { TransportContextProvider } from '@zooid/core'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BIN = join(__dirname, '..', 'dist', 'bin.js')

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanup) await fn()
  cleanup.length = 0
})

describe.skipIf(!existsSync(BIN))('zooid-context MCP server (out-of-process)', () => {
  it('end-to-end tools/call → daemon socket → provider → tool result', async () => {
    const provider: TransportContextProvider = {
      getThreadHistory: async () => ({
        messages: [
          { id: 'e1', sender: 'alice', text: 'hi', timestamp: 'T', is_agent: false },
        ],
        has_more: false,
      }),
      getChannelMembers: async () => [],
      getChannelInfo: async () => ({ id: 'r', name: 'r', transport: 'matrix' }),
    }
    const registry = new SpawnRegistry()
    const spawnId = registry.register({
      agentName: 'architect',
      threadRef: { channelId: '!room:hs', threadId: '!room:hs' },
      provider,
    })
    const sockPath = join(tmpdir(), `zooid-it-${randomUUID()}.sock`)
    const server = await startDaemonSocketServer({ sockPath, registry })
    cleanup.push(() => server.close())

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN, '--spawn-id', spawnId],
      env: { ...process.env, ZOOID_DAEMON_SOCK: sockPath } as Record<string, string>,
    })
    const client = new Client({ name: 'it', version: '0.0.1' }, { capabilities: {} })
    await client.connect(transport)
    cleanup.push(async () => {
      await client.close()
    })

    const list = await client.listTools()
    expect(list.tools.map((t) => t.name).sort()).toEqual([
      'zooid_get_channel_info',
      'zooid_get_history',
      'zooid_get_members',
    ])

    const result = await client.callTool({ name: 'zooid_get_history', arguments: {} })
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text)
    expect(payload.messages[0].id).toBe('e1')
  })

  it('two MCP server subprocesses sharing one socket route to their own bindings', async () => {
    const providerA: TransportContextProvider = {
      getThreadHistory: async () => ({
        messages: [{ id: 'A1', sender: 'alice', text: 'from A', timestamp: 'T', is_agent: false }],
        has_more: false,
      }),
      getChannelMembers: async () => [],
      getChannelInfo: async () => ({ id: '!a:hs', name: 'room-A', transport: 'matrix' }),
    }
    const providerB: TransportContextProvider = {
      getThreadHistory: async () => ({
        messages: [{ id: 'B1', sender: 'bob', text: 'from B', timestamp: 'T', is_agent: false }],
        has_more: false,
      }),
      getChannelMembers: async () => [],
      getChannelInfo: async () => ({ id: '!b:hs', name: 'room-B', transport: 'matrix' }),
    }
    const registry = new SpawnRegistry()
    const spawnA = registry.register({
      agentName: 'architect',
      threadRef: { channelId: '!a:hs', threadId: '!a:hs' },
      provider: providerA,
    })
    const spawnB = registry.register({
      agentName: 'product-owner',
      threadRef: { channelId: '!b:hs', threadId: '!b:hs' },
      provider: providerB,
    })
    const sockPath = join(tmpdir(), `zooid-it-${randomUUID()}.sock`)
    const server = await startDaemonSocketServer({ sockPath, registry })
    cleanup.push(() => server.close())

    async function startClient(spawnId: string) {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [BIN, '--spawn-id', spawnId],
        env: { ...process.env, ZOOID_DAEMON_SOCK: sockPath } as Record<string, string>,
      })
      const client = new Client({ name: 'it', version: '0.0.1' }, { capabilities: {} })
      await client.connect(transport)
      cleanup.push(async () => {
        await client.close()
      })
      return client
    }

    const [clientA, clientB] = await Promise.all([startClient(spawnA), startClient(spawnB)])

    const [resA, resB] = await Promise.all([
      clientA.callTool({ name: 'zooid_get_history', arguments: {} }),
      clientB.callTool({ name: 'zooid_get_history', arguments: {} }),
    ])
    const payloadA = JSON.parse((resA.content as Array<{ text: string }>)[0].text)
    const payloadB = JSON.parse((resB.content as Array<{ text: string }>)[0].text)
    expect(payloadA.messages[0].id).toBe('A1')
    expect(payloadB.messages[0].id).toBe('B1')

    const infoA = await clientA.callTool({ name: 'zooid_get_channel_info', arguments: {} })
    const infoB = await clientB.callTool({ name: 'zooid_get_channel_info', arguments: {} })
    expect(JSON.parse((infoA.content as Array<{ text: string }>)[0].text).id).toBe('!a:hs')
    expect(JSON.parse((infoB.content as Array<{ text: string }>)[0].text).id).toBe('!b:hs')
  })
})

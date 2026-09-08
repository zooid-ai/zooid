import { describe, it, expect, afterEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SpawnRegistry } from './spawn-registry.js'
import { callDaemon, startAgentSocketServers, startDaemonSocketServer } from './daemon-socket.js'
import { agentSocketPath } from './socket-paths.js'
import type { TransportContextProvider } from '@zooid/core'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BIN = join(__dirname, '..', 'dist', 'bin.js')

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanup) await fn()
  cleanup.length = 0
})

function fakeProvider(over: Partial<TransportContextProvider> = {}): TransportContextProvider {
  return {
    getRoomHistory: async () => ({ messages: [], has_more: false }),
    getRecentThreads: async () => ({ threads: [], has_more: false }),
    getThreadHistory: async () => ({ messages: [], has_more: false }),
    getChannelMembers: async () => [],
    getRoomInfo: async () => ({ id: 'r', name: 'r', transport: 'matrix' }),
    ...over,
  }
}

describe.skipIf(!existsSync(BIN))('zooid-context MCP server (out-of-process)', () => {
  it('end-to-end tools/call → daemon socket → provider → tool result', async () => {
    const provider = fakeProvider({
      getRoomHistory: async () => ({
        messages: [
          {
            id: 'e1',
            sender: 'alice',
            text: 'hi',
            timestamp: 'T',
            is_agent: false,
          },
        ],
        has_more: false,
      }),
    })
    const registry = new SpawnRegistry()
    const spawnId = registry.register({
      agentName: 'architect',
      threadRef: { channelId: '!room:hs', threadId: '!room:hs' },
      provider,
    })
    const sockPath = join(tmpdir(), `zooid-it-${randomUUID()}.sock`)
    const server = await startDaemonSocketServer({ sockPath, registry, agentName: 'architect' })
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

    // No taskActions registered on this registry, so the daemon-side
    // describeRole query fails, bin.ts's role stays undefined, and neither
    // task tool registers ([[ZOD084]] role-conditional registration).
    const list = await client.listTools()
    expect(list.tools.map((t) => t.name).sort()).toEqual([
      'zooid_get_history',
      'zooid_get_members',
      'zooid_get_recent_threads',
      'zooid_get_room_info',
      'zooid_get_rooms',
      'zooid_get_thread_history',
      'zooid_send_message',
    ])

    const result = await client.callTool({
      name: 'zooid_get_history',
      arguments: {},
    })
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text)
    expect(payload.messages[0].id).toBe('e1')
  })

  it('two MCP server subprocesses sharing one socket route to their own bindings', async () => {
    const providerA = fakeProvider({
      getRoomHistory: async () => ({
        messages: [
          {
            id: 'A1',
            sender: 'alice',
            text: 'from A',
            timestamp: 'T',
            is_agent: false,
          },
        ],
        has_more: false,
      }),
      getRoomInfo: async () => ({
        id: '!a:hs',
        name: 'room-A',
        transport: 'matrix',
      }),
    })
    const providerB = fakeProvider({
      getRoomHistory: async () => ({
        messages: [
          {
            id: 'B1',
            sender: 'bob',
            text: 'from B',
            timestamp: 'T',
            is_agent: false,
          },
        ],
        has_more: false,
      }),
      getRoomInfo: async () => ({
        id: '!b:hs',
        name: 'room-B',
        transport: 'matrix',
      }),
    })
    const registry = new SpawnRegistry()
    const spawnA = registry.register({
      agentName: 'architect',
      threadRef: { channelId: '!a:hs', threadId: '!a:hs' },
      provider: providerA,
    })
    const spawnB = registry.register({
      agentName: 'architect',
      threadRef: { channelId: '!b:hs', threadId: '!b:hs' },
      provider: providerB,
    })
    const sockPath = join(tmpdir(), `zooid-it-${randomUUID()}.sock`)
    const server = await startDaemonSocketServer({ sockPath, registry, agentName: 'architect' })
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

    const infoA = await clientA.callTool({
      name: 'zooid_get_room_info',
      arguments: {},
    })
    const infoB = await clientB.callTool({
      name: 'zooid_get_room_info',
      arguments: {},
    })
    expect(JSON.parse((infoA.content as Array<{ text: string }>)[0].text).id).toBe('!a:hs')
    expect(JSON.parse((infoB.content as Array<{ text: string }>)[0].text).id).toBe('!b:hs')
  })
})

describe('per-agent sockets (integration)', () => {
  it('isolates two agents sharing a registry', async () => {
    const registry = new SpawnRegistry()
    const aliceSpawn = registry.register({
      agentName: 'alice',
      threadRef: { channelId: '!alice:hs', threadId: 'a' },
      provider: fakeProvider({ getRoomInfo: async () => ({ id: '!alice:hs', name: 'alice', transport: 'matrix' }) }),
    })
    const bobSpawn = registry.register({
      agentName: 'bob',
      threadRef: { channelId: '!bob:hs', threadId: 'b' },
      provider: fakeProvider({ getRoomInfo: async () => ({ id: '!bob:hs', name: 'bob', transport: 'matrix' }) }),
    })
    const runDir = mkdtempSync(join(tmpdir(), 'zooid-run-'))
    const sockets = await startAgentSocketServers({ runDir, registry, agentNames: ['alice', 'bob'] })
    cleanup.push(() => sockets.close())
    expect(sockets.paths.alice).toBe(agentSocketPath({ runDir, agentName: 'alice' }))
    await expect(callDaemon(sockets.paths.alice!, { spawnId: aliceSpawn, method: 'getRoomInfo', params: {} })).resolves.toMatchObject({ id: '!alice:hs' })
    await expect(callDaemon(sockets.paths.bob!, { spawnId: aliceSpawn, method: 'getRoomInfo', params: {} })).rejects.toThrow(/binding not owned by caller/)
    await expect(callDaemon(sockets.paths.bob!, { spawnId: bobSpawn, method: 'getRoomInfo', params: {} })).resolves.toMatchObject({ id: '!bob:hs' })
  })

  it('keeps other listeners serving when one bind fails', async () => {
    const registry = new SpawnRegistry()
    const sockets = await startAgentSocketServers({
      runDir: mkdtempSync(join(tmpdir(), 'zooid-run-')),
      registry,
      agentNames: ['alice', 'bob'],
      listen: async (path, name) => {
        if (name === 'bob') throw new Error('EADDRINUSE')
        return startDaemonSocketServer({ sockPath: path, registry, agentName: name })
      },
    })
    cleanup.push(() => sockets.close())
    expect(sockets.paths.alice).toBeDefined()
    expect(sockets.paths.bob).toBeUndefined()
  })
})

import { describe, it, expect, vi } from 'vitest'
import { AcpClient } from './acp-client.js'

function injectConnection(client: AcpClient, calls: Array<{ method: string; params: unknown }>) {
  const connection = {
    newSession: vi.fn(async (params: unknown) => {
      calls.push({ method: 'newSession', params })
      return { sessionId: 'sess-1' }
    }),
    loadSession: vi.fn(async (params: unknown) => {
      calls.push({ method: 'loadSession', params })
      return {}
    }),
  }
  // @ts-expect-error — test reaches into private state to skip subprocess spawn
  client.connection = connection
  // @ts-expect-error
  client.initialized = true
  // @ts-expect-error
  client.agentCapabilities = { loadSession: true }
  return connection
}

describe('AcpClient — context MCP wiring', () => {
  it('omits zooid-context from mcpServers when no contextSpawn factory is set', async () => {
    const calls: Array<{ method: string; params: unknown }> = []
    const client = new AcpClient({
      agent: { id: 'architect', command: 'x', args: [] },
      onEvent: () => {},
      onApprovalRequest: async () => ({ decision: 'allow', optionId: 'allow' }),
    })
    injectConnection(client, calls)
    await client.ensureSession('!room:hs')
    const params = calls.find((c) => c.method === 'newSession')!.params as {
      mcpServers: unknown[]
    }
    expect(params.mcpServers).toEqual([])
  })

  it('includes the zooid-context mcpServer entry when contextSpawn is set', async () => {
    const calls: Array<{ method: string; params: unknown }> = []
    const contextSpawn = vi.fn(async (threadId: string) => ({
      name: 'zooid-context' as const,
      command: 'node',
      args: ['/bin/zooid-context-mcp.js', '--spawn-id', `spawn-${threadId}`],
      env: [{ name: 'ZOOID_DAEMON_SOCK', value: '/run/zooid/test.sock' }],
    }))
    const client = new AcpClient({
      agent: { id: 'architect', command: 'x', args: [] },
      onEvent: () => {},
      onApprovalRequest: async () => ({ decision: 'allow', optionId: 'allow' }),
      contextSpawn,
    })
    injectConnection(client, calls)
    await client.ensureSession('!room:hs')
    expect(contextSpawn).toHaveBeenCalledWith('!room:hs', undefined)
    const params = calls.find((c) => c.method === 'newSession')!.params as {
      mcpServers: Array<{ name: string; args: string[] }>
    }
    expect(params.mcpServers).toHaveLength(1)
    expect(params.mcpServers[0].name).toBe('zooid-context')
    expect(params.mcpServers[0].args).toContain('--spawn-id')
    expect(params.mcpServers[0].args).toContain('spawn-!room:hs')
  })

  it('includes zooid-context in loadSession mcpServers too', async () => {
    const calls: Array<{ method: string; params: unknown }> = []
    const contextSpawn = vi.fn(async () => ({
      name: 'zooid-context' as const,
      command: 'node',
      args: ['/bin/zooid-context-mcp.js'],
      env: [],
    }))
    const client = new AcpClient({
      agent: { id: 'architect', command: 'x', args: [] },
      agentDataDir: '/tmp/zooid-acp-test',
      onEvent: () => {},
      onApprovalRequest: async () => ({ decision: 'allow', optionId: 'allow' }),
      contextSpawn,
    })
    const conn = injectConnection(client, calls)
    // @ts-expect-error
    client.store = { load: async () => {}, get: () => 'sess-old', set: async () => {}, delete: async () => {} }
    // @ts-expect-error
    client.storeLoaded = Promise.resolve()
    await client.ensureSession('!room:hs')
    expect(conn.loadSession).toHaveBeenCalled()
    const params = calls.find((c) => c.method === 'loadSession')!.params as {
      mcpServers: Array<{ name: string }>
    }
    expect(params.mcpServers.map((s) => s.name)).toEqual(['zooid-context'])
  })

  it('passes contextThreadId — not the composed session key — to contextSpawn', async () => {
    const calls: Array<{ method: string; params: unknown }> = []
    const contextSpawn = vi.fn(async (threadId: string) => ({
      name: 'zooid-context' as const,
      command: 'node',
      args: ['/bin/zooid-context-mcp.js', '--spawn-id', `spawn-${threadId}`],
      env: [{ name: 'ZOOID_DAEMON_SOCK', value: '/run/zooid/test.sock' }],
    }))
    const client = new AcpClient({
      agent: { id: 'bebop', command: 'x', args: [] },
      onEvent: () => {},
      onApprovalRequest: async () => ({ decision: 'allow', optionId: 'allow' }),
      contextSpawn,
    })
    injectConnection(client, calls)
    // Handoff-arc session: key is composed, context ref is the real root —
    // zooid_get_history must read the real Matrix thread.
    await client.ensureSession('$root|$p1', '!r:example.com', '$root')
    expect(contextSpawn).toHaveBeenCalledWith('$root', '!r:example.com')
  })

  it('defaults the context ref to the session key when contextThreadId is omitted (back-compat)', async () => {
    const calls: Array<{ method: string; params: unknown }> = []
    const contextSpawn = vi.fn(async (threadId: string) => ({
      name: 'zooid-context' as const,
      command: 'node',
      args: ['/bin/zooid-context-mcp.js', '--spawn-id', `spawn-${threadId}`],
      env: [{ name: 'ZOOID_DAEMON_SOCK', value: '/run/zooid/test.sock' }],
    }))
    const client = new AcpClient({
      agent: { id: 'bebop', command: 'x', args: [] },
      onEvent: () => {},
      onApprovalRequest: async () => ({ decision: 'allow', optionId: 'allow' }),
      contextSpawn,
    })
    injectConnection(client, calls)
    await client.ensureSession('$root', '!r:example.com')
    expect(contextSpawn).toHaveBeenCalledWith('$root', '!r:example.com')
  })
})

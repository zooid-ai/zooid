import { createServer, createConnection, type Server, type Socket } from 'node:net'
import { unlink } from 'node:fs/promises'
import type { SpawnRegistry } from './spawn-registry.js'

interface DaemonRequest {
  spawnId: string
  method:
    | 'getRoomHistory'
    | 'getRecentThreads'
    | 'getThreadHistory'
    | 'getChannelMembers'
    | 'getChannelInfo'
  params: Record<string, unknown>
}

interface DaemonResponse {
  ok: true
  result: unknown
}

interface DaemonError {
  ok: false
  error: string
}

export interface DaemonSocketHandle {
  close(): Promise<void>
}

export async function startDaemonSocketServer(opts: {
  sockPath: string
  registry: SpawnRegistry
}): Promise<DaemonSocketHandle> {
  await unlink(opts.sockPath).catch(() => {})
  // net.Server.close() waits for every open connection and — unlike
  // http.Server since Node 19 — never destroys idle ones, and there is no
  // closeAllConnections() for it. The clients here are context-mcp servers
  // spawned beside each agent, which outlive AcpClient.stop() (it SIGTERMs
  // the agent without waiting, and these are its grandchildren). So without
  // tracking them, close() hangs until they happen to die — which is what
  // made `zooid dev` take ages to stop.
  const open = new Set<Socket>()
  const server: Server = createServer((socket: Socket) => {
    open.add(socket)
    socket.on('close', () => open.delete(socket))
    let buf = ''
    socket.setEncoding('utf8')
    socket.on('data', async (chunk) => {
      buf += chunk
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        if (!line) continue
        await handleLine(line, socket, opts.registry)
      }
    })
    socket.on('error', () => {})
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.sockPath, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        // Shutdown is already tearing the agents down, so there is no
        // in-flight request worth waiting for. Drop the connections that
        // would otherwise keep close() pending forever.
        for (const socket of open) socket.destroy()
        open.clear()
      }),
  }
}

async function handleLine(line: string, socket: Socket, registry: SpawnRegistry) {
  let req: DaemonRequest
  try {
    req = JSON.parse(line) as DaemonRequest
  } catch {
    socket.write(JSON.stringify({ ok: false, error: 'invalid json' } satisfies DaemonError) + '\n')
    return
  }
  const binding = registry.get(req.spawnId)
  if (!binding) {
    process.stderr.write(
      `[context-mcp] daemon: unknown spawn-id ${req.spawnId} for method=${req.method}\n`,
    )
    socket.write(
      JSON.stringify({
        ok: false,
        error: `unknown spawn-id: ${req.spawnId}`,
      } satisfies DaemonError) + '\n',
    )
    return
  }
  process.stderr.write(
    `[context-mcp] daemon: ${req.method} spawn=${req.spawnId.slice(0, 8)} agent=${binding.agentName}\n`,
  )
  try {
    let result: unknown
    const channelId = binding.threadRef.channelId
    if (req.method === 'getRoomHistory') {
      result = await binding.provider.getRoomHistory(channelId, req.params)
    } else if (req.method === 'getRecentThreads') {
      result = await binding.provider.getRecentThreads(channelId, req.params)
    } else if (req.method === 'getThreadHistory') {
      const threadId = String(req.params.threadId ?? '')
      result = await binding.provider.getThreadHistory(channelId, threadId, req.params)
    } else if (req.method === 'getChannelMembers') {
      result = await binding.provider.getChannelMembers(channelId)
    } else if (req.method === 'getChannelInfo') {
      result = await binding.provider.getChannelInfo(channelId)
    } else {
      socket.write(
        JSON.stringify({
          ok: false,
          error: `unknown method: ${(req as { method: string }).method}`,
        } satisfies DaemonError) + '\n',
      )
      return
    }
    socket.write(JSON.stringify({ ok: true, result } satisfies DaemonResponse) + '\n')
  } catch (err) {
    socket.write(
      JSON.stringify({
        ok: false,
        error: String(err instanceof Error ? err.message : err),
      } satisfies DaemonError) + '\n',
    )
  }
}

export async function callDaemon(sockPath: string, req: DaemonRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(sockPath)
    let buf = ''
    socket.setEncoding('utf8')
    socket.on('error', reject)
    socket.on('data', (chunk) => {
      buf += chunk
      const idx = buf.indexOf('\n')
      if (idx < 0) return
      const line = buf.slice(0, idx)
      let parsed: DaemonResponse | DaemonError
      try {
        parsed = JSON.parse(line) as DaemonResponse | DaemonError
      } catch (e) {
        socket.end()
        reject(e instanceof Error ? e : new Error(String(e)))
        return
      }
      socket.end()
      if (parsed.ok) resolve(parsed.result)
      else reject(new Error(parsed.error))
    })
    socket.write(JSON.stringify(req) + '\n')
  })
}

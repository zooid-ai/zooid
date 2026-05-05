import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { serve, type ServerType } from '@hono/node-server'
import {
  ApprovalCorrelator,
  findConfigFile,
  findHttpTransport,
  findMatrixTransport,
  loadWorkforceConfig,
  mergeCliFlags,
  type CliFlags,
} from '@zooid/core'
import { createApp } from '@zooid/transport-http'
import {
  MatrixClient,
  createMatrixTransport,
  type AgentBinding,
} from '@zooid/transport-matrix'
import { buildAcpRegistry } from '../build-registry.js'

export interface StartDaemonOpts {
  configPath?: string
  cwd?: string
  cliFlags?: CliFlags
  installSignalHandlers?: boolean
}

export interface DaemonHandle {
  port: number
  agentNames: string[]
  stop(): Promise<void>
  whenStopped: Promise<void>
}

function listenAsync(server: ServerType): Promise<number> {
  return new Promise((resolve) => {
    const check = () => {
      const addr = server.address() as AddressInfo | string | null
      if (addr && typeof addr === 'object') resolve(addr.port)
      else setImmediate(check)
    }
    check()
  })
}

function closeAsync(server: ServerType): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve())
  })
}

export async function startDaemon(opts: StartDaemonOpts = {}): Promise<DaemonHandle> {
  const cwd = opts.cwd ?? process.cwd()
  const found = opts.configPath ? { path: opts.configPath } : findConfigFile(cwd)
  if (!found) throw new Error('workforce.yaml is required')
  const base = loadWorkforceConfig(readFileSync(found.path, 'utf8'))
  const config = mergeCliFlags(base, opts.cliFlags ?? {})

  const approvals = new ApprovalCorrelator()
  const registry = buildAcpRegistry(config, { approvals })
  const agentNames = Object.keys(config.agents)

  let server: ServerType | null = null
  let stopped = false
  let resolveStopped!: () => void
  const whenStopped = new Promise<void>((r) => {
    resolveStopped = r
  })

  const matrix = findMatrixTransport(config)
  let port: number

  if (matrix) {
    const client = new MatrixClient({
      homeserver: matrix.transport.homeserver,
      asToken: matrix.transport.as_token,
    })
    const bindings: AgentBinding[] = []
    for (const a of Object.values(config.agents)) {
      if (a.transport !== matrix.name) continue
      if (!a.matrix_user_id || !a.rooms || !a.trigger) {
        throw new Error(
          `agent ${a.name}: matrix_user_id, rooms, and trigger are required`,
        )
      }
      bindings.push({
        name: a.name,
        userId: a.matrix_user_id,
        rooms: a.rooms,
        trigger: a.trigger,
      })
    }
    const transport = createMatrixTransport({
      agents: registry,
      approvals,
      client,
      bindings,
      hsToken: matrix.transport.hs_token,
    })
    await transport.bootstrap()
    const requestedPort = matrix.transport.port ?? 8080
    server = serve({ fetch: transport.app.fetch, port: requestedPort })
    port = await listenAsync(server)
  } else {
    const http = findHttpTransport(config)
    if (!http) throw new Error('no transport declared in workforce.yaml')
    const token = process.env.ZOOID_TOKEN
    if (!token) throw new Error('ZOOID_TOKEN is required for http transport')
    const app = createApp({ agents: registry, approvals, token })
    server = serve({ fetch: app.fetch, port: http.transport.port })
    port = await listenAsync(server)
  }

  const stop = async (): Promise<void> => {
    if (stopped) return whenStopped
    stopped = true
    try {
      if (server) await closeAsync(server)
    } catch {
      // swallow
    }
    try {
      await registry.stopAll()
    } catch (err) {
      console.error('stopAll:', err)
    }
    resolveStopped()
  }

  if (opts.installSignalHandlers !== false) {
    const handler = (sig: NodeJS.Signals): void => {
      console.log(`received ${sig}, stopping agents...`)
      void stop().then(() => process.exit(0))
    }
    process.on('SIGINT', () => handler('SIGINT'))
    process.on('SIGTERM', () => handler('SIGTERM'))
  }

  return { port, agentNames, stop, whenStopped }
}

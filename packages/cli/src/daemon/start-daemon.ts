import { readFileSync } from 'node:fs'
import { mkdir, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import { serve, type ServerType } from '@hono/node-server'
import {
  ApprovalCorrelator,
  findConfigFile,
  findHttpTransport,
  findMatrixTransport,
  loadZooidConfig,
  mergeCliFlags,
  type CliFlags,
  type TapEvent,
} from '@zooid/core'
import { createApp } from '@zooid/transport-http'
import {
  MatrixClient,
  MediaClient,
  createMatrixTransport,
  ensureDefaultChannel,
  ensureWorkforceSpace,
  startWorkforcePublisher,
  type AgentBinding,
  type PublisherHandle,
} from '@zooid/transport-matrix'
import {
  SpawnRegistry,
  startDaemonSocketServer,
  type DaemonSocketHandle,
} from '@zooid/context-mcp'
import { buildAcpRegistry } from '../build-registry.js'
import { prepullImages } from '../prepull-images.js'

export interface StartDaemonOpts {
  configPath?: string
  cwd?: string
  cliFlags?: CliFlags
  installSignalHandlers?: boolean
  /** Admin Matrix user ID. Forwarded to the matrix transport for room bootstrap. */
  adminUserId?: string
  /** Observability tap forwarded to each AcpClient. */
  onTap?: (agentName: string, event: TapEvent) => void
  /**
   * Per-agent state root (`<dataRoot>/agents/`). Threaded into
   * `buildAcpRegistry` so each AcpClient persists `sessionId`s across
   * daemon restarts.
   */
  agentsDir?: string
  /** Skip the startup image-prepull pass entirely. */
  noPrepull?: boolean
  /** Force a re-pull of every resolved image at startup (no inspect check). */
  refreshImages?: boolean
  /**
   * Create the workforce space publicly joinable instead of invite-only. Set
   * only by `zooid dev`: the local homeserver is never deployed, so a
   * self-service-registered account can join `#<space>` from the web client
   * without an invite. Production (`zooid start`) leaves this off.
   */
  publicWorkforceSpace?: boolean
  /**
   * Per-line progress hook for the image-prepull pass. Called once per
   * top-level summary plus once per image (start + completion). Used by
   * `zooid dev` to surface pull progress under the "Start daemon" listr
   * task instead of leaving the user staring at an unmoving spinner.
   */
  prepullLog?: (line: string) => void
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
  if (!found) throw new Error('zooid.yaml is required')
  const configDir = dirname(found.path)
  const base = loadZooidConfig(readFileSync(found.path, 'utf8'), { configDir })
  const config = mergeCliFlags(base, opts.cliFlags ?? {})

  const approvals = new ApprovalCorrelator()

  const daemonSockPath = opts.agentsDir
    ? join(opts.agentsDir, '..', 'run', 'context.sock')
    : join(tmpdir(), `zooid-context-${process.pid}.sock`)
  await mkdir(dirname(daemonSockPath), { recursive: true }).catch(() => {})
  const contextSpawnRegistry = new SpawnRegistry()
  let contextSocket: DaemonSocketHandle | null = null
  try {
    contextSocket = await startDaemonSocketServer({
      sockPath: daemonSockPath,
      registry: contextSpawnRegistry,
    })
  } catch (err) {
    console.warn('[context] daemon socket startup failed; zooid-context MCP disabled:', err)
  }

  const dataDir = opts.agentsDir ? dirname(opts.agentsDir) : undefined
  const registry = buildAcpRegistry(config, {
    approvals,
    onTap: opts.onTap,
    agentsDir: opts.agentsDir,
    contextSpawnRegistry: contextSocket ? contextSpawnRegistry : undefined,
    daemonSockPath: contextSocket ? daemonSockPath : undefined,
    configDir,
    dataDir,
    daemonHome: process.env.HOME,
  })
  const agentNames = Object.keys(config.agents)

  if (config.runtime !== 'local') {
    await prepullImages(registry, {
      engine: config.runtime === 'podman' ? 'podman' : 'docker',
      runtime: config.runtime,
      skip: opts.noPrepull ?? process.env.ZOOID_NO_PREPULL === '1',
      refresh: opts.refreshImages ?? process.env.ZOOID_REFRESH_IMAGES === '1',
      log: opts.prepullLog,
    })
  }

  console.log(
    `[context] socket=${daemonSockPath} ` +
      `status=${contextSocket ? 'listening' : 'disabled'} ` +
      `agents={${agentNames
        .map((n) => `${n}:${registry.hasContextSpawn(n) ? 'yes' : 'no'}`)
        .join(', ')}}`,
  )

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
    const mediaClient = new MediaClient({
      homeserver: matrix.transport.homeserver,
      asToken: matrix.transport.as_token,
    })
    const isContainerRuntime = config.runtime !== 'local'
    const bindings: AgentBinding[] = []
    for (const a of Object.values(config.agents)) {
      if (a.matrix?.transport !== matrix.name) continue
      const binding: AgentBinding = {
        name: a.name,
        userId: a.matrix.user_id,
        rooms: a.matrix.rooms,
        trigger: a.matrix.trigger,
      }
      if (a.matrix.display_name !== undefined) binding.displayName = a.matrix.display_name
      // Resolve workspace dirs for media attachment routing.
      const workspaceDir = isAbsolute(a.workdir) ? a.workdir : resolve(configDir, a.workdir)
      binding.workspaceDir = workspaceDir
      binding.agentWorkspacePath = isContainerRuntime ? '/workspace' : workspaceDir
      bindings.push(binding)
    }
    const transport = createMatrixTransport({
      agents: registry,
      approvals,
      client,
      bindings,
      hsToken: matrix.transport.hs_token,
      adminUserId: opts.adminUserId,
      media: mediaClient,
    })
    const requestedPort = matrix.transport.port ?? 9000
    // Bind 0.0.0.0 explicitly — @hono/node-server defaults to IPv6-only on
    // macOS, which Docker's NAT bridge can't reach when Tuwunel pushes AS
    // events back to host.docker.internal:<port>.
    server = serve({ fetch: transport.app.fetch, port: requestedPort, hostname: '0.0.0.0' })
    port = await listenAsync(server)

    // user_namespace is a regex like `@.*:localhost`; the part after the last
    // `:` is the homeserver's server_name. Fall back to the homeserver URL's
    // host if the namespace shape is unexpected.
    const serverName =
      matrix.transport.user_namespace.split(':').slice(1).join(':').replace(/\\?\)?$/, '') ||
      new URL(matrix.transport.homeserver).hostname
    const asUserId = `@${matrix.transport.sender_localpart}:${serverName}`
    const spaceLocalpart = matrix.transport.space ?? 'dev'
    const adminUserIds = opts.adminUserId ? [opts.adminUserId] : []
    let spaceRoomId: string | undefined
    try {
      spaceRoomId = await ensureWorkforceSpace({
        client,
        asUserId,
        serverName,
        spaceLocalpart,
        preset: 'public_chat',
        admins: adminUserIds,
        joinRule: opts.publicWorkforceSpace ? 'public' : 'invite',
      })
      console.log(`[matrix] ensured workforce space #${spaceLocalpart}:${serverName} → ${spaceRoomId}`)
    } catch (err) {
      console.warn('[matrix] workforce space provisioning failed:', err)
    }

    // Bootstrap *after* the listener is up: registerBot/createRoom/joinRoom
    // each trigger Tuwunel to push events back to the AS, and Tuwunel only
    // retries those a few times before dropping. Listening first ensures
    // those pushes don't hit a connection-refused. Bootstrap also runs
    // *after* the space exists so BotPool can attach each agent room as
    // m.space.child while joining it.
    await transport.bootstrap({ spaceRoomId, asUserId, adminUserIds })

    if (spaceRoomId) {
      try {
        const generalRoomId = await ensureDefaultChannel({
          client,
          asUserId,
          serverName,
          spaceId: spaceRoomId,
          admins: adminUserIds,
        })
        console.log(`[matrix] ensured default channel #general:${serverName} → ${generalRoomId}`)
      } catch (err) {
        console.warn('[matrix] default channel provisioning failed:', err)
      }
      try {
        const publisher: PublisherHandle = await startWorkforcePublisher({
          client,
          spaceRoomId,
          asUserId,
          getAgents: () => bindings,
        })
        console.log(`[matrix] published eco.zoon.workforce (${bindings.length} agents)`)
        void publisher
      } catch (err) {
        console.warn('[matrix] workforce roster publication failed:', err)
      }
    }
  } else {
    const http = findHttpTransport(config)
    if (!http) throw new Error('no transport declared in zooid.yaml')
    const token = process.env.ZOOID_TOKEN
    if (!token) throw new Error('ZOOID_TOKEN is required for http transport')
    const app = createApp({ agents: registry, approvals, token })
    server = serve({ fetch: app.fetch, port: http.transport.port, hostname: '0.0.0.0' })
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
    try {
      if (contextSocket) await contextSocket.close()
      await unlink(daemonSockPath).catch(() => {})
    } catch {
      // swallow
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

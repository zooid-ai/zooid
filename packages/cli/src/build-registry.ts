import { LocalAcpRuntime } from '@zooid/runtime-local'
import { DockerAcpRuntime } from '@zooid/runtime-docker'
import {
  AcpAgentRegistry,
  type AcpRuntime,
  type ApprovalCorrelator,
  type ContextSpawnFactory,
  type TapEvent,
  type ZooidConfig,
  type TransportContextProvider,
} from '@zooid/core'
import { MatrixClient, MatrixContextProvider } from '@zooid/transport-matrix'
import { SpawnRegistry, buildContextServerSpec } from '@zooid/context-mcp'

export interface BuildAcpRegistryOptions {
  /** Override the runtime selection (tests). */
  runtime?: AcpRuntime
  /** When set, the registry's approval handler routes through this correlator. */
  approvals?: ApprovalCorrelator
  /** Observability tap forwarded to each AcpClient. */
  onTap?: (agentName: string, event: TapEvent) => void
  /**
   * Per-agent state root (`<dataRoot>/agents/`). When set, each AcpClient
   * persists its `(threadId → sessionId)` map under
   * `<agentsDir>/<agentName>/sessions.json` so threads survive daemon restarts.
   */
  agentsDir?: string
  /**
   * Per-spawn binding store for the zooid-context MCP server. When set
   * together with `daemonSockPath`, agents bound to a transport that owns
   * conversation context get a `contextSpawn` factory threaded into their
   * AcpClient so `session/new mcpServers` includes the zooid-context entry.
   */
  contextSpawnRegistry?: SpawnRegistry
  /** Path to the daemon's context Unix socket. Passed to the MCP server bin. */
  daemonSockPath?: string
}

/**
 * Build an `AcpAgentRegistry` from a parsed workforce config.
 *
 *   - `runtime: local`   → `LocalAcpRuntime`
 *   - `runtime: docker`  → `DockerAcpRuntime` (engine: docker)
 *   - `runtime: podman`  → `DockerAcpRuntime` (engine: podman)
 *
 * Per-agent `container.env` is passed through to each `AcpClient`'s spawn
 * spec verbatim (interpolation happens at parse time in `@zooid/core`).
 * The image is resolved as `agent.container?.image ?? cfg.container?.image`.
 */
export function buildAcpRegistry(
  cfg: ZooidConfig,
  opts: BuildAcpRegistryOptions = {},
): AcpAgentRegistry {
  for (const [name, agent] of Object.entries(cfg.agents)) {
    if (!agent.acp) {
      throw new Error(`agents.${name}: missing acp block (parser should have caught this)`)
    }
  }

  const runtime = opts.runtime ?? defaultRuntimeFor(cfg)
  const env: Record<string, Record<string, string>> = {}
  const image: Record<string, string | undefined> = {}
  for (const [name, agent] of Object.entries(cfg.agents)) {
    env[name] = agent.container?.env ?? {}
    image[name] = agent.container?.image ?? cfg.container?.image
  }

  const contextSpawns = buildContextSpawns(cfg, opts)

  return new AcpAgentRegistry({
    runtime,
    agents: cfg.agents,
    env,
    image,
    approvals: opts.approvals,
    onTap: opts.onTap,
    agentsDir: opts.agentsDir,
    contextSpawns,
  })
}

function buildContextSpawns(
  cfg: ZooidConfig,
  opts: BuildAcpRegistryOptions,
): Record<string, ContextSpawnFactory | undefined> | undefined {
  if (!opts.contextSpawnRegistry || !opts.daemonSockPath) return undefined
  const registry = opts.contextSpawnRegistry
  const sockPath = opts.daemonSockPath

  // Share one MatrixClient per matrix transport (only state is homeserver +
  // asToken). Per-agent providers wrap that client with the agent's own
  // user_id as asUserId — when the AS impersonates the agent (via ?user_id=)
  // it sees the rooms that bot is a member of. The AS sender_localpart
  // typically isn't in those rooms, so impersonating it returns empty
  // chunks.
  const matrixClients = new Map<string, MatrixClient>()
  const agentBots = new Map<string, string>()
  for (const [name, agent] of Object.entries(cfg.agents)) {
    if (agent.matrix?.user_id) agentBots.set(agent.matrix.user_id, name)
  }
  for (const [tname, tcfg] of Object.entries(cfg.transports)) {
    if (tcfg.type !== 'matrix') continue
    matrixClients.set(
      tname,
      new MatrixClient({ homeserver: tcfg.homeserver, asToken: tcfg.as_token }),
    )
  }

  const result: Record<string, ContextSpawnFactory | undefined> = {}
  for (const [name, agent] of Object.entries(cfg.agents)) {
    if (agent.matrix && matrixClients.has(agent.matrix.transport)) {
      const client = matrixClients.get(agent.matrix.transport)!
      const provider: TransportContextProvider = new MatrixContextProvider({
        client,
        asUserId: agent.matrix.user_id,
        agentBots,
      })
      result[name] = async (threadId: string, channelId?: string) => {
        const spawnId = registry.register({
          agentName: name,
          threadRef: { channelId: channelId ?? threadId, threadId },
          provider,
        })
        return buildContextServerSpec({ spawnId, sockPath })
      }
    } else {
      result[name] = undefined
    }
  }
  return result
}

function defaultRuntimeFor(cfg: ZooidConfig): AcpRuntime {
  if (cfg.runtime === 'local') return new LocalAcpRuntime()
  if (cfg.runtime === 'docker') {
    return new DockerAcpRuntime({ defaultImage: cfg.container?.image, engine: 'docker' })
  }
  if (cfg.runtime === 'podman') {
    return new DockerAcpRuntime({ defaultImage: cfg.container?.image, engine: 'podman' })
  }
  throw new Error(`unsupported runtime: ${cfg.runtime}`)
}

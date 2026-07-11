import { isAbsolute, resolve as pathResolve } from 'node:path'
import { LocalAcpRuntime } from '@zooid/runtime-local'
import { DockerAcpRuntime } from '@zooid/runtime-docker'
import {
  AcpAgentRegistry,
  type AcpMount,
  type AcpRuntime,
  type AgentConfig,
  type ApprovalCorrelator,
  type ContextSpawnFactory,
  type MountConfig,
  type TapEvent,
  type ZooidConfig,
  type TransportContextProvider,
} from '@zooid/core'
import { MatrixClient, MatrixContextProvider } from '@zooid/transport-matrix'
import { SpawnRegistry, buildContextServerSpec, contextContainerMounts } from '@zooid/context-mcp'
import { PRESETS, type PresetMount, type PresetName } from '@zooid/acp-client'

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
  /**
   * Directory containing zooid.yaml. Required when any agent uses the
   * workspace auto-mount (the default under `runtime: docker | podman`):
   * relative `agent.workdir` paths are resolved against this dir.
   */
  configDir?: string
  /**
   * Daemon data root. Each agent's preset mounts target
   * `<dataDir>/agents/<agentName>` on the host.
   */
  dataDir?: string
  /**
   * Daemon user's `$HOME`. Sourced by the v1 preset `home` / `data` /
   * `config` mounts. Tests inject a stub; production threads
   * `process.env.HOME` from `start-daemon`.
   */
  daemonHome?: string
  /**
   * Sink for the per-agent "resolved image + mounts" startup log lines.
   * Defaults to `console.log`. Tests pass a capture array.
   */
  log?: (line: string) => void
}

type ImageProvenance = 'agent' | 'workforce' | `preset:${PresetName}` | 'unresolved'

interface ResolvedImage {
  image: string | undefined
  source: ImageProvenance
}

const CONTAINER_WORKDIR = '/workspace'

function presetOf(agent: AgentConfig): PresetName | undefined {
  const spec = agent.acp as { preset?: string } | undefined
  if (spec?.preset && spec.preset in PRESETS) return spec.preset as PresetName
  return undefined
}

function resolveAgentImage(
  agent: AgentConfig,
  cfg: ZooidConfig,
): ResolvedImage {
  if (agent.container?.image) return { image: agent.container.image, source: 'agent' }
  if (cfg.container?.image) return { image: cfg.container.image, source: 'workforce' }
  const preset = presetOf(agent)
  const presetImage = preset ? PRESETS[preset]?.image : undefined
  if (presetImage && preset) return { image: presetImage, source: `preset:${preset}` }
  return { image: undefined, source: 'unresolved' }
}

interface ComposedMounts {
  mounts: PresetMount[]
  mkdirs: string[]
  cwd: string
}

function composeAgentMounts(
  name: string,
  agent: AgentConfig,
  cfg: ZooidConfig,
  opts: BuildAcpRegistryOptions,
): ComposedMounts {
  if (cfg.runtime === 'local') {
    return { mounts: [], mkdirs: [], cwd: agent.workdir }
  }

  const disabled = new Set(agent.container?.disable_mounts ?? [])
  const knownIds = new Set<string>(['workspace'])
  const composed: PresetMount[] = []
  let workspaceActive = false

  // Layer 1: workspace auto-mount. Skip when explicitly disabled, or when
  // configDir is missing and the workdir is relative — the daemon path always
  // passes configDir; tests that exercise other concerns (image resolution,
  // env) can leave it off without the workspace mount intruding.
  if (!disabled.has('workspace')) {
    let host = agent.workdir
    if (isAbsolute(host)) {
      composed.push({
        id: 'workspace',
        host,
        target: CONTAINER_WORKDIR,
        mode: 'rw',
        create: true,
      })
      workspaceActive = true
    } else if (opts.configDir) {
      host = pathResolve(opts.configDir, host)
      composed.push({
        id: 'workspace',
        host,
        target: CONTAINER_WORKDIR,
        mode: 'rw',
        create: true,
      })
      workspaceActive = true
    }
  }

  // Layer 2: preset mounts.
  const preset = presetOf(agent)
  if (preset && PRESETS[preset]?.mounts) {
    const dataDir = opts.dataDir ?? process.cwd()
    const ctx = {
      agentName: name,
      agentDataDir: pathResolve(dataDir, 'agents', name),
      containerWorkdir: CONTAINER_WORKDIR,
      daemonHome: opts.daemonHome ?? process.env.HOME ?? '',
    }
    const presetMounts = PRESETS[preset].mounts!(ctx)
    for (const m of presetMounts) {
      knownIds.add(m.id)
      if (!disabled.has(m.id)) composed.push(m)
    }
  }

  // Validate disable_mounts ids — every entry must be either 'workspace' or a
  // preset-declared id. Unknown ids are typos that would silently no-op.
  for (const id of disabled) {
    if (!knownIds.has(id)) {
      throw new Error(
        `agents.${name}.container.disable_mounts: unknown id "${id}". ` +
          `Known ids for this agent: ${[...knownIds].sort().join(', ')}`,
      )
    }
  }

  // Layer 3: user mounts. Auto-id any without one.
  const userMounts: MountConfig[] = agent.container?.mounts ?? []
  let userIdx = 0
  for (const m of userMounts) {
    const id = m.id ?? `user-${userIdx}`
    userIdx++
    const out: PresetMount = {
      id,
      host: m.host,
      target: m.target,
      mode: m.mode,
    }
    if (m.create !== undefined) out.create = m.create
    composed.push(out)
  }

  const mkdirs: string[] = composed
    .filter((m) => m.create)
    .map((m) => m.host)

  return {
    mounts: composed,
    mkdirs,
    cwd: workspaceActive ? CONTAINER_WORKDIR : agent.workdir,
  }
}

/**
 * Build an `AcpAgentRegistry` from a parsed workforce config.
 *
 *   - `runtime: local`   → `LocalAcpRuntime`
 *   - `runtime: docker`  → `DockerAcpRuntime` (engine: docker)
 *   - `runtime: podman`  → `DockerAcpRuntime` (engine: podman)
 *
 * Compose layers (docker/podman only): workspace auto-mount → preset-declared
 * canonical-id mounts (filtered by `container.disable_mounts`) → user mounts.
 * Image resolution: agent.container.image > workforce container.image >
 * preset.image. Under `runtime: docker | podman`, throws at startup if any
 * agent has no resolvable image.
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

  // Startup validation: every docker/podman agent must resolve to an image.
  if (cfg.runtime !== 'local') {
    const missing: Array<{ name: string; preset?: string }> = []
    for (const [name, agent] of Object.entries(cfg.agents)) {
      const { image } = resolveAgentImage(agent, cfg)
      if (!image) {
        missing.push({ name, preset: presetOf(agent) })
      }
    }
    if (missing.length > 0) {
      const lines = missing.map(({ name, preset }) =>
        `  - ${name}${preset ? ` (preset: ${preset})` : ''} — no preset-default image`,
      )
      throw new Error(
        `runtime: ${cfg.runtime} requires a container image for each agent. Unresolved:\n` +
          lines.join('\n') +
          `\nSet agents.<name>.container.image, top-level container.image, or use a ` +
          `preset that ships a default image (claude, codex, opencode).`,
      )
    }
  }

  const runtime = opts.runtime ?? defaultRuntimeFor(cfg)
  const env: Record<string, Record<string, string>> = {}
  const image: Record<string, string | undefined> = {}
  const mountsByAgent: Record<string, AcpMount[]> = {}
  const mkdirByAgent: Record<string, string[]> = {}
  const cwdByAgent: Record<string, string> = {}
  const log = opts.log ?? ((line: string) => console.log(line))

  for (const [name, agent] of Object.entries(cfg.agents)) {
    env[name] = agent.container?.env ?? {}
    const { image: resolvedImage, source } = resolveAgentImage(agent, cfg)
    image[name] = resolvedImage
    const composed = composeAgentMounts(name, agent, cfg, opts)
    mountsByAgent[name] = composed.mounts.map((m) => ({
      path: m.host,
      target: m.target,
      mode: m.mode,
    }))
    mkdirByAgent[name] = composed.mkdirs
    cwdByAgent[name] = composed.cwd
    if (resolvedImage && cfg.runtime !== 'local') {
      const mountSummary = composed.mounts.length === 0
        ? 'mounts=[]'
        : `mounts=[${composed.mounts.map((m) => m.id ?? m.target).join(',')}]`
      log(
        `[zooid] agent ${name.padEnd(12)} image=${resolvedImage}  source=${source}  ${mountSummary}`,
      )
    }
  }

  const contextSpawns = buildContextSpawns(cfg, opts)

  // Container runtimes: opencode spawns the zooid-context MCP subprocess INSIDE
  // its container, so the daemon socket + the (self-contained) bin must be
  // bind-mounted in. Local runtime needs neither — the host spec resolves
  // directly. Only agents that actually got a context factory get the mounts.
  if (cfg.runtime !== 'local' && opts.daemonSockPath && contextSpawns) {
    for (const name of Object.keys(cfg.agents)) {
      if (!contextSpawns[name]) continue
      mountsByAgent[name] = [
        ...(mountsByAgent[name] ?? []),
        ...contextContainerMounts({ sockPath: opts.daemonSockPath }),
      ]
    }
  }

  return new AcpAgentRegistry({
    runtime,
    agents: cfg.agents,
    env,
    image,
    mounts: mountsByAgent,
    mkdirOnSpawn: mkdirByAgent,
    cwd: cwdByAgent,
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
        return buildContextServerSpec({
          spawnId,
          sockPath,
          containerize: cfg.runtime !== 'local',
        })
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

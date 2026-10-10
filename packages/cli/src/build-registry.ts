import type { ElicitationCorrelator } from '@zooid/core'
import { isAbsolute, resolve as pathResolve } from 'node:path'
import { LocalAcpRuntime } from '@zooid/runtime-local'
import { DockerAcpRuntime } from '@zooid/runtime-docker'
import { VM_GUEST_WORKDIR, VmAcpRuntime, vmMachineName } from '@zooid/runtime-vm'
import {
  AcpAgentRegistry,
  isContainerRuntime,
  resolveAgentRuntime,
  type AcpMount,
  type AcpRuntime,
  type AgentConfig,
  type ApprovalCorrelator,
  type ContextSpawnFactory,
  type MountConfig,
  type RuntimeKind,
  type TapEvent,
  type SessionLifecycleEvent,
  type ZooidConfig,
  type TransportContextProvider,
} from '@zooid/core'
import { MatrixClient, MatrixContextProvider } from '@zooid/transport-matrix'
import {
  CONTEXT_CONTAINER_SOCK,
  SpawnRegistry,
  buildContextServerSpec,
  contextContainerMounts,
} from '@zooid/context-mcp'
import { PRESETS, type PresetMount, type PresetName } from '@zooid/acp-client'

export interface BuildAcpRegistryOptions {
  /** Override the runtime selection (tests). */
  runtime?: AcpRuntime
  /** When set, the registry's approval handler routes through this correlator. */
  approvals?: ApprovalCorrelator
  elicitations?: ElicitationCorrelator
  /** Observability tap forwarded to each AcpClient. */
  onTap?: (agentName: string, event: TapEvent) => void
  onLifecycle?: (agentName: string, event: SessionLifecycleEvent) => void
  /**
   * Per-agent state root (`<dataRoot>/agents/`). When set, each AcpClient
   * persists its `(threadId → sessionId)` map under
   * `<agentsDir>/<agentName>/sessions.json` so threads survive daemon restarts.
   */
  agentsDir?: string
  /**
   * Per-spawn binding store for the zooid-context MCP server. When set
   * together with `daemonSockPaths`, agents bound to a transport that owns
   * conversation context get a `contextSpawn` factory threaded into their
   * AcpClient so `session/new mcpServers` includes the zooid-context entry.
   */
  contextSpawnRegistry?: SpawnRegistry
  /** Agent → host path to that agent's context Unix socket. */
  daemonSockPaths?: Record<string, string | undefined>
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

export interface ResolvedImage {
  image: string | undefined
  source: ImageProvenance
}

const CONTAINER_WORKDIR = '/workspace'

export function presetOf(agent: AgentConfig): PresetName | undefined {
  const spec = agent.acp as { preset?: string } | undefined
  if (spec?.preset && spec.preset in PRESETS) return spec.preset as PresetName
  return undefined
}

/**
 * Container agents: agent.container.image > workforce container.image > preset.
 * vm agents: agent.vm.image > preset — never the workforce container image,
 * which belongs to the container engine. [ZOD109]
 */
export function resolveAgentImage(agent: AgentConfig, cfg: ZooidConfig): ResolvedImage {
  if (resolveAgentRuntime(agent, cfg) === 'vm') {
    if (agent.vm?.image) return { image: agent.vm.image, source: 'agent' }
  } else {
    if (agent.container?.image) return { image: agent.container.image, source: 'agent' }
    if (cfg.container?.image) return { image: cfg.container.image, source: 'workforce' }
  }
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
  const kind = resolveAgentRuntime(agent, cfg)
  if (kind === 'local') return { mounts: [], mkdirs: [], cwd: agent.workdir }
  // vm: the workdir mount is made once, at machine create (provision-vms).
  if (kind === 'vm') return { mounts: [], mkdirs: [], cwd: VM_GUEST_WORKDIR }

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

  const mkdirs: string[] = composed.filter((m) => m.create).map((m) => m.host)

  return {
    mounts: composed,
    mkdirs,
    cwd: workspaceActive ? CONTAINER_WORKDIR : agent.workdir,
  }
}

/**
 * Build an `AcpAgentRegistry` from a parsed workforce config. Each agent's
 * runtime resolves on its own (agent > workforce > docker), so one fleet can
 * mix them [ZOD109]:
 *
 *   - `local`   → `LocalAcpRuntime`
 *   - `docker`  → `DockerAcpRuntime` (engine: docker)
 *   - `podman`  → `DockerAcpRuntime` (engine: podman)
 *   - `vm`      → `VmAcpRuntime`, one per agent (its own machine)
 *
 * Compose layers (docker/podman only): workspace auto-mount → preset-declared
 * canonical-id mounts (filtered by `container.disable_mounts`) → user mounts.
 * Image resolution: see `resolveAgentImage`. Throws at startup if any
 * non-local agent has no resolvable image.
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

  // Startup validation: every non-local agent must resolve to an image.
  const missing = new Map<RuntimeKind, Array<{ name: string; preset?: string }>>()
  for (const [name, agent] of Object.entries(cfg.agents)) {
    const kind = resolveAgentRuntime(agent, cfg)
    if (kind === 'local' || resolveAgentImage(agent, cfg).image) continue
    missing.set(kind, [...(missing.get(kind) ?? []), { name, preset: presetOf(agent) }])
  }
  for (const [kind, agents] of missing) {
    const lines = agents.map(
      ({ name, preset }) =>
        `  - ${name}${preset ? ` (preset: ${preset})` : ''} — no preset-default image`,
    )
    if (kind === 'vm') {
      throw new Error(
        `runtime: vm requires an image for each agent. Unresolved:\n` +
          lines.join('\n') +
          `\nSet agents.<name>.vm.image, or use a preset that ships a default image ` +
          `(claude, codex, opencode, pi).`,
      )
    }
    throw new Error(
      `runtime: ${kind} requires a container image for each agent. Unresolved:\n` +
        lines.join('\n') +
        `\nSet agents.<name>.container.image, top-level container.image, or use a ` +
        `preset that ships a default image (claude, codex, opencode, pi).`,
    )
  }

  const runtimeOpts = opts.runtime
    ? { runtime: opts.runtime }
    : { runtimeByAgent: runtimesByAgent(cfg, pathResolve(opts.configDir ?? process.cwd())) }
  const env: Record<string, Record<string, string>> = {}
  const image: Record<string, string | undefined> = {}
  const mountsByAgent: Record<string, AcpMount[]> = {}
  const mkdirByAgent: Record<string, string[]> = {}
  const cwdByAgent: Record<string, string> = {}
  const log = opts.log ?? ((line: string) => console.log(line))

  for (const [name, agent] of Object.entries(cfg.agents)) {
    env[name] = agent.container?.env ?? {}
    if (resolveAgentRuntime(agent, cfg) === 'vm') {
      // A vm agent has no container block. Its env points pi at the guest's
      // writable agent dir and tells the smoke tools where to clone. [ZOD128]
      const preset = presetOf(agent)
      env[name] = {
        ...(preset ? PRESETS[preset].vmCredential?.guestEnv : undefined),
        ...(agent.vm?.git ? { ZOOID_VM_GIT: agent.vm.git } : {}),
      }
    }
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
    const kind = resolveAgentRuntime(agent, cfg)
    if (resolvedImage && kind !== 'local') {
      const mountSummary =
        kind === 'vm'
          ? `runtime=vm machine=${vmMachineName(name, pathResolve(opts.configDir ?? process.cwd()))}`
          : composed.mounts.length === 0
            ? 'mounts=[]'
            : `mounts=[${composed.mounts.map((m) => m.id ?? m.target).join(',')}]`
      log(
        `[zooid] agent ${name.padEnd(12)} image=${resolvedImage}  source=${source}  ${mountSummary}`,
      )
    }
  }

  const contextSpawns = buildContextSpawns(cfg, opts)

  // Extensions run in the agent process (rather than an MCP child), so all
  // context-enabled agents inherit the daemon socket address directly.
  if (contextSpawns) {
    for (const name of Object.keys(cfg.agents)) {
      if (!contextSpawns[name]) continue
      const agentSock = opts.daemonSockPaths?.[name]
      if (!agentSock) continue
      env[name] = {
        ZOOID_DAEMON_SOCK: isContainerRuntime(resolveAgentRuntime(cfg.agents[name]!, cfg))
          ? CONTEXT_CONTAINER_SOCK
          : agentSock,
        ...env[name],
      }
    }
  }

  // Container runtimes: opencode spawns the zooid-context MCP subprocess INSIDE
  // its container, so the daemon socket + the (self-contained) bin must be
  // bind-mounted in. Local runtime needs neither — the host spec resolves
  // directly. Only agents that actually got a context factory get the mounts.
  if (contextSpawns) {
    for (const [name, agent] of Object.entries(cfg.agents)) {
      if (!isContainerRuntime(resolveAgentRuntime(agent, cfg))) continue
      if (!contextSpawns[name]) continue
      const agentSock = opts.daemonSockPaths?.[name]
      if (!agentSock) continue
      mountsByAgent[name] = [
        ...(mountsByAgent[name] ?? []),
        ...contextContainerMounts({ sockPath: agentSock }),
      ]
    }
  }

  return new AcpAgentRegistry({
    ...runtimeOpts,
    agents: cfg.agents,
    env,
    image,
    mounts: mountsByAgent,
    mkdirOnSpawn: mkdirByAgent,
    cwd: cwdByAgent,
    approvals: opts.approvals,
    elicitations: opts.elicitations,
    onTap: opts.onTap,
    onLifecycle: opts.onLifecycle,
    agentsDir: opts.agentsDir,
    contextSpawns,
    onSessionEstablished: (agentName, sessionKey, sessionId) =>
      opts.contextSpawnRegistry?.linkSession(agentName, sessionKey, sessionId),
  })
}

function buildContextSpawns(
  cfg: ZooidConfig,
  opts: BuildAcpRegistryOptions,
): Record<string, ContextSpawnFactory | undefined> | undefined {
  if (!opts.contextSpawnRegistry || !opts.daemonSockPaths) return undefined
  const registry = opts.contextSpawnRegistry

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
    const sockPath = opts.daemonSockPaths[name]
    const kind = resolveAgentRuntime(agent, cfg)
    // No host socket reaches a vm guest; see contextUnavailableAgents.
    if (kind !== 'vm' && agent.matrix && matrixClients.has(agent.matrix.transport) && sockPath) {
      const client = matrixClients.get(agent.matrix.transport)!
      const provider: TransportContextProvider = new MatrixContextProvider({
        client,
        asUserId: agent.matrix.user_id,
        agentBots,
        // Same array BotPool.bootstrap rewrites `.alias` on in place — reads
        // through this after bootstrap see canonical room IDs.
        rooms: agent.matrix.rooms,
      })
      result[name] = async (threadId: string, channelId?: string, sessionKey?: string) => {
        const spawnId = registry.register({
          agentName: name,
          threadRef: { channelId: channelId ?? threadId, threadId },
          provider,
          sessionKey: sessionKey ?? threadId,
        })
        return buildContextServerSpec({
          spawnId,
          sockPath,
          containerize: isContainerRuntime(kind),
        })
      }
    } else {
      result[name] = undefined
    }
  }
  return result
}

function matrixBoundAgents(cfg: ZooidConfig): string[] {
  const matrixTransports = new Set(
    Object.entries(cfg.transports)
      .filter(([, transport]) => transport.type === 'matrix')
      .map(([name]) => name),
  )
  return Object.entries(cfg.agents)
    .filter(([, agent]) => agent.matrix && matrixTransports.has(agent.matrix.transport))
    .map(([name]) => name)
}

/** Agents on configured Matrix transports get a context listener and binding — except vm agents. */
export function contextEligibleAgents(cfg: ZooidConfig): string[] {
  return matrixBoundAgents(cfg).filter(
    (name) => resolveAgentRuntime(cfg.agents[name]!, cfg) !== 'vm',
  )
}

/** Matrix-bound vm agents: no host socket can reach the guest, so no context tools. [ZOD109] */
export function contextUnavailableAgents(cfg: ZooidConfig): string[] {
  return matrixBoundAgents(cfg).filter(
    (name) => resolveAgentRuntime(cfg.agents[name]!, cfg) === 'vm',
  )
}

/** Agents whose images the container engine must prepull. */
export function containerAgentNames(cfg: ZooidConfig): string[] {
  return Object.entries(cfg.agents)
    .filter(([, agent]) => isContainerRuntime(resolveAgentRuntime(agent, cfg)))
    .map(([name]) => name)
}

/** One runtime per agent: local/docker/podman share an instance per kind, each vm agent gets its own. */
function runtimesByAgent(cfg: ZooidConfig, configDir: string): Record<string, AcpRuntime> {
  const shared = new Map<RuntimeKind, AcpRuntime>()
  const sharedFor = (kind: 'local' | 'docker' | 'podman'): AcpRuntime => {
    let rt = shared.get(kind)
    if (!rt) {
      rt =
        kind === 'local'
          ? new LocalAcpRuntime()
          : new DockerAcpRuntime({ defaultImage: cfg.container?.image, engine: kind })
      shared.set(kind, rt)
    }
    return rt
  }
  const out: Record<string, AcpRuntime> = {}
  for (const [name, agent] of Object.entries(cfg.agents)) {
    const kind = resolveAgentRuntime(agent, cfg)
    out[name] =
      kind === 'vm' ? new VmAcpRuntime({ machine: vmMachineName(name, configDir) }) : sharedFor(kind)
  }
  return out
}

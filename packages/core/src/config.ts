import { parse } from 'yaml'
import type {
  AgentConfig,
  AgentDockerConfig,
  BuddConfig,
  CliFlags,
  DockerConfig,
  ExtraMount,
} from './types.js'

export const DEFAULT_DOCKER_IMAGE = 'budd/claude-code:latest'

const AGENT_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/

function parseExtraMounts(agentName: string, raw: unknown): ExtraMount[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) {
    throw new Error(`agents.${agentName}.docker.mounts.extra must be an array`)
  }
  const mounts: ExtraMount[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(
        `agents.${agentName}.docker.mounts.extra[] must be a mapping`,
      )
    }
    const e = entry as Record<string, unknown>
    if (typeof e.path !== 'string' || e.path.length === 0) {
      throw new Error(
        `agents.${agentName}.docker.mounts.extra[].path is required`,
      )
    }
    if (typeof e.target !== 'string' || e.target.length === 0) {
      throw new Error(
        `agents.${agentName}.docker.mounts.extra[].target is required`,
      )
    }
    const mode = e.mode ?? 'ro'
    if (mode !== 'ro' && mode !== 'rw') {
      throw new Error(
        `agents.${agentName}.docker.mounts.extra[].mode must be "ro" or "rw" (got "${mode}")`,
      )
    }
    mounts.push({ path: e.path, target: e.target, mode })
  }
  return mounts
}

function parseAgentDocker(name: string, raw: unknown): AgentDockerConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`agents.${name}.docker must be a mapping`)
  }
  const d = raw as Record<string, unknown>
  const out: AgentDockerConfig = {}
  if (d.image !== undefined) {
    if (typeof d.image !== 'string' || d.image.length === 0) {
      throw new Error(`agents.${name}.docker.image must be a non-empty string`)
    }
    out.image = d.image
  }
  if (d.mounts !== undefined) {
    if (typeof d.mounts !== 'object' || d.mounts === null || Array.isArray(d.mounts)) {
      throw new Error(`agents.${name}.docker.mounts must be a mapping`)
    }
    const m = d.mounts as Record<string, unknown>
    const mounts: NonNullable<AgentDockerConfig['mounts']> = {}
    const extra = parseExtraMounts(name, m.extra)
    if (extra) mounts.extra = extra
    if (m.workspace_readonly_disable !== undefined) {
      if (!Array.isArray(m.workspace_readonly_disable)) {
        throw new Error(
          `agents.${name}.docker.mounts.workspace_readonly_disable must be an array of strings`,
        )
      }
      const list: string[] = []
      for (const v of m.workspace_readonly_disable) {
        if (typeof v !== 'string' || v.length === 0) {
          throw new Error(
            `agents.${name}.docker.mounts.workspace_readonly_disable[] must be a non-empty string`,
          )
        }
        list.push(v)
      }
      mounts.workspace_readonly_disable = list
    }
    if (mounts.extra || mounts.workspace_readonly_disable) out.mounts = mounts
  }
  return out
}

function parseAgents(
  raw: unknown,
  runtime: 'local' | 'docker',
  daemonHooks: { pre_turn?: string; post_turn?: string },
): Record<string, AgentConfig> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('agents: must be a mapping')
  }
  const entries = Object.entries(raw as Record<string, unknown>)
  if (entries.length === 0) {
    throw new Error('agents: must have at least one entry')
  }
  const result: Record<string, AgentConfig> = {}
  for (const [name, val] of entries) {
    if (!AGENT_NAME_RE.test(name)) {
      throw new Error(
        `agents.${name}: name must match /^[a-z][a-z0-9-]{0,31}$/`,
      )
    }
    if (!val || typeof val !== 'object' || Array.isArray(val)) {
      throw new Error(`agents.${name} must be a mapping`)
    }
    const entry = val as Record<string, unknown>
    if (typeof entry.workdir !== 'string' || entry.workdir.length === 0) {
      throw new Error(`agents.${name}.workdir is required`)
    }
    const agentHooks: AgentConfig['hooks'] = {}
    if (daemonHooks.pre_turn !== undefined) agentHooks.pre_turn = daemonHooks.pre_turn
    if (daemonHooks.post_turn !== undefined) agentHooks.post_turn = daemonHooks.post_turn
    if (entry.hooks !== undefined && entry.hooks !== null) {
      if (typeof entry.hooks !== 'object' || Array.isArray(entry.hooks)) {
        throw new Error(`agents.${name}.hooks must be a mapping`)
      }
      const h = entry.hooks as Record<string, unknown>
      if (Object.prototype.hasOwnProperty.call(h, 'pre_turn')) {
        if (typeof h.pre_turn === 'string') agentHooks.pre_turn = h.pre_turn
        else delete agentHooks.pre_turn
      }
      if (Object.prototype.hasOwnProperty.call(h, 'post_turn')) {
        if (typeof h.post_turn === 'string') agentHooks.post_turn = h.post_turn
        else delete agentHooks.post_turn
      }
    }

    let adapter: string | undefined
    if (entry.adapter !== undefined) {
      if (typeof entry.adapter !== 'string' || entry.adapter.length === 0) {
        throw new Error(`agents.${name}.adapter must be a non-empty string`)
      }
      adapter = entry.adapter
    }

    let dockerBlock: AgentDockerConfig | undefined
    if (entry.docker !== undefined && entry.docker !== null) {
      if (runtime !== 'docker') {
        throw new Error(
          `agents.${name}.docker is only valid when runtime: docker (got runtime: ${runtime})`,
        )
      }
      dockerBlock = parseAgentDocker(name, entry.docker)
    }

    const agentCfg: AgentConfig = {
      name,
      workdir: entry.workdir,
      hooks: agentHooks,
    }
    if (adapter) agentCfg.adapter = adapter
    if (dockerBlock) agentCfg.docker = dockerBlock
    result[name] = agentCfg
  }
  return result
}

export function loadConfig(yamlText: string): BuddConfig {
  const raw = parse(yamlText) ?? {}
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('daemon.yaml must be a YAML object')
  }

  const transport = raw.transport ?? 'http'
  if (transport !== 'http') {
    throw new Error(
      `transport must be "http" (got "${transport}"). Slack and Zooid transports are not in the MVP — see spec 031.`,
    )
  }

  // Default flips to docker now that the docker runtime is available — the
  // Docker base image is the supported deployment target. Users on the
  // local runtime must opt in explicitly with `runtime: local`.
  const runtime = raw.runtime ?? 'docker'
  if (runtime !== 'local' && runtime !== 'docker') {
    throw new Error(`runtime must be "local" or "docker" (got "${runtime}")`)
  }

  const port = raw.port ?? 8080
  if (!Number.isInteger(port)) {
    throw new Error(`port must be an integer (got ${JSON.stringify(port)})`)
  }

  // Top-level workdir was the flat-form sugar; it's gone. Reject it with a
  // pointer at the new shape so old configs fail loudly instead of silently
  // ignoring the field.
  if (raw.workdir !== undefined) {
    throw new Error(
      'top-level workdir is not supported; define agents: { <name>: { workdir: ... } } instead',
    )
  }

  if (raw.agents === undefined) {
    throw new Error(
      'agents: is required — daemon.yaml must define at least one agent',
    )
  }

  // Reject daemon-wide docker.home_mounts with a migration pointer. It
  // didn't generalise across mixed-adapter daemons; replacement is
  // per-adapter `homeReadOnly`/`sessionStateDir` + per-agent `docker.mounts.extra`.
  if (
    raw.docker &&
    typeof raw.docker === 'object' &&
    (raw.docker as Record<string, unknown>).home_mounts !== undefined
  ) {
    throw new Error(
      'docker.home_mounts is removed. Use per-agent docker.mounts.extra and adapter-declared homeReadOnly/sessionStateDir instead.',
    )
  }

  const daemonHooks: BuddConfig['hooks'] = {}
  if (raw.hooks && typeof raw.hooks === 'object') {
    if (typeof raw.hooks.pre_turn === 'string') daemonHooks.pre_turn = raw.hooks.pre_turn
    if (typeof raw.hooks.post_turn === 'string') daemonHooks.post_turn = raw.hooks.post_turn
  }

  const agents = parseAgents(raw.agents, runtime, daemonHooks)

  const config: BuddConfig = {
    transport,
    port,
    runtime,
    agents,
    hooks: daemonHooks,
  }

  if (runtime === 'docker') {
    const rawDocker = raw.docker && typeof raw.docker === 'object' ? raw.docker : {}
    const image =
      typeof rawDocker.image === 'string' && rawDocker.image.length > 0
        ? rawDocker.image
        : DEFAULT_DOCKER_IMAGE
    const docker: DockerConfig = { image }
    config.docker = docker
  }

  return config
}

export function mergeCliFlags(base: BuddConfig, flags: CliFlags): BuddConfig {
  if (flags.transport !== undefined && flags.transport !== 'http') {
    throw new Error(
      `transport must be "http" (got "${flags.transport}"). Slack and Zooid transports are not in the MVP.`,
    )
  }
  const runtimeFlag = flags.runtime as 'local' | 'docker' | undefined
  if (
    runtimeFlag !== undefined &&
    runtimeFlag !== 'local' &&
    runtimeFlag !== 'docker'
  ) {
    throw new Error(`runtime must be "local" or "docker" (got "${flags.runtime}")`)
  }
  if (flags.port !== undefined && !Number.isInteger(flags.port)) {
    throw new Error(`port must be an integer (got ${JSON.stringify(flags.port)})`)
  }
  const runtime = runtimeFlag ?? base.runtime
  const merged: BuddConfig = {
    transport: 'http',
    port: flags.port ?? base.port,
    runtime,
    agents: base.agents,
    hooks: { ...base.hooks },
  }
  if (runtime === 'docker') {
    const baseDocker = base.docker ?? { image: DEFAULT_DOCKER_IMAGE }
    merged.docker = {
      image: flags.image ?? baseDocker.image ?? DEFAULT_DOCKER_IMAGE,
    }
  }
  return merged
}

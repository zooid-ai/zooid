import { parse } from 'yaml'
import type { AcpAgentSpec } from './acp-types.js'
import { isPreset } from '@zooid/acp-client'
import type {
  AgentConfig,
  AgentDockerConfig,
  BuddConfig,
  CliFlags,
  DockerConfig,
} from './types.js'

export const DEFAULT_DOCKER_IMAGE = 'ghcr.io/zooid-ai/zooid-agent-base:latest'

const AGENT_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/

function parseAcpBlock(name: string, raw: unknown): AcpAgentSpec {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`agents.${name}.acp: must be a mapping with either preset or command`)
  }
  const a = raw as Record<string, unknown>
  const hasPreset = a.preset !== undefined
  const hasCommand = a.command !== undefined
  if (hasPreset && hasCommand) {
    throw new Error(
      `agents.${name}.acp: specify either preset or command, not both`,
    )
  }
  if (!hasPreset && !hasCommand) {
    throw new Error(
      `agents.${name}.acp: must specify either preset or command`,
    )
  }
  if (hasPreset) {
    if (typeof a.preset !== 'string' || a.preset.length === 0) {
      throw new Error(`agents.${name}.acp.preset: must be a non-empty string`)
    }
    if (!isPreset(a.preset)) {
      throw new Error(
        `agents.${name}.acp.preset: unknown preset "${a.preset}"`,
      )
    }
    return { preset: a.preset } as AcpAgentSpec
  }
  if (typeof a.command !== 'string' || a.command.length === 0) {
    throw new Error(`agents.${name}.acp.command: must be a non-empty string`)
  }
  let args: string[] = []
  if (a.args !== undefined) {
    if (!Array.isArray(a.args)) {
      throw new Error(`agents.${name}.acp.args: must be an array of strings`)
    }
    for (const v of a.args) {
      if (typeof v !== 'string') {
        throw new Error(`agents.${name}.acp.args[]: must be a string`)
      }
      args.push(v)
    }
  }
  return { command: a.command, args } as AcpAgentSpec
}

function parseApprovalTimeout(name: string, raw: unknown): number {
  if (raw === undefined) return 0
  if (raw === 0 || raw === '0') return 0
  if (typeof raw !== 'string') {
    throw new Error(
      `agents.${name}.approval_timeout: must be a duration like "1h", "15m", "30s", or 0 to disable (got ${JSON.stringify(raw)})`,
    )
  }
  const m = /^(\d+)(s|m|h)$/.exec(raw)
  if (!m) {
    throw new Error(
      `agents.${name}.approval_timeout: "${raw}" is not a valid duration (use "<n>s", "<n>m", or "<n>h")`,
    )
  }
  const n = Number(m[1])
  switch (m[2]) {
    case 's':
      return n * 1000
    case 'm':
      return n * 60_000
    case 'h':
      return n * 60 * 60_000
  }
  throw new Error('unreachable')
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
  if (d.forward_env !== undefined) {
    if (!Array.isArray(d.forward_env)) {
      throw new Error(`agents.${name}.docker.forward_env must be an array of strings`)
    }
    const list: string[] = []
    for (const v of d.forward_env) {
      if (typeof v !== 'string' || v.length === 0) {
        throw new Error(
          `agents.${name}.docker.forward_env[] must be a non-empty string`,
        )
      }
      const parts = v.split(':')
      if (parts.length > 2) {
        throw new Error(
          `agents.${name}.docker.forward_env[] "${v}" is not a valid env spec (expected NAME or HOST:CONTAINER)`,
        )
      }
      if (parts.length === 2 && (parts[0]!.length === 0 || parts[1]!.length === 0)) {
        throw new Error(
          `agents.${name}.docker.forward_env[] has empty host or container name in "${v}"`,
        )
      }
      list.push(v)
    }
    out.forward_env = list
  }
  return out
}

function parseAgents(
  raw: unknown,
  runtime: 'local' | 'docker' | 'podman',
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
      throw new Error(`agents.${name}: name must match /^[a-z][a-z0-9-]{0,31}$/`)
    }
    if (!val || typeof val !== 'object' || Array.isArray(val)) {
      throw new Error(`agents.${name} must be a mapping`)
    }
    const entry = val as Record<string, unknown>
    if (typeof entry.workdir !== 'string' || entry.workdir.length === 0) {
      throw new Error(`agents.${name}.workdir is required`)
    }

    if (entry.adapter !== undefined) {
      throw new Error(
        `agents.${name}: "adapter" is no longer supported; use "acp" — see epics/003-ZOD025-acp-migration/SPEC.md`,
      )
    }

    if (entry.acp === undefined) {
      throw new Error(
        `agents.${name}: missing required "acp" block`,
      )
    }
    const acp = parseAcpBlock(name, entry.acp)
    const approval_timeout_ms = parseApprovalTimeout(name, entry.approval_timeout)

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

    let dockerBlock: AgentDockerConfig | undefined
    if (entry.docker !== undefined && entry.docker !== null) {
      if (runtime !== 'docker' && runtime !== 'podman') {
        throw new Error(
          `agents.${name}.docker is only valid when runtime: docker or runtime: podman (got runtime: ${runtime})`,
        )
      }
      dockerBlock = parseAgentDocker(name, entry.docker)
    }

    const agentCfg: AgentConfig = {
      name,
      workdir: entry.workdir,
      hooks: agentHooks,
      acp,
      approval_timeout_ms,
    }
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
      `transport must be "http" (got "${transport}"). Slack and Zooid transports are not in the MVP.`,
    )
  }

  const runtime = raw.runtime ?? 'docker'
  if (runtime !== 'local' && runtime !== 'docker' && runtime !== 'podman') {
    throw new Error(`runtime must be "local", "docker", or "podman" (got "${runtime}")`)
  }

  const port = raw.port ?? 8080
  if (!Number.isInteger(port)) {
    throw new Error(`port must be an integer (got ${JSON.stringify(port)})`)
  }

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

  if (runtime === 'docker' || runtime === 'podman') {
    const rawDocker = raw.docker && typeof raw.docker === 'object' ? raw.docker : {}
    const image =
      typeof rawDocker.image === 'string' && rawDocker.image.length > 0
        ? rawDocker.image
        : DEFAULT_DOCKER_IMAGE
    config.docker = { image }
  }

  return config
}

export function mergeCliFlags(base: BuddConfig, flags: CliFlags): BuddConfig {
  if (flags.transport !== undefined && flags.transport !== 'http') {
    throw new Error(
      `transport must be "http" (got "${flags.transport}").`,
    )
  }
  const runtimeFlag = flags.runtime as 'local' | 'docker' | 'podman' | undefined
  if (
    runtimeFlag !== undefined &&
    runtimeFlag !== 'local' &&
    runtimeFlag !== 'docker' &&
    runtimeFlag !== 'podman'
  ) {
    throw new Error(`runtime must be "local", "docker", or "podman" (got "${flags.runtime}")`)
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
  if (runtime === 'docker' || runtime === 'podman') {
    const baseDocker = base.docker ?? { image: DEFAULT_DOCKER_IMAGE }
    merged.docker = {
      image: flags.image ?? baseDocker.image ?? DEFAULT_DOCKER_IMAGE,
    }
  }
  return merged
}

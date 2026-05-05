import { parse } from 'yaml'
import type { AcpAgentSpec } from './acp-types.js'
import { isPreset } from '@zooid/acp-client'
import type {
  AgentConfig,
  AgentDockerConfig,
  MatrixDaemonConfig,
  ZooidConfig,
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

const MATRIX_USER_ID_RE = /^@[A-Za-z0-9._\-=/+]+:[A-Za-z0-9.\-]+$/

function parseMatrixBlock(raw: unknown): MatrixDaemonConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('matrix: must be a mapping')
  }
  const m = raw as Record<string, unknown>
  const fields: Array<keyof MatrixDaemonConfig> = [
    'homeserver',
    'as_token',
    'hs_token',
    'sender_localpart',
    'user_namespace',
  ]
  const out: Record<string, string> = {}
  for (const f of fields) {
    const v = m[f]
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(`matrix.${f} must be a non-empty string`)
    }
    out[f] = v
  }
  return out as unknown as MatrixDaemonConfig
}

function parseAgents(
  raw: unknown,
  runtime: 'local' | 'docker' | 'podman',
  transport: 'http' | 'matrix',
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

    const matrixOnly = ['matrix_user_id', 'rooms', 'trigger'] as const
    if (transport !== 'matrix') {
      for (const k of matrixOnly) {
        if (entry[k] !== undefined) {
          throw new Error(
            `agents.${name}.${k} is only valid when transport: matrix (got transport: ${transport})`,
          )
        }
      }
    }
    let matrixUserId: string | undefined
    let rooms: string[] | undefined
    let trigger: 'mention' | 'any' | undefined
    if (transport === 'matrix') {
      if (entry.matrix_user_id === undefined) {
        throw new Error(`agents.${name}.matrix_user_id is required when transport: matrix`)
      }
      if (typeof entry.matrix_user_id !== 'string' || !MATRIX_USER_ID_RE.test(entry.matrix_user_id)) {
        throw new Error(
          `agents.${name}.matrix_user_id must look like @localpart:server (got ${JSON.stringify(entry.matrix_user_id)})`,
        )
      }
      matrixUserId = entry.matrix_user_id
      if (entry.rooms === undefined || !Array.isArray(entry.rooms) || entry.rooms.length === 0) {
        throw new Error(
          `agents.${name}.rooms is required and must be a non-empty array when transport: matrix`,
        )
      }
      const ws: string[] = []
      for (const r of entry.rooms) {
        if (typeof r !== 'string' || r.length === 0) {
          throw new Error(`agents.${name}.rooms[] must be a non-empty string`)
        }
        ws.push(r)
      }
      rooms = ws
      const tr = entry.trigger ?? 'mention'
      if (tr !== 'mention' && tr !== 'any') {
        throw new Error(
          `agents.${name}.trigger must be "mention" or "any" (got ${JSON.stringify(tr)})`,
        )
      }
      trigger = tr as 'mention' | 'any'
    }

    const agentCfg: AgentConfig = {
      name,
      workdir: entry.workdir,
      hooks: agentHooks,
      acp,
      approval_timeout_ms,
    }
    if (dockerBlock) agentCfg.docker = dockerBlock
    if (matrixUserId) agentCfg.matrix_user_id = matrixUserId
    if (rooms) agentCfg.rooms = rooms
    if (trigger) agentCfg.trigger = trigger
    result[name] = agentCfg
  }
  return result
}

export function loadConfig(yamlText: string): ZooidConfig {
  const raw = parse(yamlText) ?? {}
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('daemon.yaml must be a YAML object')
  }

  const transport = raw.transport ?? 'http'
  if (transport !== 'http' && transport !== 'matrix') {
    throw new Error(
      `transport must be "http" or "matrix" (got "${transport}").`,
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

  const daemonHooks: ZooidConfig['hooks'] = {}
  if (raw.hooks && typeof raw.hooks === 'object') {
    if (typeof raw.hooks.pre_turn === 'string') daemonHooks.pre_turn = raw.hooks.pre_turn
    if (typeof raw.hooks.post_turn === 'string') daemonHooks.post_turn = raw.hooks.post_turn
  }

  const agents = parseAgents(raw.agents, runtime, transport, daemonHooks)

  const config: ZooidConfig = {
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

  if (transport === 'matrix') {
    if (raw.matrix === undefined) {
      throw new Error('matrix: block is required when transport: matrix')
    }
    config.matrix = parseMatrixBlock(raw.matrix)
  } else if (raw.matrix !== undefined) {
    throw new Error(
      `matrix: block is only valid when transport: matrix (got transport: ${transport})`,
    )
  }

  return config
}

export function mergeCliFlags(base: ZooidConfig, flags: CliFlags): ZooidConfig {
  if (
    flags.transport !== undefined &&
    flags.transport !== 'http' &&
    flags.transport !== 'matrix'
  ) {
    throw new Error(`transport must be "http" or "matrix" (got "${flags.transport}").`)
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
  const merged: ZooidConfig = {
    transport: base.transport,
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
  if (base.matrix) merged.matrix = base.matrix
  return merged
}

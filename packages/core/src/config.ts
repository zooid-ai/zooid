import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import type { AcpAgentSpec } from './acp-types.js'
import { isPreset } from '@zooid/acp-client'
import type {
  AgentConfig,
  AgentDockerConfig,
  CliFlags,
  HttpTransportConfig,
  MatrixTransportConfig,
  TransportConfig,
  WorkforceConfig,
} from './types.js'

export const DEFAULT_DOCKER_IMAGE = 'ghcr.io/zooid-ai/zooid-agent-base:latest'

const AGENT_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/
const MATRIX_USER_ID_RE = /^@[A-Za-z0-9._\-=/+]+:[A-Za-z0-9.\-]+$/

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
  const args: string[] = []
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

function parseTransports(raw: unknown): Record<string, TransportConfig> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('transports: must be a mapping with at least one entry')
  }
  const r = raw as Record<string, unknown>
  const names = Object.keys(r)
  if (names.length === 0) {
    throw new Error('transports: at least one transport must be declared')
  }
  const out: Record<string, TransportConfig> = {}
  for (const name of names) {
    out[name] = parseTransport(name, r[name])
  }
  return out
}

function parseTransport(name: string, raw: unknown): TransportConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`transports.${name}: must be a mapping`)
  }
  const r = raw as Record<string, unknown>
  if (r.type !== 'matrix' && r.type !== 'http') {
    throw new Error(
      `transports.${name}.type must be "matrix" or "http" (got ${JSON.stringify(r.type)})`,
    )
  }
  if (r.type === 'matrix') {
    const fields = [
      'homeserver',
      'as_token',
      'hs_token',
      'sender_localpart',
      'user_namespace',
    ] as const
    for (const f of fields) {
      if (typeof r[f] !== 'string' || (r[f] as string).length === 0) {
        throw new Error(`transports.${name}.${f} must be a non-empty string`)
      }
    }
    const out: MatrixTransportConfig = {
      type: 'matrix',
      homeserver: r.homeserver as string,
      as_token: r.as_token as string,
      hs_token: r.hs_token as string,
      sender_localpart: r.sender_localpart as string,
      user_namespace: r.user_namespace as string,
    }
    if (r.port !== undefined) {
      if (!Number.isInteger(r.port)) {
        throw new Error(
          `transports.${name}.port must be an integer (got ${JSON.stringify(r.port)})`,
        )
      }
      out.port = r.port as number
    }
    return out
  }
  // type: 'http'
  const port = (r.port ?? 8080) as number
  if (!Number.isInteger(port)) {
    throw new Error(`transports.${name}.port must be an integer (got ${JSON.stringify(port)})`)
  }
  return { type: 'http', port }
}

function parseAgents(
  raw: unknown,
  runtime: 'local' | 'docker' | 'podman',
  transports: Record<string, TransportConfig>,
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
      throw new Error(`agents.${name}: missing required "acp" block`)
    }
    const acp = parseAcpBlock(name, entry.acp)
    const approval_timeout_ms = parseApprovalTimeout(name, entry.approval_timeout)

    if (typeof entry.transport !== 'string' || entry.transport.length === 0) {
      throw new Error(`agents.${name}.transport is required (name of a transports entry)`)
    }
    const transportName = entry.transport
    const t = transports[transportName]
    if (!t) {
      throw new Error(
        `agents.${name}.transport "${transportName}" is not declared in transports`,
      )
    }
    const isMatrix = t.type === 'matrix'

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
    if (!isMatrix) {
      for (const k of matrixOnly) {
        if (entry[k] !== undefined) {
          throw new Error(
            `agents.${name}.${k} is only valid when transport is type: matrix (got type: ${t.type})`,
          )
        }
      }
    }
    let matrixUserId: string | undefined
    let rooms: string[] | undefined
    let trigger: 'mention' | 'any' | undefined
    if (isMatrix) {
      if (entry.matrix_user_id === undefined) {
        throw new Error(
          `agents.${name}.matrix_user_id is required when referencing a matrix transport`,
        )
      }
      if (
        typeof entry.matrix_user_id !== 'string' ||
        !MATRIX_USER_ID_RE.test(entry.matrix_user_id)
      ) {
        throw new Error(
          `agents.${name}.matrix_user_id must look like @localpart:server (got ${JSON.stringify(entry.matrix_user_id)})`,
        )
      }
      matrixUserId = entry.matrix_user_id
      if (entry.rooms === undefined || !Array.isArray(entry.rooms) || entry.rooms.length === 0) {
        throw new Error(
          `agents.${name}.rooms is required and must be a non-empty array when referencing a matrix transport`,
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
      transport: transportName,
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

function parseRuntime(raw: unknown): 'local' | 'docker' | 'podman' {
  const runtime = raw ?? 'docker'
  if (runtime !== 'local' && runtime !== 'docker' && runtime !== 'podman') {
    throw new Error(`runtime must be "local", "docker", or "podman" (got "${runtime}")`)
  }
  return runtime
}

function parseDocker(raw: unknown): { image: string } {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const image =
    typeof r.image === 'string' && r.image.length > 0 ? r.image : DEFAULT_DOCKER_IMAGE
  return { image }
}

function workforceHooks(raw: Record<string, unknown>): { pre_turn?: string; post_turn?: string } {
  const out: { pre_turn?: string; post_turn?: string } = {}
  if (raw.hooks && typeof raw.hooks === 'object') {
    const h = raw.hooks as Record<string, unknown>
    if (typeof h.pre_turn === 'string') out.pre_turn = h.pre_turn
    if (typeof h.post_turn === 'string') out.post_turn = h.post_turn
  }
  return out
}

export function loadWorkforceConfig(yamlText: string): WorkforceConfig {
  const raw = parse(yamlText) ?? {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('workforce.yaml must be a YAML object')
  }
  const r = raw as Record<string, unknown>

  if (r.transport !== undefined) {
    throw new Error(
      'workforce.yaml: top-level "transport:" is no longer supported; declare entries under "transports:" instead',
    )
  }
  if (r.matrix !== undefined) {
    throw new Error(
      'workforce.yaml: top-level "matrix:" is no longer supported; move it under "transports.<name>: { type: matrix, ... }"',
    )
  }
  if (r.workdir !== undefined) {
    throw new Error(
      'top-level workdir is not supported; define agents: { <name>: { workdir: ... } } instead',
    )
  }
  if (r.agents === undefined) {
    throw new Error('agents: is required — workforce.yaml must define at least one agent')
  }

  const runtime = parseRuntime(r.runtime)
  const transports = parseTransports(r.transports)
  const hooks = workforceHooks(r)
  const agents = parseAgents(r.agents, runtime, transports, hooks)

  const cfg: WorkforceConfig = {
    runtime,
    transports,
    agents,
    hooks,
  }
  if (runtime === 'docker' || runtime === 'podman') {
    cfg.docker = parseDocker(r.docker)
  }
  return cfg
}

export function findTransport(
  cfg: WorkforceConfig,
  name: string,
): TransportConfig | undefined {
  return cfg.transports[name]
}

export function findMatrixTransport(
  cfg: WorkforceConfig,
): { name: string; transport: MatrixTransportConfig } | null {
  const matrices = Object.entries(cfg.transports).filter(
    (e): e is [string, MatrixTransportConfig] => e[1].type === 'matrix',
  )
  if (matrices.length === 0) return null
  if (matrices.length > 1) {
    throw new Error(
      `findMatrixTransport: multiple matrix transports declared (${matrices
        .map((m) => m[0])
        .join(', ')}). Per-agent matrix routing is not supported yet.`,
    )
  }
  const [name, transport] = matrices[0]!
  return { name, transport }
}

export function findHttpTransport(
  cfg: WorkforceConfig,
): { name: string; transport: HttpTransportConfig } | null {
  const https = Object.entries(cfg.transports).filter(
    (e): e is [string, HttpTransportConfig] => e[1].type === 'http',
  )
  if (https.length === 0) return null
  if (https.length > 1) {
    throw new Error(
      `findHttpTransport: multiple http transports declared (${https
        .map((h) => h[0])
        .join(', ')}). Per-agent http routing is not supported yet.`,
    )
  }
  const [name, transport] = https[0]!
  return { name, transport }
}

export interface FoundConfigFile {
  path: string
}

export function findConfigFile(cwd: string): FoundConfigFile | null {
  const w = join(cwd, 'workforce.yaml')
  if (existsSync(w)) return { path: w }
  return null
}

export function mergeCliFlags(base: WorkforceConfig, flags: CliFlags): WorkforceConfig {
  const runtimeFlag = flags.runtime as 'local' | 'docker' | 'podman' | undefined
  if (
    runtimeFlag !== undefined &&
    runtimeFlag !== 'local' &&
    runtimeFlag !== 'docker' &&
    runtimeFlag !== 'podman'
  ) {
    throw new Error(`runtime must be "local", "docker", or "podman" (got "${flags.runtime}")`)
  }
  const runtime = runtimeFlag ?? base.runtime
  const merged: WorkforceConfig = {
    runtime,
    transports: base.transports,
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

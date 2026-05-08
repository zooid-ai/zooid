import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import type { AcpAgentSpec } from './acp-types.js'
import { isPreset } from '@zooid/acp-client'
import { interpolateEnv, interpolateString } from './env-interpolation.js'
import type {
  AgentConfig,
  CliFlags,
  ContainerConfig,
  HttpBinding,
  HttpTransportConfig,
  MatrixBinding,
  MatrixTransportConfig,
  TransportConfig,
  ZooidConfig,
  ZooidContainerConfig,
} from './types.js'

const AGENT_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/
const MATRIX_USER_ID_RE = /^@[A-Za-z0-9._\-=/+]+:[A-Za-z0-9.\-]+$/

const TRANSPORT_KINDS = ['matrix', 'http'] as const
type TransportKind = (typeof TRANSPORT_KINDS)[number]

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

function parseAgentContainer(
  name: string,
  raw: unknown,
  processEnv: NodeJS.ProcessEnv,
): ContainerConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`agents.${name}.container must be a mapping`)
  }
  const r = raw as Record<string, unknown>
  const out: ContainerConfig = {}
  if (r.image !== undefined) {
    if (typeof r.image !== 'string' || r.image.length === 0) {
      throw new Error(`agents.${name}.container.image must be a non-empty string`)
    }
    out.image = r.image
  }
  if (r.env !== undefined && r.env !== null) {
    if (typeof r.env !== 'object' || Array.isArray(r.env)) {
      throw new Error(`agents.${name}.container.env must be a mapping`)
    }
    const rawEnv = r.env as Record<string, unknown>
    const stringEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(rawEnv)) {
      if (typeof v !== 'string') {
        throw new Error(
          `agents.${name}.container.env.${k}: must be a string (got ${typeof v})`,
        )
      }
      stringEnv[k] = v
    }
    out.env = interpolateEnv(stringEnv, processEnv, `agents.${name}.container.env`)
  }
  return out
}

function parseZooidContainer(raw: unknown): ZooidContainerConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('container must be a mapping')
  }
  const r = raw as Record<string, unknown>
  const out: ZooidContainerConfig = {}
  if (r.env !== undefined) {
    throw new Error(
      "Top-level 'container.env' is not supported (workforce-level env defaults are out of scope; see [ZOD043]). " +
        'Move env entries to per-agent container.env.',
    )
  }
  if (r.image !== undefined) {
    if (typeof r.image !== 'string' || r.image.length === 0) {
      throw new Error('container.image must be a non-empty string')
    }
    out.image = r.image
  }
  return out
}

function parseTransports(
  raw: unknown,
  processEnv: NodeJS.ProcessEnv,
): Record<string, TransportConfig> {
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
    out[name] = parseTransport(name, r[name], processEnv)
  }
  return out
}

function parseTransport(
  name: string,
  raw: unknown,
  processEnv: NodeJS.ProcessEnv,
): TransportConfig {
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
      homeserver: interpolateString(r.homeserver as string, processEnv),
      as_token: interpolateString(r.as_token as string, processEnv),
      hs_token: interpolateString(r.hs_token as string, processEnv),
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

function parseTransportBinding(
  name: string,
  entry: Record<string, unknown>,
  transports: Record<string, TransportConfig>,
): { matrix?: MatrixBinding; http?: HttpBinding } {
  const present = TRANSPORT_KINDS.filter(
    (k) => entry[k] !== undefined && entry[k] !== null,
  )
  if (present.length === 0) {
    throw new Error(
      `agents.${name}: must declare exactly one transport-kind block ` +
        `(e.g. 'matrix:' or 'http:'). Saw none.`,
    )
  }
  if (present.length > 1) {
    throw new Error(
      `agents.${name}: must declare exactly one transport-kind block. ` +
        `Saw: ${present.join(', ')}. To run "the same agent" on two transports, ` +
        `declare two agents (e.g. ${name}-matrix and ${name}-http).`,
    )
  }
  const kind = present[0] as TransportKind
  const blockRaw = entry[kind]
  if (typeof blockRaw !== 'object' || blockRaw === null || Array.isArray(blockRaw)) {
    throw new Error(`agents.${name}.${kind}: must be a mapping`)
  }
  const block = blockRaw as Record<string, unknown>
  if (typeof block.transport !== 'string' || block.transport.length === 0) {
    throw new Error(`agents.${name}.${kind}.transport (string) is required`)
  }
  const refName = block.transport
  const refTransport = transports[refName]
  if (!refTransport) {
    throw new Error(
      `agents.${name}.${kind}.transport "${refName}" is not declared in transports`,
    )
  }
  if (refTransport.type !== kind) {
    throw new Error(
      `agents.${name}.${kind} references transport "${refName}" of type: ${refTransport.type}. ` +
        `Block name and referenced transport's type must match.`,
    )
  }

  if (kind === 'matrix') {
    if (typeof block.user_id !== 'string' || !MATRIX_USER_ID_RE.test(block.user_id)) {
      throw new Error(
        `agents.${name}.matrix.user_id must look like @localpart:server (got ${JSON.stringify(block.user_id)})`,
      )
    }
    if (!Array.isArray(block.rooms) || block.rooms.length === 0) {
      throw new Error(`agents.${name}.matrix.rooms is required and must be a non-empty array`)
    }
    const rooms: string[] = []
    for (const r of block.rooms) {
      if (typeof r !== 'string' || r.length === 0) {
        throw new Error(`agents.${name}.matrix.rooms[] must be a non-empty string`)
      }
      rooms.push(r)
    }
    const tr = block.trigger ?? 'mention'
    if (tr !== 'mention' && tr !== 'any') {
      throw new Error(
        `agents.${name}.matrix.trigger must be "mention" or "any" (got ${JSON.stringify(tr)})`,
      )
    }
    return {
      matrix: {
        transport: refName,
        user_id: block.user_id,
        rooms,
        trigger: tr,
      },
    }
  }
  // kind === 'http'
  return { http: { transport: refName } }
}

function parseAgents(
  raw: unknown,
  runtime: 'local' | 'docker' | 'podman',
  transports: Record<string, TransportConfig>,
  daemonHooks: { pre_turn?: string; post_turn?: string },
  processEnv: NodeJS.ProcessEnv,
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

    // Reject legacy fields up front with pointers to [ZOD043].
    if (entry.docker !== undefined) {
      throw new Error(
        `agents.${name}.docker is no longer supported. ` +
          `Move 'image' to agents.${name}.container.image, and 'forward_env' entries to ` +
          `agents.${name}.container.env with \${VAR} interpolation. See [ZOD043].`,
      )
    }
    if (typeof entry.transport === 'string') {
      throw new Error(
        `agents.${name}.transport (string) is no longer supported at the agent level. ` +
          `Move it inside a transport-kind block, e.g.:\n` +
          `  matrix:\n    transport: <name>\n    user_id: "@..."\n    rooms: [...]\n` +
          `See [ZOD043].`,
      )
    }
    for (const k of ['matrix_user_id', 'rooms', 'trigger'] as const) {
      if (entry[k] !== undefined) {
        throw new Error(
          `agents.${name}.${k} is no longer supported as a flat field. ` +
            `Move it inside a 'matrix:' block on the agent. See [ZOD043].`,
        )
      }
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

    let containerBlock: ContainerConfig | undefined
    if (entry.container !== undefined && entry.container !== null) {
      if (runtime === 'local') {
        throw new Error(
          `agents.${name}.container is only valid when runtime is 'docker' or 'podman'. ` +
            `runtime: local spawns agents as host child processes — there is no container, ` +
            `so 'image' is inert and 'env' would silently lie (the agent inherits the daemon's ` +
            `full process.env regardless).`,
        )
      }
      containerBlock = parseAgentContainer(name, entry.container, processEnv)
    }

    const binding = parseTransportBinding(name, entry, transports)

    const agentCfg: AgentConfig = {
      name,
      workdir: entry.workdir,
      hooks: agentHooks,
      acp,
      approval_timeout_ms,
    }
    if (containerBlock) agentCfg.container = containerBlock
    if (binding.matrix) agentCfg.matrix = binding.matrix
    if (binding.http) agentCfg.http = binding.http
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

function zooidHooks(raw: Record<string, unknown>): { pre_turn?: string; post_turn?: string } {
  const out: { pre_turn?: string; post_turn?: string } = {}
  if (raw.hooks && typeof raw.hooks === 'object') {
    const h = raw.hooks as Record<string, unknown>
    if (typeof h.pre_turn === 'string') out.pre_turn = h.pre_turn
    if (typeof h.post_turn === 'string') out.post_turn = h.post_turn
  }
  return out
}

export function loadZooidConfig(yamlText: string): ZooidConfig {
  const raw = parse(yamlText) ?? {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('zooid.yaml must be a YAML object')
  }
  const r = raw as Record<string, unknown>

  if (r.transport !== undefined) {
    throw new Error(
      'zooid.yaml: top-level "transport:" is no longer supported; declare entries under "transports:" instead',
    )
  }
  if (r.matrix !== undefined) {
    throw new Error(
      'zooid.yaml: top-level "matrix:" is no longer supported; move it under "transports.<name>: { type: matrix, ... }"',
    )
  }
  if (r.workdir !== undefined) {
    throw new Error(
      'top-level workdir is not supported; define agents: { <name>: { workdir: ... } } instead',
    )
  }
  if (r.docker !== undefined) {
    throw new Error(
      "Top-level 'docker' block is no longer supported. " +
        "Move 'image' to top-level 'container.image'. See [ZOD043].",
    )
  }
  if (r.agents === undefined) {
    throw new Error('agents: is required — zooid.yaml must define at least one agent')
  }

  const runtime = parseRuntime(r.runtime)
  const processEnv = process.env
  const transports = parseTransports(r.transports, processEnv)
  const hooks = zooidHooks(r)
  const agents = parseAgents(r.agents, runtime, transports, hooks, processEnv)

  const cfg: ZooidConfig = {
    runtime,
    transports,
    agents,
    hooks,
  }
  if (r.container !== undefined && r.container !== null) {
    if (runtime === 'local') {
      throw new Error(
        "container is only valid when runtime is 'docker' or 'podman'. " +
          'runtime: local does not run agents in containers; image is ignored. See [ZOD043].',
      )
    }
    cfg.container = parseZooidContainer(r.container)
  }
  return cfg
}

export function findTransport(
  cfg: ZooidConfig,
  name: string,
): TransportConfig | undefined {
  return cfg.transports[name]
}

export function findMatrixTransport(
  cfg: ZooidConfig,
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
  cfg: ZooidConfig,
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
  const z = join(cwd, 'zooid.yaml')
  if (existsSync(z)) return { path: z }
  const legacy = join(cwd, 'workforce.yaml')
  if (existsSync(legacy)) {
    throw new Error(
      `workforce.yaml is no longer supported. Rename it to zooid.yaml. See [ZOD045].`,
    )
  }
  return null
}

export function mergeCliFlags(base: ZooidConfig, flags: CliFlags): ZooidConfig {
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
  const merged: ZooidConfig = {
    runtime,
    transports: base.transports,
    agents: base.agents,
    hooks: { ...base.hooks },
  }
  if (runtime === 'docker' || runtime === 'podman') {
    const image = flags.image ?? base.container?.image
    if (image !== undefined) {
      merged.container = { image }
    } else if (base.container !== undefined) {
      merged.container = { ...base.container }
    }
  }
  return merged
}

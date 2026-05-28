import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve as pathResolve } from 'node:path'
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
  MountConfig,
  RoomBinding,
  TransportConfig,
  ZooidConfig,
  ZooidContainerConfig,
} from './types.js'

export interface LoadZooidConfigOptions {
  /**
   * Directory containing zooid.yaml. Required when any agent uses a
   * relative `container.mounts[].host` path; resolution happens at parse
   * time so the resulting `MountConfig` always carries an absolute host
   * path.
   */
  configDir?: string
}

const AGENT_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/
const MATRIX_USER_ID_RE = /^@[A-Za-z0-9._\-=/+]+:[A-Za-z0-9.\-]+$/
const MATRIX_USER_LOCALPART_RE = /^@[a-z0-9._=/+\-]+$/
const MATRIX_ROOM_IDENT_RE = /^[#!]/

function deriveServerName(userNamespace: string): string {
  // user_namespace is a regex like `@.*:localhost`. The part after the first
  // `:` is the server_name (strip a trailing `)` left over from a wrapped
  // group like `@(.*):localhost)`).
  const tail = userNamespace.split(':').slice(1).join(':').replace(/\\?\)?$/, '')
  if (!tail) throw new Error(`user_namespace missing server_name: ${userNamespace}`)
  return tail
}

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
    const out: { preset: string; model?: string } = { preset: a.preset }
    if (a.model !== undefined) {
      if (typeof a.model !== 'string' || a.model.trim().length === 0) {
        throw new Error(`agents.${name}.acp.model: must be a non-empty string`)
      }
      out.model = a.model.trim()
    }
    return out as AcpAgentSpec
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
  configDir: string | undefined,
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
  if (r.mounts !== undefined) {
    out.mounts = parseMountList(name, r.mounts, processEnv, configDir)
  }
  if (r.disable_mounts !== undefined) {
    out.disable_mounts = parseDisableMounts(name, r.disable_mounts)
  }
  return out
}

function parseMountList(
  agentName: string,
  raw: unknown,
  processEnv: NodeJS.ProcessEnv,
  configDir: string | undefined,
): MountConfig[] {
  if (!Array.isArray(raw)) {
    throw new Error(`agents.${agentName}.container.mounts must be an array`)
  }
  const out: MountConfig[] = []
  const seenIds = new Set<string>()
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i]
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`agents.${agentName}.container.mounts[${i}] must be a mapping`)
    }
    const e = entry as Record<string, unknown>
    if (e.host === undefined) {
      throw new Error(`agents.${agentName}.container.mounts[${i}].host is required`)
    }
    if (e.target === undefined) {
      throw new Error(`agents.${agentName}.container.mounts[${i}].target is required`)
    }
    if (typeof e.host !== 'string' || e.host.length === 0) {
      throw new Error(
        `agents.${agentName}.container.mounts[${i}].host must be a non-empty string`,
      )
    }
    if (typeof e.target !== 'string' || e.target.length === 0) {
      throw new Error(
        `agents.${agentName}.container.mounts[${i}].target must be a non-empty string`,
      )
    }
    const mode = e.mode ?? 'rw'
    if (mode !== 'ro' && mode !== 'rw') {
      throw new Error(
        `agents.${agentName}.container.mounts[${i}].mode must be "ro" or "rw" (got ${JSON.stringify(e.mode)})`,
      )
    }
    let id: string | undefined
    if (e.id !== undefined) {
      if (typeof e.id !== 'string' || e.id.length === 0) {
        throw new Error(
          `agents.${agentName}.container.mounts[${i}].id must be a non-empty string`,
        )
      }
      if (e.id === 'workspace') {
        throw new Error(
          `agents.${agentName}.container.mounts[${i}].id: "workspace" is a reserved id (set by the workspace auto-mount). Use a different id or rely on disable_mounts to subtract.`,
        )
      }
      if (seenIds.has(e.id)) {
        throw new Error(
          `agents.${agentName}.container.mounts: duplicate id "${e.id}"`,
        )
      }
      seenIds.add(e.id)
      id = e.id
    }
    let create: boolean | undefined
    if (e.create !== undefined) {
      if (typeof e.create !== 'boolean') {
        throw new Error(
          `agents.${agentName}.container.mounts[${i}].create must be a boolean`,
        )
      }
      create = e.create
    }
    const host = resolveHostPath(
      agentName,
      i,
      interpolateString(e.host, processEnv),
      configDir,
    )
    const target = interpolateString(e.target, processEnv)
    const m: MountConfig = { host, target, mode }
    if (id !== undefined) m.id = id
    if (create !== undefined) m.create = create
    out.push(m)
  }
  return out
}

function resolveHostPath(
  agentName: string,
  index: number,
  host: string,
  configDir: string | undefined,
): string {
  if (host.startsWith('~/')) {
    const home = process.env.HOME
    if (!home) {
      throw new Error(
        `agents.${agentName}.container.mounts[${index}].host: cannot expand ~ — $HOME is not set`,
      )
    }
    return `${home}/${host.slice(2)}`
  }
  if (host === '~') {
    const home = process.env.HOME
    if (!home) {
      throw new Error(
        `agents.${agentName}.container.mounts[${index}].host: cannot expand ~ — $HOME is not set`,
      )
    }
    return home
  }
  if (isAbsolute(host)) return host
  if (!configDir) {
    throw new Error(
      `agents.${agentName}.container.mounts[${index}]: relative host path "${host}" requires configDir (zooid.yaml directory) — pass it via loadZooidConfig(yaml, { configDir })`,
    )
  }
  return pathResolve(configDir, host)
}

function parseDisableMounts(agentName: string, raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new Error(`agents.${agentName}.container.disable_mounts must be an array of strings`)
  }
  const out: string[] = []
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i]
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(
        `agents.${agentName}.container.disable_mounts[${i}] must be a non-empty string`,
      )
    }
    out.push(v)
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
  const matrixEntries = Object.entries(out).filter(
    (e): e is [string, MatrixTransportConfig] => e[1].type === 'matrix',
  )
  if (matrixEntries.length === 1) {
    const [, mt] = matrixEntries[0]!
    if (mt.as_token === '__INFER__') {
      const v = interpolateString('${MATRIX_AS_TOKEN}', processEnv)
      if (v.length === 0) {
        throw new Error(
          'transports.matrix.as_token: env var MATRIX_AS_TOKEN is not set ' +
            '(set it in your shell or .env, or declare as_token explicitly in zooid.yaml)',
        )
      }
      mt.as_token = v
    }
    if (mt.hs_token === '__INFER__') {
      const v = interpolateString('${MATRIX_HS_TOKEN}', processEnv)
      if (v.length === 0) {
        throw new Error(
          'transports.matrix.hs_token: env var MATRIX_HS_TOKEN is not set ' +
            '(set it in your shell or .env, or declare hs_token explicitly in zooid.yaml)',
        )
      }
      mt.hs_token = v
    }
  } else if (matrixEntries.length > 1) {
    for (const [tname, mt] of matrixEntries) {
      if (mt.as_token === '__INFER__' || mt.hs_token === '__INFER__') {
        throw new Error(
          `transports.${tname}: as_token / hs_token must be set explicitly when more than one matrix transport is declared ` +
            `(no sensible default env var across multiple transports)`,
        )
      }
    }
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
  const inferredType =
    r.type ?? (name === 'matrix' || name === 'http' ? name : undefined)
  if (inferredType !== 'matrix' && inferredType !== 'http') {
    throw new Error(
      `transports.${name}.type must be "matrix" or "http" (got ${JSON.stringify(r.type)})`,
    )
  }
  if (inferredType === 'matrix') {
    if (r.sender_localpart === undefined) r.sender_localpart = 'zooid'
    if (r.user_namespace === undefined && typeof r.homeserver === 'string') {
      try {
        const host = new URL(
          interpolateString(r.homeserver as string, processEnv),
        ).hostname
        if (host) r.user_namespace = `@.*:${host}`
      } catch {
        // Fall through: the required-fields loop will fire its "must be a
        // non-empty string" error, which is the same message today's parser
        // would emit for a bad homeserver URL.
      }
    }
    if (r.as_token === undefined) r.as_token = '__INFER__'
    if (r.hs_token === undefined) r.hs_token = '__INFER__'
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
    if (r.space !== undefined) {
      if (typeof r.space !== 'string' || r.space.length === 0) {
        throw new Error(
          `transports.${name}.space must be a non-empty string (got ${JSON.stringify(r.space)})`,
        )
      }
      out.space = r.space
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

function parseRoomBinding(path: string, raw: unknown, serverName: string): RoomBinding {
  function normalizeAlias(alias: string): string {
    if (alias.length === 0) {
      throw new Error(`${path}: must be a non-empty alias`)
    }
    if (!MATRIX_ROOM_IDENT_RE.test(alias)) {
      throw new Error(
        `${path}: must start with '#' or '!' (got ${JSON.stringify(alias)})`,
      )
    }
    return alias.includes(':') ? alias : `${alias}:${serverName}`
  }
  if (typeof raw === 'string') {
    return { alias: normalizeAlias(raw) }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${path}: must be a string or { alias, power_level } object`)
  }
  const r = raw as Record<string, unknown>
  if (typeof r.alias !== 'string' || r.alias.length === 0) {
    throw new Error(`${path}.alias: must be a non-empty string`)
  }
  const out: RoomBinding = { alias: normalizeAlias(r.alias) }
  if (r.power_level !== undefined) {
    if (typeof r.power_level !== 'number' || !Number.isInteger(r.power_level)) {
      throw new Error(
        `${path}.power_level: must be an integer (got ${JSON.stringify(r.power_level)})`,
      )
    }
    out.powerLevel = r.power_level
  }
  return out
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
  let refName: string
  if (typeof block.transport === 'string' && block.transport.length > 0) {
    refName = block.transport
  } else {
    const matches = Object.entries(transports).filter(
      ([, t]) => t.type === kind,
    )
    if (matches.length === 0) {
      throw new Error(
        `agents.${name}.${kind}: no transport of type ${kind} declared (add one under transports:)`,
      )
    }
    if (matches.length > 1) {
      throw new Error(
        `agents.${name}.${kind}.transport is required when more than one ${kind} transport is declared ` +
          `(saw: ${matches.map(([n]) => n).join(', ')})`,
      )
    }
    refName = matches[0]![0]
  }
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
    if (refTransport.type !== 'matrix') {
      throw new Error(`agents.${name}.matrix: transport must be matrix`)
    }
    const serverName = deriveServerName(refTransport.user_namespace)

    const rawUserId =
      typeof block.user_id === 'string' && block.user_id.length > 0
        ? block.user_id
        : `@${name}`
    let userId = rawUserId
    if (!userId.includes(':') && MATRIX_USER_LOCALPART_RE.test(userId)) {
      userId = `${userId}:${serverName}`
    }
    if (!MATRIX_USER_ID_RE.test(userId)) {
      throw new Error(
        `agents.${name}.matrix.user_id must look like @localpart:server (got ${JSON.stringify(block.user_id)})`,
      )
    }

    if (!Array.isArray(block.rooms) || block.rooms.length === 0) {
      throw new Error(`agents.${name}.matrix.rooms is required and must be a non-empty array`)
    }
    const rooms: RoomBinding[] = []
    for (let i = 0; i < block.rooms.length; i++) {
      rooms.push(parseRoomBinding(`agents.${name}.matrix.rooms[${i}]`, block.rooms[i], serverName))
    }

    let displayName: string | undefined
    if (block.display_name !== undefined) {
      if (typeof block.display_name !== 'string') {
        throw new Error(
          `agents.${name}.matrix.display_name must be a string (got ${JSON.stringify(block.display_name)})`,
        )
      }
      const trimmed = block.display_name.trim()
      if (trimmed.length === 0) {
        throw new Error(`agents.${name}.matrix.display_name must be non-empty after trim`)
      }
      if (trimmed.length > 256) {
        throw new Error(`agents.${name}.matrix.display_name must be 256 characters or fewer`)
      }
      displayName = trimmed
    }

    const tr = block.trigger ?? 'mention'
    if (tr !== 'mention' && tr !== 'any') {
      throw new Error(
        `agents.${name}.matrix.trigger must be "mention" or "any" (got ${JSON.stringify(tr)})`,
      )
    }
    const matrix: MatrixBinding = {
      transport: refName,
      user_id: userId,
      rooms,
      trigger: tr,
    }
    if (displayName !== undefined) matrix.display_name = displayName
    return { matrix }
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
  configDir: string | undefined,
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
    let workdir: string
    if (entry.workdir === undefined) {
      workdir = `./agents/${name}`
    } else if (typeof entry.workdir !== 'string' || entry.workdir.length === 0) {
      throw new Error(`agents.${name}.workdir must be a non-empty string`)
    } else {
      workdir = entry.workdir
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
        // Under runtime: local, the parser only accepts mounts/disable_mounts
        // (which the compose layer ignores). image/env stay rejected because
        // they would silently lie: there's no container and the host inherits
        // the daemon's full process.env regardless.
        if (typeof entry.container !== 'object' || entry.container === null || Array.isArray(entry.container)) {
          throw new Error(`agents.${name}.container must be a mapping`)
        }
        const c = entry.container as Record<string, unknown>
        const disallowed = Object.keys(c).filter((k) => k !== 'mounts' && k !== 'disable_mounts')
        if (disallowed.length > 0) {
          throw new Error(
            `agents.${name}.container.${disallowed[0]} is only valid when runtime is 'docker' or 'podman'. ` +
              `runtime: local spawns agents as host child processes — there is no container, ` +
              `so 'image' is inert and 'env' would silently lie (the agent inherits the daemon's ` +
              `full process.env regardless). 'mounts' and 'disable_mounts' are accepted under ` +
              `runtime: local but ignored at compose time.`,
          )
        }
      }
      containerBlock = parseAgentContainer(name, entry.container, processEnv, configDir)
    }

    const binding = parseTransportBinding(name, entry, transports)

    const agentCfg: AgentConfig = {
      name,
      workdir,
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

export function loadZooidConfig(
  yamlText: string,
  opts: LoadZooidConfigOptions = {},
): ZooidConfig {
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
  const agents = parseAgents(r.agents, runtime, transports, hooks, processEnv, opts.configDir)

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

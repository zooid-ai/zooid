import type { AcpAgentSpec } from './acp-types.js'

/**
 * One classified line of agent stdout. Currently unused (legacy adapter
 * machinery is gone); kept for forward compatibility with future on-disk
 * stream parsing.
 */

/**
 * A Transport handles inbound messages and outbound replies. Implemented in
 * future epics (HTTP, Slack, Zooid). Declared here so the core knows the
 * shape downstream packages will plug in to.
 */
export interface InboundMessage {
  id: string
  text: string
  sender: string
  thread: ThreadRef
  isFollowUp: boolean
}

export interface ThreadRef {
  channelId: string
  threadId: string
}

export interface Transport {
  listen(channel: string, onMessage: (msg: InboundMessage) => void): void
  reply(thread: ThreadRef, message: string): Promise<void> | void
}

/**
 * One bind mount. `id` is the handle used by `disable_mounts` to subtract
 * a zooid- or preset-declared entry; user-declared entries that omit `id`
 * are auto-assigned `user-N`. The reserved id `workspace` is rejected on
 * user entries.
 */
export interface MountConfig {
  id?: string
  host: string
  target: string
  mode: 'ro' | 'rw'
  /** mkdir -p the host path before bind-mounting. Default false. */
  create?: boolean
}

/**
 * Per-agent container configuration. Holds runtime-neutral container
 * concerns — image, env, mounts. `image` / `env` are rejected at parse time
 * when `runtime: local`; `mounts` / `disable_mounts` are accepted under
 * `runtime: local` but ignored at compose time.
 */
export interface ContainerConfig {
  image?: string
  /**
   * Env vars passed to the spawned agent container. Values support
   * compose-style `${VAR}` / `${VAR:-default}` / `${VAR-default}`
   * interpolation, resolved at parse time against the daemon's `process.env`.
   * `ZOOID_*` references and `ZOOID_*` keys are rejected.
   */
  env?: Record<string, string>
  /** User-declared mounts, layered on top of workspace + preset. */
  mounts?: MountConfig[]
  /**
   * Subtractive override by mount id. Built-in ids: `workspace` plus
   * whatever each preset declares (canonical: `memory`, `history`, `config`).
   */
  disable_mounts?: string[]
}

/**
 * Workforce-level container defaults. Currently `image` only — workforce-level
 * env is intentionally unsupported (set env per-agent under `container.env`).
 */
export interface ZooidContainerConfig {
  image?: string
}

/**
 * A room binding for an agent. Either a bare alias (default PL) or
 * an alias with a declared power level applied at room creation.
 *
 * `alias` may be an alias (`#room:server`) or a room ID (`!id:server`).
 * Resolved to a canonical room ID by `bot-pool` at bootstrap. The
 * declared `powerLevel` (when set) seeds the agent's entry in
 * `m.room.power_levels.users` at room creation; the daemon never reads
 * or modifies power levels after that — promote/demote in the UI is
 * canonical.
 */
export interface RoomBinding {
  /** Room alias (typical) or room ID. */
  alias: string
  /**
   * Power level the agent should hold in this room at the moment it is
   * created. Omitted = `users_default` (effectively 0). Not reconciled
   * after creation.
   */
  powerLevel?: number
}

/**
 * Matrix transport binding. Lives under `agents.<name>.matrix:` in
 * zooid.yaml. The block name (`matrix`) is the transport-kind
 * discriminator: `transports[transport].type` must equal `"matrix"`.
 */
export interface MatrixBinding {
  /**
   * Ref into `ZooidConfig.transports`. Resolved transport must have type: 'matrix'.
   * @default if exactly one matrix transport is declared, that transport's key
   */
  transport: string
  /**
   * Full Matrix user ID for this agent's bot, e.g. `@architect:example.com`.
   * @default `@<agent name>:<server>` — server is derived from the resolved
   *          transport's `user_namespace`
   */
  user_id: string
  /**
   * Optional human-readable display name. Written to the agent's Matrix
   * profile on bootstrap. Falls back to the user_id localpart when absent.
   */
  display_name?: string
  /** Rooms this agent watches. Each entry carries the alias/ID and an optional declared PL. */
  rooms: RoomBinding[]
  /**
   * Routing rule. `mention` requires the bot to be tagged; `any` triggers
   * on every message.
   * @default 'mention'
   */
  trigger: 'mention' | 'any'
}

/**
 * HTTP transport binding. Lives under `agents.<name>.http:` in
 * zooid.yaml. Reserved for future HTTP-specific binding fields.
 */
export interface HttpBinding {
  /** Ref into `ZooidConfig.transports`. Resolved transport must have type: 'http'. */
  transport: string
}

/**
 * Per-agent config inside a multi-agent zooid.yaml. Each agent has its
 * own workspace, hooks, an ACP block describing the shim to spawn, and
 * exactly one transport-kind block (`matrix` or `http`).
 */
export interface AgentConfig {
  /**
   * Routing name. Always the agent's key in `ZooidConfig.agents` — cannot
   * be overridden, and a `name:` field under an agent is silently ignored.
   * The key must match /^[a-z][a-z0-9-]{0,31}$/.
   */
  name: string
  /**
   * Host directory for the agent's workspace.
   * @default `./agents/<name>`
   */
  workdir: string
  /** Per-agent hooks. Workforce-wide hooks are merged in at load time. */
  hooks: {
    pre_turn?: string
    post_turn?: string
  }
  /** Required: how to launch this agent's ACP shim. */
  acp: AcpAgentSpec
  /**
   * Wall-clock timeout for pending permission requests, in milliseconds.
   * 0 = no timeout. The paused agent's idle cost is negligible, so opt-in
   * is the right shape — set this only if you're running in a
   * scale-to-zero / serverless context where unbounded waits would hold
   * resources.
   * @default 0
   */
  approval_timeout_ms: number
  /** Container config. Rejected at parse time when runtime: local. */
  container?: ContainerConfig
  /** Exactly one of matrix / http is set per agent. */
  matrix?: MatrixBinding
  http?: HttpBinding
}

/**
 * Matrix application-service transport. The CLI binds the AS HTTP listener
 * to `port` (defaults to 9099 for co-located/community-box mode). Must match
 * the port in the registration YAML's `url` (read by the homeserver, not by Zooid).
 */
export interface MatrixTransportConfig {
  type: 'matrix'
  homeserver: string
  /**
   * Application-service token. Sent on every Client-Server API call.
   * @default value of `$MATRIX_AS_TOKEN` in the daemon's env
   */
  as_token: string
  /**
   * Homeserver-to-AS token. The homeserver presents this on push.
   * @default value of `$MATRIX_HS_TOKEN` in the daemon's env
   */
  hs_token: string
  /**
   * Localpart of the AS sender user (the bridge bot).
   * @default 'zooid', or the workstation name when `workstation` is set
   */
  sender_localpart: string
  /**
   * Regex covering all bot users, e.g. `@.*:example.com`.
   * @default `@.*:<host>`, or workstation-scoped `@<workstation>\..*:<host>` when `workstation` is set
   */
  user_namespace: string
  /**
   * AS HTTP listener port. Mutually exclusive with `advertise_url`.
   * When set, the registration `url` is `http://host.docker.internal:<port>`.
   * @default 9099 (co-located mode) when neither port nor advertise_url is set
   */
  port?: number
  /**
   * Explicit registration URL advertised to the homeserver. Mutually exclusive
   * with `port`. Use for multi-workstation setups where the homeserver reaches
   * the daemon via a stable external address.
   */
  advertise_url?: string
  /**
   * AS mode. `appservice` = push transport (homeserver calls the daemon).
   * `client` = pull transport (daemon polls /_matrix/client/v3/sync).
   * @default 'appservice'
   */
  mode?: 'appservice' | 'client'
  /**
   * Workstation identity derived from the top-level `workstation:` in
   * zooid.yaml. Present only when a workstation is declared; absent for the
   * shared-namespace `zooid dev` profile.
   */
  workstation?: string
  /**
   * Workforce space localpart. Resolves to alias `#<space>:<server>`.
   * @default 'dev'
   */
  space?: string
}

/**
 * Plain HTTP API transport.
 */
export interface HttpTransportConfig {
  type: 'http'
  /**
   * HTTP listener port.
   * @default 8080
   */
  port: number
}

export type TransportConfig = MatrixTransportConfig | HttpTransportConfig

/**
 * Parsed zooid.yaml shape. Always multi-agent — `agents:` is required and
 * must have at least one entry. At least one transport must be declared and
 * each agent must reference one by name.
 */
export interface ZooidConfig {
  runtime: 'local' | 'docker' | 'podman'
  /**
   * Workstation identity. A short, lowercase, hyphen-separated name that
   * uniquely identifies this daemon instance (e.g. `laptop`, `ec2-prod`).
   * When set, the matrix transport derives `sender_localpart` and
   * `user_namespace` from it, enabling exclusive per-workstation AS namespaces.
   */
  workstation?: string
  /** Workforce-wide container defaults. Image only — no workforce-level env. Rejected when runtime: local. */
  container?: ZooidContainerConfig
  /** Required. Map of operator-chosen names → transport config. At least one entry. */
  transports: Record<string, TransportConfig>
  /** Required. Must have at least one entry. */
  agents: Record<string, AgentConfig>
  /** Workforce-wide hook defaults. Merged into each agent.hooks at load time. */
  hooks: {
    pre_turn?: string
    post_turn?: string
  }
}

export interface CliFlags {
  runtime?: string
  /** Container image override (shorthand for container.image). */
  image?: string
}

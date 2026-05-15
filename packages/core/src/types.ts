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
 * Per-agent container configuration. Holds runtime-neutral container
 * concerns — image, env. Rejected at parse time when `runtime: local`.
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
}

/**
 * Workforce-level container defaults. Currently `image` only — see
 * [ZOD043] §Non-goals on workforce-level env.
 */
export interface ZooidContainerConfig {
  image?: string
}

/**
 * Matrix transport binding. Lives under `agents.<name>.matrix:` in
 * zooid.yaml. The block name (`matrix`) is the transport-kind
 * discriminator: `transports[transport].type` must equal `"matrix"`.
 */
export interface MatrixBinding {
  /** Ref into `ZooidConfig.transports`. Resolved transport must have type: 'matrix'. */
  transport: string
  /** Full Matrix user ID for this agent's bot, e.g. `@architect:example.com`. */
  user_id: string
  /** Optional human-readable display name. Written to the agent's Matrix
   *  profile on bootstrap. Falls back to the user_id localpart when absent. */
  display_name?: string
  /** Room IDs / aliases this agent watches. */
  rooms: string[]
  /** Routing rule. `mention` requires the bot to be tagged; `any` triggers on every message. */
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
  /** Routing name. Must match /^[a-z][a-z0-9-]{0,31}$/ */
  name: string
  /** Host directory for the agent's workspace. */
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
   * 0 = no timeout (default). The paused agent's idle cost is negligible,
   * so opt-in is the right shape — set this only if you're running in a
   * scale-to-zero / serverless context where unbounded waits would hold
   * resources.
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
 * to `port` (defaults to 8080).
 */
export interface MatrixTransportConfig {
  type: 'matrix'
  homeserver: string
  as_token: string
  hs_token: string
  sender_localpart: string
  /** Regex covering all bot users, e.g. `@.*:example.com` */
  user_namespace: string
  /** AS HTTP listener port. Defaults to 8080. */
  port?: number
  /** Workforce space localpart. Resolves to alias `#<space>:<server>`. Defaults to `dev`. */
  space?: string
}

/**
 * Plain HTTP API transport.
 */
export interface HttpTransportConfig {
  type: 'http'
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

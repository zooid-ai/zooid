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
 * Docker-specific configuration, nested under `docker:` in workforce.yaml.
 * Ignored when `runtime: local`.
 */
export interface DockerConfig {
  /** Workforce-wide default image. Per-agent `docker.image` takes precedence. */
  image?: string
}

/**
 * Per-agent docker block inside a multi-agent workforce.yaml. Rejected at
 * parse time when top-level `runtime !== 'docker'`.
 */
export interface AgentDockerConfig {
  /** Image for this agent. Optional; inherits top-level `docker.image`. */
  image?: string
  /**
   * Env vars to forward into this agent's container. Each entry is either:
   *   - "NAME"               — pass-through same-name from process.env
   *   - "HOST:CONTAINER"     — read process.env[HOST], expose as CONTAINER
   *
   * ZOOID_TOKEN and any ZOOID_* var are blocked unconditionally on either
   * side of a rename. Missing source vars contribute nothing.
   */
  forward_env?: string[]
}

/**
 * Per-agent config inside a multi-agent workforce.yaml. Each agent has its
 * own workspace, hooks, and an ACP block describing the shim to spawn.
 */
export interface AgentConfig {
  /** Routing name. Must match /^[a-z][a-z0-9-]{0,31}$/ */
  name: string
  /** Name of an entry in `WorkforceConfig.transports`. */
  transport: string
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
  /** Docker-only block. Rejected at parse time when runtime !== 'docker'. */
  docker?: AgentDockerConfig
  /** Matrix-only: full Matrix user ID for this agent's bot, e.g. `@architect:example.com`. */
  matrix_user_id?: string
  /** Matrix-only: list of room IDs this agent watches. */
  rooms?: string[]
  /** Matrix-only: routing rule. `mention` requires the bot to be tagged; `any` triggers on every message. */
  trigger?: 'mention' | 'any'
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
 * Parsed workforce.yaml shape. Always multi-agent — `agents:` is required and
 * must have at least one entry. At least one transport must be declared and
 * each agent must reference one by name.
 */
export interface WorkforceConfig {
  runtime: 'local' | 'docker' | 'podman'
  /** Docker-specific config. Populated when `runtime === 'docker' | 'podman'`. */
  docker?: DockerConfig
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
  /** Docker image override (shorthand for docker.image). */
  image?: string
}

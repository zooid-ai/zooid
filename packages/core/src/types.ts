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
 * Docker-specific configuration, nested under `docker:` in daemon.yaml.
 * Ignored when `runtime: local`.
 */
export interface DockerConfig {
  /** Daemon-wide default image. Per-agent `docker.image` takes precedence. */
  image?: string
}

/**
 * Per-agent docker block inside a multi-agent daemon.yaml. Rejected at
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
 * Per-agent config inside a multi-agent daemon.yaml. Each agent has its own
 * workspace, hooks, and an ACP block describing the shim to spawn.
 */
export interface AgentConfig {
  /** Routing name. Must match /^[a-z][a-z0-9-]{0,31}$/ */
  name: string
  /** Host directory for the agent's workspace. */
  workdir: string
  /** Per-agent hooks. Daemon-wide hooks are merged in at load time. */
  hooks: {
    pre_turn?: string
    post_turn?: string
  }
  /** Required: how to launch this agent's ACP shim. */
  acp: AcpAgentSpec
  /** Docker-only block. Rejected at parse time when runtime !== 'docker'. */
  docker?: AgentDockerConfig
}

/**
 * Parsed daemon.yaml shape. Always multi-agent — `agents:` is required and
 * must have at least one entry.
 */
export interface BuddConfig {
  transport: 'http'
  port: number
  runtime: 'local' | 'docker' | 'podman'
  /** Docker-specific config. Populated when `runtime === 'docker' | 'podman'`. */
  docker?: DockerConfig
  /** Required. Must have at least one entry. */
  agents: Record<string, AgentConfig>
  /** Daemon-wide hook defaults. Merged into each agent.hooks at load time. */
  hooks: {
    pre_turn?: string
    post_turn?: string
  }
}

export interface CliFlags {
  transport?: string
  port?: number
  runtime?: string
  /** Docker image override (shorthand for docker.image). */
  image?: string
}

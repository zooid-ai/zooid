import type { ChildProcess } from 'node:child_process'

/**
 * Events emitted by SessionRunner during a run.
 */
export type SessionEvent =
  | { type: 'session.started'; session_id: string }
  | { type: 'stdout'; chunks: string[] }
  | { type: 'stderr'; chunks: string[] }
  | { type: 'session.ended'; exit_code: number; reason?: string }

/**
 * Description of a process to spawn. Runtimes consume this and return
 * a ChildProcess; adapters produce it.
 */
export interface SpawnConfig {
  command: string
  args: string[]
  env?: Record<string, string>
  cwd?: string
}

/**
 * A Runtime knows how to spawn a process. The local runtime spawns on the
 * host machine; future runtimes (docker, firecracker) spawn inside sandboxes.
 *
 * `containerized: true` tells SessionRunner that the agent CLI lives inside
 * the runtime's sandbox (not on the host PATH), so the runner should skip
 * the host adapter detection step and use the first registered adapter.
 */
export interface Runtime {
  spawn(config: SpawnConfig): ChildProcess
  readonly containerized?: boolean
}

/**
 * An AgentAdapter knows how to invoke a specific CLI agent (claude, codex,
 * opencode, pi). It builds the spawn config and detects whether the binary
 * is available on the host.
 */
export interface AgentAdapter {
  name: string
  isAvailable(pathOverride?: string): boolean
  spawn(opts: {
    prompt: string
    session_id: string
    resume: boolean
  }): SpawnConfig
  parseOutput?(line: string): { kind: string; content: unknown }
}

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
 * Parsed daemon.yaml shape (MVP subset). transport-specific fields and
 * runtime-specific fields will widen this in future epics.
 */
export interface AgentdConfig {
  transport: 'http'
  port: number
  runtime: 'local' | 'docker'
  /** Image to use when `runtime === 'docker'`. Undefined for local runtime. */
  image?: string
  /** Host directory to mount into the container. Undefined → CLI defaults to cwd. */
  workdir?: string
  hooks: {
    pre_start?: string
    post_end?: string
  }
}

export interface CliFlags {
  transport?: string
  port?: number
  runtime?: string
  image?: string
  workdir?: string
  preStart?: string
  postEnd?: string
}

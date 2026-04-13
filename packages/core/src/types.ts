import type { ChildProcess } from 'node:child_process'

/**
 * Events emitted by SessionRunner during a run.
 *
 * Lifecycle:
 *   - `session.start` fires once per session, on the first run that creates
 *     a new `session_id`. Resumes do not re-emit it (the client already
 *     knows the id — it sent it in the request).
 *   - `turn.start` fires at the beginning of every run, new and resume.
 *   - `turn.end` fires at the end of every run with the agent's exit code.
 *
 * There is intentionally no `session.end` yet — sessions are open-ended.
 * A future epic will add explicit termination (agent- or user-initiated).
 */
export type SessionEvent =
  | { type: 'session.start'; session_id: string }
  | { type: 'turn.start' }
  | { type: 'stdout'; chunks: string[] }
  | { type: 'stderr'; chunks: string[] }
  | { type: 'turn.end'; exit_code: number; reason?: string }

/**
 * A directory (or file) under `$HOME` to mount into the container.
 * Used by the Docker runtime to persist agent state across sessions.
 */
export interface HomeMount {
  /** Path relative to $HOME, e.g. '.claude/projects' or '.codex/sessions'. */
  path: string
  mode: 'ro' | 'rw'
}

/**
 * Description of a process to spawn. Runtimes consume this and return
 * a ChildProcess; adapters produce it.
 */
export interface SpawnConfig {
  command: string
  args: string[]
  env?: Record<string, string>
  cwd?: string
  /** Home-directory mounts the adapter needs persisted. Docker runtime uses
   *  these to generate `-v` flags; local runtime ignores them. */
  homeMounts?: HomeMount[]
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
 * How an AgentAdapter assigns session ids when starting a *new* session.
 *
 * - `preassigned`: the adapter mints the id up front (e.g. claudeAdapter
 *   returns a UUID via `crypto.randomUUID()`). The runner passes it to
 *   `spawn()` and emits `session.start` before the agent process runs.
 *
 * - `deferred`: the CLI itself picks the id on its first turn and surfaces
 *   it mid-stream (e.g. codex prints `thread.started` JSONL before the
 *   first assistant message). The runner spawns *without* a session id,
 *   then watches stdout via `parseOutput()` for a `session_started` line
 *   and emits `session.start` when it arrives. Resumes are unaffected —
 *   the caller already knows the id.
 */
export type SessionIdPlan =
  | { strategy: 'preassigned'; session_id: string }
  | { strategy: 'deferred' }

/**
 * One classified line of agent stdout. Returned by `AgentAdapter.parseOutput`
 * so the runner can extract structured signals (currently just deferred
 * session ids; richer event mapping comes later).
 */
export type ParsedLine =
  | { kind: 'session_started'; session_id: string }
  | { kind: 'message'; raw: unknown }
  | { kind: 'ignore' }

/**
 * An AgentAdapter knows how to invoke a specific CLI agent (claude, codex,
 * opencode, pi). It builds the spawn config, detects whether the binary is
 * available on the host, and tells the runner how session ids are assigned.
 */
export interface AgentAdapter {
  name: string
  isAvailable(pathOverride?: string): boolean
  /** Called once per *new* session (skipped on resume). */
  prepareNewSession(): SessionIdPlan
  /**
   * Home-directory mounts the agent needs persisted across container runs.
   * The Docker runtime turns these into `-v` flags; daemon.yaml `docker.home_mounts`
   * overrides them entirely when present. Local runtime ignores them.
   */
  homeMounts?: HomeMount[]
  spawn(opts: {
    prompt: string
    /** Undefined on a new session for `deferred` adapters. */
    session_id: string | undefined
    resume: boolean
  }): SpawnConfig
  /**
   * Required for `deferred` adapters — the runner feeds it each stdout line
   * and watches for `{ kind: 'session_started' }`. Optional for adapters
   * that don't need line-level parsing.
   */
  parseOutput?(line: string): ParsedLine
  /**
   * Open a live stream of events for an existing session by tailing whatever
   * persistent state the underlying CLI writes (e.g. Claude Code's
   * `~/.claude/projects/<encoded-cwd>/<id>.jsonl`). Used by the HTTP
   * transport's `GET /sessions/:id/events` route to let clients reattach
   * after a disconnect, and by future transports that want to surface a
   * session's history without re-running the agent.
   *
   * - Resolves to `null` if no persistent state exists for that id under
   *   `cwd` (treat as 404).
   * - Yields events from the start of the file, then continues live.
   * - Iteration ends when the file goes idle for the adapter's chosen
   *   timeout (typical heuristic for "the current turn is done"), or when
   *   the consumer breaks out of the loop.
   *
   * Optional: adapters whose CLI doesn't persist sessions on disk omit this,
   * and the route returns 404 unconditionally for that adapter.
   */
  openStream?(
    id: string,
    cwd: string,
  ): Promise<AsyncIterable<SessionEvent> | null>
  /**
   * Decide whether a session is currently mid-turn by inspecting whatever
   * persistent state the underlying CLI keeps. Used by the HTTP transport to
   * 409 a `POST /sessions/:id/turns` that races an in-flight turn — without
   * this guard, two concurrent turns would silently fork the conversation
   * tree (claude code, observed empirically, does not lock or detect
   * concurrent resume).
   *
   * Adapters that can't tell return `false` (or omit the method entirely),
   * which means the transport will never 409 — it'll just let the second
   * turn through and accept whatever the underlying CLI does.
   *
   * No promise of liveness: if the CLI crashed in a way that left no
   * terminal marker (e.g. SIGKILL/OOM), the adapter is allowed to keep
   * reporting busy. Recovery for such stuck sessions is out of scope here.
   */
  isSessionBusy?(id: string, cwd: string): Promise<boolean>
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
 * Docker-specific configuration, nested under `docker:` in daemon.yaml.
 * Ignored when `runtime: local`.
 */
export interface DockerConfig {
  image: string
  /** Override adapter-provided home mounts. When set, replaces adapter defaults entirely. */
  home_mounts?: HomeMount[]
}

/**
 * Parsed daemon.yaml shape (MVP subset). transport-specific fields and
 * runtime-specific fields will widen this in future epics.
 */
export interface BuddConfig {
  transport: 'http'
  port: number
  runtime: 'local' | 'docker'
  /** Docker-specific config. Populated when `runtime === 'docker'`. */
  docker?: DockerConfig
  /** Host directory to mount into the container. Undefined → CLI defaults to cwd. */
  workdir?: string
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
  workdir?: string
  preTurn?: string
  postTurn?: string
}

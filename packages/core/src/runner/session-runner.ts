import { ulid } from 'ulidx'
import { Chunker } from './chunker.js'
import { runHook } from './hooks.js'
import { detectAdapter } from '../adapters/registry.js'
import type { AgentAdapter, Runtime, SessionEvent } from '../types.js'

export interface SessionRunnerOptions {
  runtime: Runtime
  adapters: AgentAdapter[]
  hooks: { pre_start?: string; post_end?: string }
  cwd?: string
  /** Prepended to PATH when detecting and spawning the adapter. Used in tests. */
  pathPrefix?: string
  /** Replaces PATH entirely when detecting the adapter. Used in tests only. */
  overridePath?: string
  /** Extra env vars passed to the adapter's spawn. */
  adapterEnv?: Record<string, string>
  /** Chunking tuning — defaults match the spec (3s idle, 64 KiB). */
  idleMs?: number
  maxBytes?: number
}

export interface RunOpts {
  prompt: string
  session_id?: string
  onEvent: (e: SessionEvent) => void
}

export interface RunResult {
  exit_code: number
  session_id: string
}

/**
 * SessionRunner drives one agent session from spawn to exit. It is
 * transport-agnostic — callers feed it a prompt and consume SessionEvents
 * via onEvent. The HTTP transport (epic 02) and message-bus transports
 * (Slack/Zooid, later epics) wrap this.
 */
export class SessionRunner {
  constructor(private opts: SessionRunnerOptions) {}

  /**
   * Side-effect-free pre-flight check. Resolves the same PATH the runner
   * would use at run() time and asks the adapter registry whether any
   * adapter is available. Used by transports (e.g. HTTP) to surface a
   * `503` before opening a stream rather than emitting a terminal event
   * mid-response.
   */
  checkReady(): { ready: boolean; error?: string } {
    // Containerized runtimes (e.g. Docker) host the agent CLI inside the
    // sandbox, not on the host PATH. We can't cheaply probe the image so
    // we trust it — image-missing surfaces later as a docker exit code 125.
    if (this.opts.runtime.containerized) {
      if (this.opts.adapters.length === 0) {
        return { ready: false, error: 'no agent adapter registered' }
      }
      return { ready: true }
    }

    const resolvedPath =
      this.opts.overridePath ??
      (this.opts.pathPrefix
        ? `${this.opts.pathPrefix}:${process.env.PATH ?? ''}`
        : (process.env.PATH ?? ''))
    const adapter = detectAdapter(this.opts.adapters, resolvedPath)
    if (!adapter) return { ready: false, error: 'no agent adapter detected' }
    return { ready: true }
  }

  async run({ prompt, session_id, onEvent }: RunOpts): Promise<RunResult> {
    const cwd = this.opts.cwd ?? process.cwd()
    const sessionId = session_id ?? ulid()
    const resuming = session_id !== undefined
    const hookEnv = {
      SESSION_ID: sessionId,
      MESSAGE_TEXT: prompt,
      WORKDIR: cwd,
    }

    // 1. pre_start hook. Failures abort before session.started.
    if (this.opts.hooks.pre_start) {
      const hookResult = await runHook(this.opts.hooks.pre_start, hookEnv, cwd)
      if (hookResult.exit_code !== 0) {
        onEvent({
          type: 'session.ended',
          exit_code: 1,
          reason: `pre_start failed: ${hookResult.stderr.trim() || `exit ${hookResult.exit_code}`}`,
        })
        return { exit_code: 1, session_id: sessionId }
      }
    }

    // 2. Detect adapter. For containerized runtimes the agent CLI lives
    //    inside the image (not on the host PATH), so use the first
    //    registered adapter unconditionally — host detection would
    //    incorrectly fail.
    const containerized = this.opts.runtime.containerized === true
    const resolvedPath = containerized
      ? (process.env.PATH ?? '')
      : (this.opts.overridePath ??
        (this.opts.pathPrefix
          ? `${this.opts.pathPrefix}:${process.env.PATH ?? ''}`
          : (process.env.PATH ?? '')))
    const adapter = containerized
      ? (this.opts.adapters[0] ?? null)
      : detectAdapter(this.opts.adapters, resolvedPath)
    if (!adapter) {
      throw new Error('no agent adapter detected')
    }

    // 3. Emit session.started.
    onEvent({ type: 'session.started', session_id: sessionId })

    // 4. Spawn the agent.
    const spawnConfig = adapter.spawn({
      prompt,
      session_id: sessionId,
      resume: resuming,
    })
    const child = this.opts.runtime.spawn({
      ...spawnConfig,
      env: {
        ...spawnConfig.env,
        PATH: resolvedPath,
        ...this.opts.adapterEnv,
      },
    })

    // 5. Pipe stdout/stderr through chunkers.
    const stdoutChunker = new Chunker({
      idleMs: this.opts.idleMs ?? 3000,
      maxBytes: this.opts.maxBytes ?? 64 * 1024,
      onFlush: (chunks) => onEvent({ type: 'stdout', chunks }),
    })
    const stderrChunker = new Chunker({
      idleMs: this.opts.idleMs ?? 3000,
      maxBytes: this.opts.maxBytes ?? 64 * 1024,
      onFlush: (chunks) => onEvent({ type: 'stderr', chunks }),
    })

    child.stdout?.on('data', (d) => stdoutChunker.write(d.toString()))
    child.stderr?.on('data', (d) => stderrChunker.write(d.toString()))

    const exitCode = await new Promise<number>((resolve) => {
      child.on('exit', (code) => resolve(code ?? 1))
    })

    // 6. Final flush.
    stdoutChunker.end()
    stderrChunker.end()

    // 7. post_end hook — failure logged but does not alter the agent exit code.
    if (this.opts.hooks.post_end) {
      const postEnv = { ...hookEnv, EXIT_CODE: String(exitCode) }
      const hookResult = await runHook(this.opts.hooks.post_end, postEnv, cwd)
      if (hookResult.exit_code !== 0) {
        process.stderr.write(
          `[agentd] post_end failed (exit ${hookResult.exit_code}): ${hookResult.stderr.trim()}\n`,
        )
      }
    }

    // 8. session.ended with the agent's exit code.
    onEvent({ type: 'session.ended', exit_code: exitCode })
    return { exit_code: exitCode, session_id: sessionId }
  }
}

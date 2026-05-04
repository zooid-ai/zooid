import { Chunker } from './chunker.js'
import { runHook } from './hooks.js'
import type {
  AgentAdapter,
  ExtraMount,
  Runtime,
  SessionEvent,
  SpawnConfig,
} from '../types.js'

export interface SessionRunnerOptions {
  runtime: Runtime
  /** The single adapter this runner drives. Picked by `buildRunnersFromConfig`
   *  from the per-agent `adapter:` field (default: first registered). */
  adapter: AgentAdapter
  hooks: { pre_turn?: string; post_turn?: string }
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
  /** Per-agent extra mounts from daemon.yaml, passed through to the runtime. */
  extraMounts?: ExtraMount[]
  /** Subtractive override for adapter-declared workspaceReadOnly, from daemon.yaml. */
  workspaceReadOnlyDisable?: string[]
}

export interface RunOpts {
  prompt: string
  session_id?: string
  onEvent: (e: SessionEvent) => void
}

export interface RunResult {
  exit_code: number
  /**
   * Undefined when a `deferred`-strategy adapter exits before surfacing a
   * session id (e.g. it crashed before printing `thread.started`). For
   * `preassigned` adapters and resumes this is always set.
   */
  session_id: string | undefined
}

/**
 * SessionRunner drives one agent session from spawn to exit. It is
 * transport-agnostic — callers feed it a prompt and consume SessionEvents
 * via onEvent. The HTTP transport (epic 02) and message-bus transports
 * (Slack/Zooid, later epics) wrap this.
 */
export class SessionRunner {
  constructor(private opts: SessionRunnerOptions) {}

  /** Exposed for test introspection — buildRunnersFromConfig tests assert
   *  that the right adapter lands on each per-agent runner. */
  get adapter(): AgentAdapter {
    return this.opts.adapter
  }

  /** Exposed for test introspection — buildRunnersFromConfig tests assert
   *  that the right runtime (image) lands on each per-agent runner. */
  get runtime(): Runtime {
    return this.opts.runtime
  }

  /**
   * Side-effect-free pre-flight check. Containerized runtimes (docker) are
   * trusted — image-missing surfaces later as exit code 125. Local runtime
   * checks the adapter binary on the resolved PATH.
   */
  checkReady(): { ready: boolean; error?: string } {
    if (this.opts.runtime.containerized) return { ready: true }
    const resolvedPath = this.resolvedPath()
    if (!this.opts.adapter.isAvailable(resolvedPath)) {
      return { ready: false, error: 'no agent adapter detected' }
    }
    return { ready: true }
  }

  /**
   * Open a live event stream for an existing session id by delegating to the
   * adapter's `openStream`. Returns `null` when the adapter does not implement
   * `openStream` or reports no state for `id` under the current cwd. The
   * transport surfaces both as 404.
   */
  async openSessionStream(
    id: string,
  ): Promise<AsyncIterable<SessionEvent> | null> {
    const adapter = this.opts.adapter
    if (!adapter.openStream) return null
    const cwd = this.opts.cwd ?? process.cwd()
    return adapter.openStream(id, cwd)
  }

  /**
   * Decide whether a session is currently mid-turn by delegating to the
   * adapter. Returns `false` when the adapter doesn't implement the check
   * (we'd rather let the request through and surface whatever the CLI does
   * than refuse based on missing information).
   */
  async isSessionBusy(id: string): Promise<boolean> {
    const adapter = this.opts.adapter
    if (!adapter.isSessionBusy) return false
    const cwd = this.opts.cwd ?? process.cwd()
    return adapter.isSessionBusy(id, cwd)
  }

  private resolvedPath(): string {
    if (this.opts.runtime.containerized) return process.env.PATH ?? ''
    if (this.opts.overridePath !== undefined) return this.opts.overridePath
    if (this.opts.pathPrefix) {
      return `${this.opts.pathPrefix}:${process.env.PATH ?? ''}`
    }
    return process.env.PATH ?? ''
  }

  async run({ prompt, session_id, onEvent }: RunOpts): Promise<RunResult> {
    const cwd = this.opts.cwd ?? process.cwd()
    const resuming = session_id !== undefined

    // 1. Resolve PATH and verify the adapter is available. For containerized
    //    runtimes the agent CLI lives inside the image (not on the host PATH)
    //    so we skip detection — image-missing surfaces later as docker exit 125.
    const containerized = this.opts.runtime.containerized === true
    const resolvedPath = this.resolvedPath()
    const adapter = this.opts.adapter
    if (!containerized && !adapter.isAvailable(resolvedPath)) {
      throw new Error('no agent adapter detected')
    }

    // 2. Decide the session id strategy.
    //
    //    On resume, the caller already has the id — both strategies just
    //    pass it through. On a new session we ask the adapter:
    //      - `preassigned`: id is known up front, runner emits session.start
    //        immediately and passes the id to spawn().
    //      - `deferred`: id is unknown until the CLI prints it; runner
    //        spawns without an id, watches stdout via parseOutput, and
    //        emits session.start lazily when the id surfaces.
    let sessionId: string | undefined
    let deferred = false
    if (resuming) {
      sessionId = session_id
    } else {
      const plan = adapter.prepareNewSession()
      if (plan.strategy === 'preassigned') {
        sessionId = plan.session_id
      } else {
        deferred = true
        if (!adapter.parseOutput) {
          throw new Error(
            `adapter "${adapter.name}" declared deferred session id strategy ` +
              `but does not implement parseOutput()`,
          )
        }
      }
    }

    // hookEnv exposes SESSION_ID. For deferred-strategy new turns the id
    // isn't known yet — pre_turn hooks see SESSION_ID="" and can branch on
    // [ -z "$SESSION_ID" ] to detect "new session, id pending".
    const hookEnv = {
      SESSION_ID: sessionId ?? '',
      MESSAGE_TEXT: prompt,
      WORKDIR: cwd,
    }

    // 3. pre_turn hook. Failures abort before session.start / turn.start.
    if (this.opts.hooks.pre_turn) {
      const hookResult = await runHook(this.opts.hooks.pre_turn, hookEnv, cwd)
      if (hookResult.exit_code !== 0) {
        onEvent({
          type: 'turn.end',
          exit_code: 1,
          reason: `pre_turn failed: ${hookResult.stderr.trim() || `exit ${hookResult.exit_code}`}`,
        })
        return { exit_code: 1, session_id: sessionId }
      }
    }

    // 4. Emit lifecycle anchors.
    //    - preassigned + new session: session.start fires now with the id.
    //    - resume: session.start does not fire (client already knows the id).
    //    - deferred + new session: session.start is held until parseOutput
    //      surfaces the id from the stdout stream.
    //    turn.start always fires.
    if (!resuming && !deferred) {
      onEvent({ type: 'session.start', session_id: sessionId! })
    }
    onEvent({ type: 'turn.start' })

    // 5. Spawn the agent. Thread adapter-declared mount defaults and
    //    per-agent overrides into SpawnConfig — the Docker runtime turns
    //    them into `-v` flags; the local runtime ignores them.
    const spawnConfig = adapter.spawn({
      prompt,
      session_id: sessionId,
      resume: resuming,
    })
    const spawnCfg: SpawnConfig = {
      ...spawnConfig,
      env: {
        ...spawnConfig.env,
        PATH: resolvedPath,
        ...this.opts.adapterEnv,
      },
      workspaceReadOnly: adapter.workspaceReadOnly,
      workspaceReadOnlyDisable: this.opts.workspaceReadOnlyDisable,
      homeReadOnly: adapter.homeReadOnly,
      sessionStateDir: adapter.sessionStateDir?.('/workspace'),
      extraMounts: this.opts.extraMounts,
    }
    const child = this.opts.runtime.spawn(spawnCfg)

    // 6. Pipe stdout/stderr through chunkers, plus a line-splitter on
    //    stdout for deferred adapters so we can extract the session id.
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

    // Line buffer for deferred-id extraction. Runs in addition to the
    // chunker — the chunker still ships raw bytes to the client; this is
    // a parallel observer purely for parseOutput.
    let lineBuf = ''
    const consumeLine = (line: string) => {
      if (!deferred || sessionId !== undefined) return
      const parsed = adapter.parseOutput!(line)
      if (parsed.kind === 'session_started') {
        sessionId = parsed.session_id
        onEvent({ type: 'session.start', session_id: sessionId })
      }
    }

    child.stdout?.on('data', (d) => {
      const text = d.toString()
      stdoutChunker.write(text)
      if (deferred && sessionId === undefined) {
        lineBuf += text
        let nl: number
        while ((nl = lineBuf.indexOf('\n')) !== -1) {
          const line = lineBuf.slice(0, nl)
          lineBuf = lineBuf.slice(nl + 1)
          if (line.length > 0) consumeLine(line)
        }
      }
    })
    child.stderr?.on('data', (d) => stderrChunker.write(d.toString()))

    const exitCode = await new Promise<number>((resolve) => {
      child.on('exit', (code) => resolve(code ?? 1))
    })

    // 7. Final flush. Drain any tail line for deferred id extraction too.
    stdoutChunker.end()
    stderrChunker.end()
    if (deferred && sessionId === undefined && lineBuf.length > 0) {
      consumeLine(lineBuf)
      lineBuf = ''
    }

    // 8. post_turn hook — failure logged but does not alter the agent exit code.
    //    For deferred adapters that surfaced an id mid-stream, the post_turn
    //    env reflects the now-known id; for ones that crashed before surfacing
    //    one, SESSION_ID stays empty.
    if (this.opts.hooks.post_turn) {
      const postEnv = {
        ...hookEnv,
        SESSION_ID: sessionId ?? '',
        EXIT_CODE: String(exitCode),
      }
      const hookResult = await runHook(this.opts.hooks.post_turn, postEnv, cwd)
      if (hookResult.exit_code !== 0) {
        process.stderr.write(
          `[zooid] post_turn failed (exit ${hookResult.exit_code}): ${hookResult.stderr.trim()}\n`,
        )
      }
    }

    // 9. turn.end with the agent's exit code.
    onEvent({ type: 'turn.end', exit_code: exitCode })
    return { exit_code: exitCode, session_id: sessionId }
  }
}

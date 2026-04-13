import { Chunker } from './chunker.js'
import { runHook } from './hooks.js'
import { detectAdapter } from '../adapters/registry.js'
import type { AgentAdapter, Runtime, SessionEvent } from '../types.js'

export interface SessionRunnerOptions {
  runtime: Runtime
  adapters: AgentAdapter[]
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

  /**
   * Open a live event stream for an existing session id by delegating to the
   * adapter's `openStream`. Used by transports (HTTP `GET /sessions/:id/events`)
   * to let clients reattach to a session after a disconnect, or to read its
   * history without re-running the agent.
   *
   * Returns `null` when:
   *   - no adapter is registered / detected,
   *   - the detected adapter doesn't implement `openStream` (its CLI doesn't
   *     persist sessions in a tailable form), or
   *   - the adapter implements it but reports no state for `id` under the
   *     current cwd (e.g. the file doesn't exist for the claude adapter).
   *
   * The transport surfaces all three as 404 — they're indistinguishable from
   * the client's perspective ("there is no readable stream for that id here").
   */
  async openSessionStream(
    id: string,
  ): Promise<AsyncIterable<SessionEvent> | null> {
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
    if (!adapter || !adapter.openStream) return null
    const cwd = this.opts.cwd ?? process.cwd()
    return adapter.openStream(id, cwd)
  }

  /**
   * Decide whether a session is currently mid-turn by delegating to the
   * adapter. Used by the HTTP transport to 409 a `POST /sessions/:id/turns`
   * that races an in-flight turn — see the long comment on
   * `AgentAdapter.isSessionBusy` for the rationale and the SIGKILL gap.
   *
   * Returns `false` when no adapter is detected or the detected adapter
   * doesn't implement the check (we'd rather let the request through and
   * surface whatever the CLI does than refuse based on missing information).
   */
  async isSessionBusy(id: string): Promise<boolean> {
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
    if (!adapter || !adapter.isSessionBusy) return false
    const cwd = this.opts.cwd ?? process.cwd()
    return adapter.isSessionBusy(id, cwd)
  }

  async run({ prompt, session_id, onEvent }: RunOpts): Promise<RunResult> {
    const cwd = this.opts.cwd ?? process.cwd()
    const resuming = session_id !== undefined

    // 1. Detect adapter. For containerized runtimes the agent CLI lives
    //    inside the image (not on the host PATH), so use the first
    //    registered adapter unconditionally — host detection would
    //    incorrectly fail. Detection runs before id assignment because the
    //    adapter is what decides the id strategy.
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

    // 5. Spawn the agent.
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
      homeMounts: adapter.homeMounts,
    })

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
          `[budd] post_turn failed (exit ${hookResult.exit_code}): ${hookResult.stderr.trim()}\n`,
        )
      }
    }

    // 9. turn.end with the agent's exit code.
    onEvent({ type: 'turn.end', exit_code: exitCode })
    return { exit_code: exitCode, session_id: sessionId }
  }
}

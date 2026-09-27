import type { ChildProcess } from 'node:child_process'
import { resolve as pathResolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type SessionModeState,
  type AgentCapabilities,
} from '@agentclientprotocol/sdk'
import { AgentProcess } from './agent-process.js'
import { SessionMap } from './session-map.js'
import { JsonFileSessionStore } from './session-store.js'
import { resolvePreset } from './presets.js'
import { acpUpdateToAgentEvent, approvalDecisionToPermissionResponse } from './event-mapping.js'
import { TurnTracker, type TapEvent } from './turn-tracker.js'
import { classify } from './errors.js'
import type {
  AgentConfig,
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
  PromptInput,
  PromptResult,
} from './types.js'

/**
 * Minimal interface for an external process spawner. Mirrors `AcpRuntime`
 * in `@zooid/core` but kept structural here to avoid a back-edge.
 */
export interface SpawnRuntime {
  spawn(spec: {
    command: string
    args: string[]
    env?: Record<string, string>
    cwd?: string
    /** Container image. Honoured by container runtimes; ignored by local spawners. */
    image?: string
    /** Bind mounts. Honoured by container runtimes; ignored by local spawners. */
    mounts?: Array<{ path: string; target: string; mode: 'ro' | 'rw' }>
  }): ChildProcess
}

export interface AcpClientOptions {
  agent: AgentConfig
  /**
   * Per-agent state directory (typically `<dataRoot>/agents/<agentId>/`).
   * `sessions.json` is written here so threads survive daemon restarts.
   * When omitted, session continuity across restarts is disabled (a warning
   * is logged once on first ensureSession).
   */
  agentDataDir?: string
  onEvent: (event: AgentEvent) => void
  onApprovalRequest: (req: ApprovalRequest) => Promise<ApprovalDecision>
  sessionIdleTimeoutMs?: number
  onLifecycle?: (event: SessionLifecycleEvent) => void
  /**
   * If set, the runtime is used to spawn the ACP shim process instead of
   * the built-in `AgentProcess` host-spawn path. Lets the daemon launch
   * the shim inside a container (DockerAcpRuntime) without changing the
   * AcpClient surface.
   */
  runtime?: SpawnRuntime
  /**
   * Observability tap. Receives the unfiltered ACP protocol stream plus
   * synthetic turn-boundary events (turn_started / turn_completed). Optional;
   * when omitted the client behaves as before.
   */
  onTap?: (e: TapEvent) => void
  /**
   * Optional per-spawn factory. When set, the returned spec is included in
   * `session/new mcpServers` (and `session/load mcpServers`) so the shim
   * connects to the daemon-side zooid-context MCP server for the session
   * lifetime. Called once per `ensureSession(threadId)`.
   */
  contextSpawn?: (
    threadId: string,
    channelId?: string,
    sessionKey?: string,
  ) => Promise<{
    name: 'zooid-context'
    command: string
    args: string[]
    env: Array<{ name: string; value: string }>
  }>
}

export interface SessionLifecycleEvent {
  agentId: string
  sessionKey: string
  sessionId: string
  reason?: 'idle' | 'clear'
  outcome: 'closed' | 'failed' | 'unsupported' | 'recovered'
  recoveryMethod?: 'cached' | 'resume' | 'load' | 'new'
}

interface KeyLifecycle {
  tail: Promise<unknown>
  timer?: ReturnType<typeof setTimeout>
  prompts: number
  activeTurns: Set<Promise<void>>
  humans: number
  resetting: boolean
  closing: boolean
}

export class AcpClient {
  private process: AgentProcess | null = null
  private runtimeChild: ChildProcess | null = null
  private connection: ClientSideConnection | null = null
  private readonly sessions = new SessionMap()
  private store: JsonFileSessionStore | null = null
  private storeLoaded: Promise<void> | null = null
  private agentCapabilities: AgentCapabilities = {}
  private readonly lifecycle = new Map<string, KeyLifecycle>()
  private readonly replay = new Set<string>()
  private readonly permissionCancels = new Map<string, Set<() => void>>()
  private generation = 0
  private warnedNoClose = false
  private warnedNoStore = false
  private initialized = false
  private readonly turns: TurnTracker | null

  constructor(private readonly options: AcpClientOptions) {
    this.turns = options.onTap
      ? new TurnTracker({ agentId: options.agent.id, onTap: options.onTap })
      : null
  }

  async start(): Promise<void> {
    this.generation++
    this.clearTimers()
    this.warnedNoClose = false
    const { command, args } = this.resolveSpawn()
    let stdout: Readable
    let stdin: Writable
    let stderr: Readable | null = null
    if (this.options.runtime) {
      const child = this.options.runtime.spawn({
        command,
        args,
        env: this.options.agent.env,
        cwd: this.options.agent.cwd,
        image: this.options.agent.image,
        mounts: this.options.agent.mounts,
      })
      this.runtimeChild = child
      if (!child.stdout || !child.stdin) {
        throw new Error('AcpClient: runtime returned a child without piped stdio')
      }
      stdout = child.stdout
      stdin = child.stdin
      stderr = child.stderr
    } else {
      this.process = new AgentProcess({
        command,
        args,
        env: this.options.agent.env,
        cwd: this.options.agent.cwd,
      })
      this.process.start()
      stdout = this.process.stdout
      stdin = this.process.stdin
      stderr = this.process.stderr
    }

    if (stderr) forwardStderr(stderr, this.options.agent.id)

    const input = Readable.toWeb(stdout) as ReadableStream<Uint8Array>
    const output = Writable.toWeb(stdin) as WritableStream<Uint8Array>
    const stream = ndJsonStream(output, input)

    this.connection = new ClientSideConnection(() => this.buildClient(), stream)

    const init = await this.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: 'zooid', title: 'Zooid', version: '0.0.1' },
    })
    this.agentCapabilities = init.agentCapabilities ?? {}
    this.initialized = true
  }

  async stop(): Promise<void> {
    this.generation++
    this.clearTimers()
    for (const cancels of this.permissionCancels.values()) for (const cancel of cancels) cancel()
    this.permissionCancels.clear()
    this.replay.clear()
    this.sessions.clear()
    this.lifecycle.clear()
    this.process?.kill()
    this.runtimeChild?.kill('SIGTERM')
    this.process = null
    this.runtimeChild = null
    this.connection = null
    this.initialized = false
  }

  async ensureSession(
    threadId: string,
    channelId?: string,
    contextThreadId?: string,
  ): Promise<string> {
    return this.enqueue(threadId, () =>
      this.ensureSessionLocked(threadId, channelId, contextThreadId),
    )
  }

  private async ensureSessionLocked(
    threadId: string,
    channelId?: string,
    contextThreadId?: string,
  ): Promise<string> {
    if (!this.connection || !this.initialized) {
      throw new Error('AcpClient.start() must be called before ensureSession()')
    }
    const generation = this.generation
    await this.ensureStoreLoaded()
    if (generation !== this.generation) throw new Error('ACP connection changed during session setup')

    const key = { threadId, agentId: this.options.agent.id }
    const cached = this.sessions.get(key)
    if (cached) {
      this.emitLifecycle(threadId, cached.sessionId, 'recovered', undefined, 'cached')
      this.scheduleIdle(threadId)
      return cached.sessionId
    }

    const mcpServers = this.options.contextSpawn
      ? [await this.options.contextSpawn(contextThreadId ?? threadId, channelId, threadId)]
      : []
    if (generation !== this.generation) throw new Error('ACP connection changed during session setup')
    process.stderr.write(
      `[acp-client:${this.options.agent.id}] ensureSession(${threadId}) mcpServers=${
        mcpServers.length === 0
          ? '[]'
          : JSON.stringify(
              mcpServers.map((s) => ({
                name: s.name,
                command: s.command,
                args: s.args,
              })),
            )
      }\n`,
    )

    const persisted = this.store?.get(threadId)
    if (persisted) {
      const request = {
        sessionId: persisted,
        cwd: pathResolve(this.options.agent.cwd ?? process.cwd()),
        mcpServers,
      }
      for (const method of ['resume', 'load'] as const) {
        if (method === 'resume' && !this.agentCapabilities.sessionCapabilities?.resume) continue
        if (method === 'load' && !this.agentCapabilities.loadSession) continue
        this.replay.add(`${generation}:${persisted}`)
        try {
          const recovered =
            method === 'resume'
              ? await this.connection.resumeSession(request)
              : await this.connection.loadSession(request)
          if (generation !== this.generation) {
            throw new Error('ACP connection changed during recovery')
          }
          await this.applyMode(persisted, recovered.modes)
          this.sessions.set(key, { sessionId: persisted, startedAt: Date.now() })
          this.emitLifecycle(threadId, persisted, 'recovered', undefined, method)
          this.scheduleIdle(threadId)
          return persisted
        } catch (err) {
          if (generation !== this.generation) throw err
          console.warn(
            `[acp-client:${this.options.agent.id}] ${method}Session(${persisted}) failed for ${threadId}:`,
            err,
          )
          this.emitLifecycle(threadId, persisted, 'failed', undefined, method)
        } finally {
          this.replay.delete(`${generation}:${persisted}`)
        }
      }
    }

    const { sessionId, modes } = await this.connection.newSession({
      cwd: pathResolve(this.options.agent.cwd ?? process.cwd()),
      mcpServers,
    })
    if (generation !== this.generation) throw new Error('ACP connection changed during session setup')
    await this.applyMode(sessionId, modes)
    if (generation !== this.generation) throw new Error('ACP connection changed during session setup')
    this.sessions.set(key, { sessionId, startedAt: Date.now() })
    await this.store?.set(threadId, sessionId)
    this.emitLifecycle(threadId, sessionId, 'recovered', undefined, 'new')
    this.scheduleIdle(threadId)
    return sessionId
  }

  private state(threadId: string): KeyLifecycle {
    let state = this.lifecycle.get(threadId)
    if (!state) {
      state = {
        tail: Promise.resolve(),
        prompts: 0,
        activeTurns: new Set(),
        humans: 0,
        resetting: false,
        closing: false,
      }
      this.lifecycle.set(threadId, state)
    }
    return state
  }

  private enqueue<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    const state = this.state(threadId)
    const result = state.tail.then(work, work)
    state.tail = result.catch(() => {})
    return result
  }

  private clearTimer(threadId: string): void {
    const state = this.state(threadId)
    if (state.timer) clearTimeout(state.timer)
    state.timer = undefined
  }

  private clearTimers(): void {
    for (const threadId of this.lifecycle.keys()) this.clearTimer(threadId)
  }

  private scheduleIdle(threadId: string): void {
    const state = this.state(threadId)
    this.clearTimer(threadId)
    const timeout = this.options.sessionIdleTimeoutMs ?? 600_000
    if (
      !timeout ||
      state.prompts ||
      state.humans ||
      state.resetting ||
      state.closing ||
      !this.initialized
    ) return
    if (!this.sessions.get({ threadId, agentId: this.options.agent.id })) return
    const caps = this.agentCapabilities
    if (!caps.sessionCapabilities?.close) {
      this.warnNoIdleClose('session/close unsupported; adapter resources remain until process exit')
      return
    }
    // Closing is only safe when the session can come back: without resume or
    // load, the next message would silently start a fresh session.
    if (!caps.sessionCapabilities.resume && !caps.loadSession) {
      this.warnNoIdleClose('adapter cannot resume or load sessions; idle close disabled to keep context')
      return
    }
    const generation = this.generation
    state.timer = setTimeout(() => {
      if (generation === this.generation) void this.closeIdleSession(threadId)
    }, timeout)
    state.timer.unref?.()
  }

  private warnNoIdleClose(reason: string): void {
    if (this.warnedNoClose) return
    console.warn(`[acp-client:${this.options.agent.id}] ${reason}`)
    this.warnedNoClose = true
  }

  private emitLifecycle(
    sessionKey: string,
    sessionId: string,
    outcome: SessionLifecycleEvent['outcome'],
    reason?: SessionLifecycleEvent['reason'],
    recoveryMethod?: SessionLifecycleEvent['recoveryMethod'],
  ): void {
    this.options.onLifecycle?.({
      agentId: this.options.agent.id,
      sessionKey,
      sessionId,
      reason,
      outcome,
      recoveryMethod,
    })
  }

  setHumanRequestPending(threadId: string, pending: boolean): void {
    const state = this.state(threadId)
    state.humans = Math.max(0, state.humans + (pending ? 1 : -1))
    if (pending) this.clearTimer(threadId)
    else this.scheduleIdle(threadId)
  }

  async closeIdleSession(threadId: string): Promise<void> {
    const claim = this.state(threadId)
    if (claim.prompts || claim.humans || claim.resetting || claim.closing) return
    claim.closing = true
    return this.enqueue(threadId, async () => {
      const state = this.state(threadId)
      this.clearTimer(threadId)
      try {
        if (state.humans || state.resetting) return
        const key = { threadId, agentId: this.options.agent.id }
        const live = this.sessions.get(key)
        if (!live || !this.connection || !this.initialized) return
        if (!this.agentCapabilities.sessionCapabilities?.close) {
          this.warnNoIdleClose('session/close unsupported; adapter resources remain until process exit')
          this.emitLifecycle(threadId, live.sessionId, 'unsupported', 'idle')
          return
        }
        const generation = this.generation
        try {
          await this.connection.closeSession({ sessionId: live.sessionId })
          this.emitLifecycle(threadId, live.sessionId, 'closed', 'idle')
        } catch (err) {
          console.warn(
            `[acp-client:${this.options.agent.id}] idle close failed for ${threadId}/${live.sessionId}:`,
            err,
          )
          this.emitLifecycle(threadId, live.sessionId, 'failed', 'idle')
        } finally {
          if (generation === this.generation) this.sessions.delete(key)
        }
      } finally {
        state.closing = false
      }
    })
  }

  /**
   * Put a freshly created or loaded session into the agent's configured mode.
   * Mode ids are adapter-defined, so an id the adapter doesn't list is a
   * config error: fail the session rather than run it in a mode nobody chose.
   */
  private async applyMode(
    sessionId: string,
    modes: SessionModeState | null | undefined,
  ): Promise<void> {
    const wanted = this.options.agent.mode
    if (!wanted || !this.connection) return
    if (!modes) {
      throw new Error(
        `agents.${this.options.agent.id}.acp.mode "${wanted}": this agent does not offer session modes`,
      )
    }
    if (!modes.availableModes.some((m) => m.id === wanted)) {
      const offered = modes.availableModes.map((m) => m.id).join(', ')
      throw new Error(
        `agents.${this.options.agent.id}.acp.mode "${wanted}": not offered by this agent (offers: ${offered})`,
      )
    }
    if (modes.currentModeId === wanted) return
    await this.connection.setSessionMode({ sessionId, modeId: wanted })
  }

  private async ensureStoreLoaded(): Promise<void> {
    if (!this.store) {
      if (!this.options.agentDataDir) {
        if (!this.warnedNoStore) {
          console.warn(
            `[acp-client:${this.options.agent.id}] no agentDataDir configured; ` +
              `session continuity across restarts disabled`,
          )
          this.warnedNoStore = true
        }
        this.storeLoaded = Promise.resolve()
        return this.storeLoaded
      }
      this.store = new JsonFileSessionStore({
        agentId: this.options.agent.id,
        dir: this.options.agentDataDir,
      })
    }
    if (!this.storeLoaded) {
      this.storeLoaded = this.store.load().catch((err) => {
        console.warn(`[acp-client:${this.options.agent.id}] store load failed:`, err)
      })
    }
    await this.storeLoaded
  }

  private async flushStore(): Promise<void> {
    if (this.store) await this.store.flush()
  }

  async cancel(sessionId: string): Promise<void> {
    if (!this.connection || !this.initialized) return
    await this.connection.cancel({ sessionId })
  }

  /**
   * Cancel outstanding work, close the live ACP session when supported, and
   * forget the durable pointer so the next prompt starts fresh.
   */
  async endSession(threadId: string): Promise<void> {
    const state = this.state(threadId)
    state.resetting = true
    this.clearTimer(threadId)
    const key = { threadId, agentId: this.options.agent.id }
    const live = this.sessions.get(key)
    return this.enqueue(threadId, async () => {
      try {
        if (live) {
          for (const cancel of this.permissionCancels.get(live.sessionId) ?? []) cancel()
          if (state.activeTurns.size) {
            try {
              await this.cancel(live.sessionId)
            } catch (err) {
              console.warn(
                `[acp-client:${this.options.agent.id}] cancel failed for ${threadId}/${live.sessionId}:`,
                err,
              )
            }
            await Promise.allSettled([...state.activeTurns])
          }
        }
        await this.ensureStoreLoaded()
        const current = this.sessions.get(key)
        if (
          current &&
          this.connection &&
          this.initialized &&
          this.agentCapabilities.sessionCapabilities?.close
        ) {
          try {
            await this.connection.closeSession({ sessionId: current.sessionId })
            this.emitLifecycle(threadId, current.sessionId, 'closed', 'clear')
          } catch (err) {
            console.warn(
              `[acp-client:${this.options.agent.id}] clear close failed for ${threadId}/${current.sessionId}:`,
              err,
            )
            this.emitLifecycle(threadId, current.sessionId, 'failed', 'clear')
          }
        } else if (current) {
          this.warnNoIdleClose('session/close unsupported; adapter resources remain until process exit')
          this.emitLifecycle(threadId, current.sessionId, 'unsupported', 'clear')
        }
        this.sessions.delete(key)
        await this.store?.delete(threadId)
      } finally {
        state.humans = 0
        state.resetting = false
      }
    })
  }

  async prompt(input: PromptInput): Promise<PromptResult> {
    const generation = this.generation
    const state = this.state(input.threadId)
    state.prompts++
    this.clearTimer(input.threadId)
    let sessionId: string | null = null
    let turnId: string | null = null
    try {
      const launched = await this.enqueue(input.threadId, async () => {
        const id = await this.ensureSessionLocked(
          input.threadId,
          input.channelId,
          input.contextThreadId,
        )
        sessionId = id
        const promptText = stringifyPromptForLog(input.content)
        turnId = this.turns?.startTurn({ sessionId: id, promptText }) ?? null
        debugLog(this.options.agent.id, 'prompt →', {
          sessionId: id,
          content: input.content,
        })
        let finish!: () => void
        const completed = new Promise<void>((resolve) => { finish = resolve })
        const result = this.connection!.prompt({ sessionId: id, prompt: input.content })
        state.activeTurns.add(completed)
        void result.finally(() => {
          state.activeTurns.delete(completed)
          finish()
        }).catch(() => {})
        return { id, result }
      })
      const result = await launched.result
      this.turns?.endTurn({ sessionId: launched.id, stopReason: result.stopReason })
      debugLog(this.options.agent.id, 'prompt ←', {
        sessionId: launched.id,
        stopReason: result.stopReason,
      })
      return { stopReason: result.stopReason }
    } catch (err) {
      const c = classify(err)
      this.options.onTap?.({
        kind: 'error',
        agentId: this.options.agent.id,
        sessionId,
        turnId,
        code: c.code,
        message: err instanceof Error ? err.message : String(err),
        detail: err instanceof Error && err.stack ? err.stack.slice(0, 2000) : undefined,
        transient: c.transient,
        acp_error: c.acp_error,
      })
      if (sessionId) this.turns?.endTurn({ sessionId, stopReason: 'error' })
      throw err
    } finally {
      state.prompts--
      if (generation === this.generation) this.scheduleIdle(input.threadId)
    }
  }

  private resolveSpawn(): { command: string; args: string[] } {
    const { preset, command, args, model } = this.options.agent
    if (command) {
      return { command, args: args ?? [] }
    }
    if (preset) {
      return resolvePreset(preset, { model })
    }
    throw new Error('AcpClient: agent must specify either `preset` or `command`')
  }

  private buildClient(): Client {
    const agentId = this.options.agent.id
    const generation = this.generation
    return {
      sessionUpdate: async (params) => {
        if (generation !== this.generation || this.replay.has(`${generation}:${params.sessionId}`)) {
          return
        }
        this.turns?.observeUpdate(params.sessionId, params.update)
        debugLog(agentId, 'sessionUpdate', params)
        const event = acpUpdateToAgentEvent(params)
        if (event) this.options.onEvent(event)
        else debugLog(agentId, 'sessionUpdate dropped (unmapped)', params)
      },
      requestPermission: async (params) => {
        if (generation !== this.generation) return { outcome: { outcome: 'cancelled' } }
        debugLog(agentId, 'requestPermission', params)
        const tc = params.toolCall as {
          toolCallId: string
          kind?: string
          title?: string
          rawInput?: unknown
        }
        const threadId = [...this.lifecycle.keys()].find(
          (key) => this.sessions.get({ threadId: key, agentId })?.sessionId === params.sessionId,
        )
        if (threadId) this.setHumanRequestPending(threadId, true)
        let cancel!: () => void
        const cancelled = new Promise<ApprovalDecision>((resolve) => {
          cancel = () => resolve({ decision: 'cancel' })
        })
        const pending = this.permissionCancels.get(params.sessionId) ?? new Set<() => void>()
        pending.add(cancel)
        this.permissionCancels.set(params.sessionId, pending)
        try {
          const decision = await Promise.race([
            this.options.onApprovalRequest({
              sessionId: params.sessionId,
              toolCallId: tc.toolCallId,
              toolKind: tc.kind,
              toolTitle: tc.title,
              toolInput: tc.rawInput,
              options: params.options.map((o) => ({
                optionId: o.optionId,
                name: o.name,
                kind: o.kind,
              })),
            }),
            cancelled,
          ])
          debugLog(agentId, 'requestPermission ←', decision)
          return approvalDecisionToPermissionResponse(decision)
        } finally {
          pending.delete(cancel)
          if (!pending.size) this.permissionCancels.delete(params.sessionId)
          if (threadId) this.setHumanRequestPending(threadId, false)
        }
      },
    }
  }
}

function stringifyPromptForLog(content: PromptInput['content']): string {
  try {
    return JSON.stringify(content).slice(0, 4096)
  } catch {
    return '<unstringifiable>'
  }
}

function debugLog(agentId: string, label: string, payload?: unknown): void {
  if (payload === undefined) {
    process.stderr.write(`[${agentId}] ${label}\n`)
    return
  }
  let s: string
  try {
    s = JSON.stringify(payload)
  } catch {
    s = String(payload)
  }
  if (s.length > 2000) s = s.slice(0, 2000) + '…'
  process.stderr.write(`[${agentId}] ${label} ${s}\n`)
}

function forwardStderr(stream: Readable, agentId: string): void {
  let buf = ''
  const prefix = `[${agentId}] `
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    buf += chunk
    let nl: number
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      process.stderr.write(prefix + line + '\n')
    }
  })
  stream.on('end', () => {
    if (buf.length > 0) process.stderr.write(prefix + buf + '\n')
  })
}

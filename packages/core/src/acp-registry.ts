import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  AcpClient,
  resolvePreset,
  type AgentEvent,
  type ApprovalDecision,
  type ApprovalRequest,
  type PromptInput,
  type PromptResult,
  type TapEvent,
} from '@zooid/acp-client'
import type { AcpAgentSpec, AcpMount, AcpRuntime } from './acp-types.js'
import type { AgentConfig } from './types.js'
import type {
  ApprovalCorrelator,
  RegisteredApproval,
} from './approval-correlator.js'

export type AcpRegistryEventHandler = (
  agentName: string,
  event: AgentEvent,
) => void
export type AcpRegistryApprovalHandler = (
  agentName: string,
  req: ApprovalRequest,
) => Promise<ApprovalDecision>

/**
 * Daemon-side surface of the ACP agent fleet. The transport (HTTP) consumes
 * this; the CLI builds it via `buildAcpRegistry`. Long-lived: one
 * `AcpClient` per agent, kept alive across prompts.
 */
export interface AcpRegistry {
  hasAgent(name: string): boolean
  /** Whether an agent has a transport-context provider attached. */
  hasContextSpawn(name: string): boolean
  /** Per-agent approval timeout from zooid.yaml. 0 means no timeout. */
  getApprovalTimeoutMs(name: string): number
  ensureSession(name: string, threadId: string, channelId?: string): Promise<string>
  /** Drop the in-memory session for (agent, threadId). Next prompt re-creates one. */
  endSession(name: string, threadId: string): void
  prompt(name: string, input: PromptInput): Promise<PromptResult>
  /**
   * Cancel an in-flight prompt for (agent, sessionId). Sends `session/cancel`
   * via the underlying AcpClient and resolves any pending approvals with
   * `decision: 'cancel'`. Idempotent.
   */
  cancelSession(name: string, sessionId: string): Promise<void>
  stopAll(): Promise<void>
  /** Set by the transport. Receives every ACP event from any agent. */
  onEvent: AcpRegistryEventHandler
  /** Set by the transport. Resolves permission requests. */
  onApprovalRequest: AcpRegistryApprovalHandler
}

export interface AcpAgentRegistryOptions {
  runtime: AcpRuntime
  agents: Record<string, AgentConfig>
  /** Per-agent env passed to each `AcpClient`'s spawn spec. */
  env?: Record<string, Record<string, string>>
  /** Per-agent container image. Used by DockerAcpRuntime; ignored by LocalAcpRuntime. */
  image?: Record<string, string | undefined>
  /** Initial event handler (the transport may overwrite at app creation). */
  onEvent?: AcpRegistryEventHandler
  /** Initial approval handler (the transport may overwrite at app creation). */
  onApprovalRequest?: AcpRegistryApprovalHandler
  /**
   * Optional correlator: when set, the registry's default
   * `onApprovalRequest` registers each request on the correlator (with the
   * agent's `approval_timeout_ms`) and returns the registered handle's
   * `decisionPromise`. Transports listen on the correlator's `'registered'`
   * + `'timeout'` events to drive the SSE wire and accept HTTP decisions.
   */
  approvals?: ApprovalCorrelator
  /** Called whenever the correlator-backed handler registers an approval. */
  onApprovalRegistered?: (approval: RegisteredApproval) => void
  /**
   * Optional observability tap. Forwarded to each AcpClient so the
   * unfiltered ACP protocol stream + turn-boundary events are visible to
   * the host (e.g. the dev CLI capturing them to disk).
   */
  onTap?: (agentName: string, event: TapEvent) => void
  /**
   * Root directory under which each agent gets a per-agent state dir
   * (`<agentsDir>/<agentName>/`). Used by the AcpClient session store to
   * persist ACP `sessionId`s across daemon restarts. Optional: when unset,
   * session continuity across restarts is disabled.
   */
  agentsDir?: string
  /**
   * Per-agent factory that returns a `mcpServers[]` entry for the
   * `zooid-context` MCP server. Forwarded to each AcpClient. Agents bound to
   * transports without a context provider (e.g. HTTP) have no entry here.
   */
  contextSpawns?: Record<string, ContextSpawnFactory | undefined>
  /**
   * Per-agent resolved bind-mount list. Threaded into the AcpClient's spawn
   * spec; honoured by the docker runtime, ignored by the local runtime.
   */
  mounts?: Record<string, AcpMount[]>
  /**
   * Per-agent list of host directories to `mkdir -p` before the first
   * `runtime.spawn` for that agent. Subset of mount entries with `create: true`.
   */
  mkdirOnSpawn?: Record<string, string[]>
  /**
   * Per-agent override for the spawn-spec `cwd`. Set to e.g. `/workspace`
   * when the workspace mount is active; falls back to `agent.workdir`.
   */
  cwd?: Record<string, string>
}

export type ContextSpawnFactory = (
  threadId: string,
  channelId?: string,
) => Promise<{
  name: 'zooid-context'
  command: string
  args: string[]
  env: Array<{ name: string; value: string }>
}>

export class AcpAgentRegistry implements AcpRegistry {
  readonly opts: AcpAgentRegistryOptions
  private readonly clients = new Map<string, AcpClient>()

  onEvent: AcpRegistryEventHandler
  onApprovalRequest: AcpRegistryApprovalHandler

  constructor(opts: AcpAgentRegistryOptions) {
    this.opts = opts
    this.onEvent = opts.onEvent ?? (() => {})
    if (opts.onApprovalRequest) {
      this.onApprovalRequest = opts.onApprovalRequest
    } else if (opts.approvals) {
      const correlator = opts.approvals
      this.onApprovalRequest = async (name, req) => {
        const cfg = this.opts.agents[name]
        const handle = correlator.register(name, req.sessionId, req, {
          timeoutMs: cfg?.approval_timeout_ms ?? 0,
        })
        this.opts.onApprovalRegistered?.(handle)
        return handle.decisionPromise
      }
    } else {
      this.onApprovalRequest = async () => ({ decision: 'cancel' })
    }
  }

  hasAgent(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.opts.agents, name)
  }

  hasContextSpawn(name: string): boolean {
    return Boolean(this.opts.contextSpawns?.[name])
  }

  resolveSpawnEnv(name: string): Record<string, string> {
    return this.opts.env?.[name] ?? {}
  }

  resolveSpawnImage(name: string): string | undefined {
    return this.opts.image?.[name]
  }

  resolveSpawnMounts(name: string): AcpMount[] {
    return this.opts.mounts?.[name] ?? []
  }

  resolveSpawnCwd(name: string): string {
    return (
      this.opts.cwd?.[name] ??
      this.opts.agents[name]?.workdir ??
      process.cwd()
    )
  }

  agentNames(): string[] {
    return Object.keys(this.opts.agents)
  }

  getApprovalTimeoutMs(name: string): number {
    return this.opts.agents[name]?.approval_timeout_ms ?? 0
  }

  async ensureSession(name: string, threadId: string, channelId?: string): Promise<string> {
    if (!this.hasAgent(name)) throw new Error(`unknown agent: ${name}`)
    const client = await this.ensureClient(name)
    return client.ensureSession(threadId, channelId)
  }

  endSession(name: string, threadId: string): void {
    if (!this.hasAgent(name)) return
    const client = this.clients.get(name)
    client?.endSession(threadId)
  }

  async cancelSession(name: string, sessionId: string): Promise<void> {
    if (!this.hasAgent(name)) return
    const client = this.clients.get(name)
    // Always nudge the correlator first so any pending approvals resolve with
    // 'cancel' regardless of whether the client is alive or already stopped.
    this.opts.approvals?.cancelSession(sessionId)
    if (!client) return
    try {
      await client.cancel(sessionId)
    } catch (err) {
      // ACP cancel is a notification; failures here are typically transport
      // errors after the agent has already exited.
      console.warn(`[acp:${name}] cancel(${sessionId}) failed:`, err)
    }
  }

  async prompt(name: string, input: PromptInput): Promise<PromptResult> {
    if (!this.hasAgent(name)) throw new Error(`unknown agent: ${name}`)
    const client = await this.ensureClient(name)
    return client.prompt(input)
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled(
      [...this.clients.values()].map((c) => c.stop()),
    )
    this.clients.clear()
  }

  private async ensureClient(name: string): Promise<AcpClient> {
    const existing = this.clients.get(name)
    if (existing) return existing
    const cfg = this.opts.agents[name]
    if (!cfg.acp) throw new Error(`agents.${name}: missing acp block`)
    const spawn = resolveAcpAgentSpec(cfg.acp)
    for (const dir of this.opts.mkdirOnSpawn?.[name] ?? []) {
      mkdirSync(dir, { recursive: true })
    }
    const client = new AcpClient({
      agent: {
        id: name,
        command: spawn.command,
        args: spawn.args,
        env: this.opts.env?.[name],
        cwd: this.resolveSpawnCwd(name),
        image: this.opts.image?.[name],
        mounts: this.resolveSpawnMounts(name),
      },
      agentDataDir: this.opts.agentsDir ? join(this.opts.agentsDir, name) : undefined,
      runtime: this.opts.runtime,
      onEvent: (e) => this.onEvent(name, e),
      onApprovalRequest: (req) => this.onApprovalRequest(name, req),
      onTap: this.opts.onTap ? (e) => this.opts.onTap!(name, e) : undefined,
      contextSpawn: this.opts.contextSpawns?.[name],
    })
    await client.start()
    this.clients.set(name, client)
    return client
  }
}

export function resolveAcpAgentSpec(spec: AcpAgentSpec): {
  command: string
  args: string[]
} {
  if ('preset' in spec && spec.preset) {
    return resolvePreset(spec.preset, { model: spec.model })
  }
  if ('command' in spec && spec.command) {
    return { command: spec.command, args: spec.args ?? [] }
  }
  throw new Error('AcpAgentSpec: must specify either preset or command')
}

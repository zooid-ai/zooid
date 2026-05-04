import {
  AcpClient,
  resolvePreset,
  type AgentEvent,
  type ApprovalDecision,
  type ApprovalRequest,
  type PromptInput,
  type PromptResult,
} from '@zooid/acp-client'
import type { AcpAgentSpec, AcpRuntime } from './acp-types.js'
import type { AgentConfig } from './types.js'

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
  ensureSession(name: string, threadId: string): Promise<string>
  prompt(name: string, input: PromptInput): Promise<PromptResult>
  stopAll(): Promise<void>
  /** Set by the transport. Receives every ACP event from any agent. */
  onEvent: AcpRegistryEventHandler
  /** Set by the transport. Resolves permission requests. */
  onApprovalRequest: AcpRegistryApprovalHandler
}

export interface AcpAgentRegistryOptions {
  runtime: AcpRuntime
  agents: Record<string, AgentConfig>
  /** Per-agent env to forward to each `AcpClient`'s spawn spec. */
  forwardEnv?: Record<string, Record<string, string>>
  /** Initial event handler (the transport may overwrite at app creation). */
  onEvent?: AcpRegistryEventHandler
  /** Initial approval handler (the transport may overwrite at app creation). */
  onApprovalRequest?: AcpRegistryApprovalHandler
}

export class AcpAgentRegistry implements AcpRegistry {
  readonly opts: AcpAgentRegistryOptions
  private readonly clients = new Map<string, AcpClient>()

  onEvent: AcpRegistryEventHandler
  onApprovalRequest: AcpRegistryApprovalHandler

  constructor(opts: AcpAgentRegistryOptions) {
    this.opts = opts
    this.onEvent = opts.onEvent ?? (() => {})
    this.onApprovalRequest =
      opts.onApprovalRequest ?? (async () => ({ decision: 'cancel' }))
  }

  hasAgent(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.opts.agents, name)
  }

  async ensureSession(name: string, threadId: string): Promise<string> {
    if (!this.hasAgent(name)) throw new Error(`unknown agent: ${name}`)
    const client = await this.ensureClient(name)
    return client.ensureSession(threadId)
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
    const client = new AcpClient({
      agent: {
        id: name,
        command: spawn.command,
        args: spawn.args,
        env: this.opts.forwardEnv?.[name],
        cwd: cfg.workdir,
      },
      runtime: this.opts.runtime,
      onEvent: (e) => this.onEvent(name, e),
      onApprovalRequest: (req) => this.onApprovalRequest(name, req),
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
    return resolvePreset(spec.preset)
  }
  if ('command' in spec && spec.command) {
    return { command: spec.command, args: spec.args ?? [] }
  }
  throw new Error('AcpAgentSpec: must specify either preset or command')
}

import type { ChildProcess } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
} from '@agentclientprotocol/sdk'
import { AgentProcess } from './agent-process.js'
import { SessionMap } from './session-map.js'
import { resolvePreset } from './presets.js'
import {
  acpUpdateToAgentEvent,
  approvalDecisionToPermissionResponse,
} from './event-mapping.js'
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
  }): ChildProcess
}

export interface AcpClientOptions {
  agent: AgentConfig
  onEvent: (event: AgentEvent) => void
  onApprovalRequest: (req: ApprovalRequest) => Promise<ApprovalDecision>
  /**
   * If set, the runtime is used to spawn the ACP shim process instead of
   * the built-in `AgentProcess` host-spawn path. Lets the daemon launch
   * the shim inside a container (DockerAcpRuntime) without changing the
   * AcpClient surface.
   */
  runtime?: SpawnRuntime
}

export class AcpClient {
  private process: AgentProcess | null = null
  private runtimeChild: ChildProcess | null = null
  private connection: ClientSideConnection | null = null
  private readonly sessions = new SessionMap()
  private initialized = false

  constructor(private readonly options: AcpClientOptions) {}

  async start(): Promise<void> {
    const { command, args } = this.resolveSpawn()
    let stdout: Readable
    let stdin: Writable
    if (this.options.runtime) {
      const child = this.options.runtime.spawn({
        command,
        args,
        env: this.options.agent.env,
        cwd: this.options.agent.cwd,
      })
      this.runtimeChild = child
      if (!child.stdout || !child.stdin) {
        throw new Error('AcpClient: runtime returned a child without piped stdio')
      }
      stdout = child.stdout
      stdin = child.stdin
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
    }

    const input = Readable.toWeb(stdout) as ReadableStream<Uint8Array>
    const output = Writable.toWeb(stdin) as WritableStream<Uint8Array>
    const stream = ndJsonStream(output, input)

    this.connection = new ClientSideConnection(() => this.buildClient(), stream)

    await this.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: 'zooid', title: 'Zooid', version: '0.0.1' },
    })
    this.initialized = true
  }

  async stop(): Promise<void> {
    this.process?.kill()
    this.runtimeChild?.kill('SIGTERM')
    this.process = null
    this.runtimeChild = null
    this.connection = null
    this.initialized = false
  }

  async ensureSession(threadId: string): Promise<string> {
    if (!this.connection || !this.initialized) {
      throw new Error('AcpClient.start() must be called before ensureSession()')
    }
    const key = { threadId, agentId: this.options.agent.id }
    let session = this.sessions.get(key)
    if (!session) {
      const { sessionId } = await this.connection.newSession({
        cwd: this.options.agent.cwd ?? process.cwd(),
        mcpServers: [],
      })
      session = { sessionId, startedAt: Date.now() }
      this.sessions.set(key, session)
    }
    return session.sessionId
  }

  async prompt(input: PromptInput): Promise<PromptResult> {
    const sessionId = await this.ensureSession(input.threadId)
    const result = await this.connection!.prompt({
      sessionId,
      prompt: input.content,
    })
    return { stopReason: result.stopReason }
  }

  private resolveSpawn(): { command: string; args: string[] } {
    const { preset, command, args } = this.options.agent
    if (command) {
      return { command, args: args ?? [] }
    }
    if (preset) {
      return resolvePreset(preset)
    }
    throw new Error('AcpClient: agent must specify either `preset` or `command`')
  }

  private buildClient(): Client {
    return {
      sessionUpdate: async (params) => {
        const event = acpUpdateToAgentEvent(params)
        if (event) this.options.onEvent(event)
      },
      requestPermission: async (params) => {
        const decision = await this.options.onApprovalRequest({
          sessionId: params.sessionId,
          toolCallId: params.toolCall.toolCallId,
          options: params.options.map((o) => ({
            optionId: o.optionId,
            name: o.name,
            kind: o.kind,
          })),
        })
        return approvalDecisionToPermissionResponse(decision)
      },
    }
  }
}

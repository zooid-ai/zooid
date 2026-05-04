import { Readable, Writable } from 'node:stream'
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
} from '@agentclientprotocol/sdk'
import { AgentProcess } from './agent-process.js'
import { SessionMap } from './session-map.js'
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

export interface AcpClientOptions {
  agent: AgentConfig
  onEvent: (event: AgentEvent) => void
  onApprovalRequest: (req: ApprovalRequest) => Promise<ApprovalDecision>
}

export class AcpClient {
  private process: AgentProcess | null = null
  private connection: ClientSideConnection | null = null
  private readonly sessions = new SessionMap()
  private initialized = false

  constructor(private readonly options: AcpClientOptions) {}

  async start(): Promise<void> {
    this.process = new AgentProcess({
      command: this.options.agent.command,
      args: this.options.agent.args,
      env: this.options.agent.env,
      cwd: this.options.agent.cwd,
    })
    this.process.start()

    const input = Readable.toWeb(this.process.stdout) as ReadableStream<Uint8Array>
    const output = Writable.toWeb(this.process.stdin) as WritableStream<Uint8Array>
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
    this.process = null
    this.connection = null
    this.initialized = false
  }

  async prompt(input: PromptInput): Promise<PromptResult> {
    if (!this.connection || !this.initialized) {
      throw new Error('AcpClient.start() must be called before prompt()')
    }
    const key = { threadId: input.threadId, agentId: this.options.agent.id }
    let session = this.sessions.get(key)
    if (!session) {
      const { sessionId } = await this.connection.newSession({
        cwd: this.options.agent.cwd ?? process.cwd(),
        mcpServers: [],
      })
      session = { sessionId, startedAt: Date.now() }
      this.sessions.set(key, session)
    }

    const result = await this.connection.prompt({
      sessionId: session.sessionId,
      prompt: input.content,
    })
    return { stopReason: result.stopReason }
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

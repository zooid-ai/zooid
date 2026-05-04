import type {
  ContentBlock,
  PlanEntry,
  StopReason,
  ToolCallContent,
  ToolCallStatus,
  ToolKind,
} from '@agentclientprotocol/sdk'

export interface AgentConfig {
  id: string
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}

export interface PromptInput {
  threadId: string
  content: ContentBlock[]
}

export interface PromptResult {
  stopReason: StopReason
}

export type AgentEvent =
  | MessageChunkEvent
  | ToolCallEvent
  | ToolCallUpdateEvent
  | PlanEvent

export interface MessageChunkEvent {
  type: 'message_chunk'
  sessionId: string
  content: ContentBlock
}

export interface ToolCallEvent {
  type: 'tool_call'
  sessionId: string
  toolCallId: string
  title: string
  kind?: ToolKind
  status?: ToolCallStatus
}

export interface ToolCallUpdateEvent {
  type: 'tool_call_update'
  sessionId: string
  toolCallId: string
  status?: ToolCallStatus
  kind?: ToolKind
  content?: ToolCallContent[]
}

export interface PlanEvent {
  type: 'plan'
  sessionId: string
  entries: PlanEntry[]
}

export interface ApprovalRequest {
  sessionId: string
  toolCallId: string
  options: Array<{ optionId: string; name: string; kind: string }>
}

export type ApprovalDecision =
  | { decision: 'allow'; optionId: string }
  | { decision: 'cancel' }

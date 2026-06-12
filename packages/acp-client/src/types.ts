import type {
  ContentBlock,
  PlanEntry,
  StopReason,
  ToolCallContent,
  ToolCallStatus,
  ToolKind,
} from '@agentclientprotocol/sdk'

export type { ContentBlock }
import type { PresetName } from './presets.js'

/**
 * Structural copy of `@zooid/core`'s `AcpMount` shape. Kept here to avoid a
 * back-edge to core; both files describe the same `{ path, target, mode }`
 * tuple the docker runtime consumes.
 */
export interface AcpMountSpec {
  path: string
  target: string
  mode: 'ro' | 'rw'
}

export interface AgentConfig {
  id: string
  /** Short-hand for a known ACP harness. Resolves to command/args via the preset registry. */
  preset?: PresetName
  /** Optional model id, forwarded to the preset as `--model <id>` where supported. */
  model?: string
  /** Explicit command. Overrides whatever the preset would set. */
  command?: string
  /** Explicit args. Overrides whatever the preset would set. */
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  /** Container image. Forwarded to the spawn runtime; ignored by host-spawn paths. */
  image?: string
  /** Bind mounts. Forwarded to the spawn runtime; ignored by host-spawn paths. */
  mounts?: AcpMountSpec[]
}

export interface PromptInput {
  threadId: string
  /**
   * Channel/room id this thread lives in. Optional — when omitted, callers
   * (transports that don't model a separate channel, e.g. HTTP) treat
   * `threadId` as both. Matrix passes `evt.room_id` here so the
   * transport-context provider sees the real room.
   */
  channelId?: string
  content: ContentBlock[]
}

export interface PromptResult {
  stopReason: StopReason
}

export type AgentEvent =
  | AgentMessageChunkEvent
  | ToolCallEvent
  | ToolCallUpdateEvent
  | PlanEvent

export interface AgentMessageChunkEvent {
  type: 'agent_message_chunk'
  sessionId: string
  content: ContentBlock
  /**
   * Identifier of the assistant message this chunk belongs to, when the agent
   * supplies one (opencode does; Claude Code does not). Lets transports detect
   * message boundaries — a new id means a new message, which agents emit
   * without any delimiter chunk between them. Undefined when not provided.
   */
  messageId?: string
}

export interface ToolCallLocation {
  path: string
  line?: number
}

export interface ToolCallEvent {
  type: 'tool_call'
  sessionId: string
  toolCallId: string
  title: string
  kind?: ToolKind
  status?: ToolCallStatus
  rawInput?: unknown
  locations?: ToolCallLocation[]
}

export interface ToolCallUpdateEvent {
  type: 'tool_call_update'
  sessionId: string
  toolCallId: string
  status?: ToolCallStatus
  kind?: ToolKind
  content?: ToolCallContent[]
  rawInput?: unknown
  rawOutput?: unknown
  locations?: ToolCallLocation[]
}

export interface PlanEvent {
  type: 'plan'
  sessionId: string
  entries: PlanEntry[]
}

export interface ApprovalRequest {
  sessionId: string
  toolCallId: string
  /** ACP tool kind (e.g. "edit", "fetch", "execute"). */
  toolKind?: string
  /** Short human-readable title from the agent (e.g. "webfetch"). */
  toolTitle?: string
  /** Raw structured tool input, shape varies by kind. */
  toolInput?: unknown
  options: Array<{ optionId: string; name: string; kind: string }>
}

export type ApprovalDecision =
  | { decision: 'allow'; optionId: string }
  | { decision: 'cancel' }

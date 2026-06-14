import type {
  RequestPermissionResponse,
  SessionNotification,
  ToolCallContent,
  ToolCallStatus,
  ToolKind,
} from '@agentclientprotocol/sdk'
import type { AgentEvent, ApprovalDecision } from './types.js'

export function acpUpdateToAgentEvent(
  notif: SessionNotification,
): AgentEvent | null {
  const { sessionId, update } = notif
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      return {
        type: 'agent_message_chunk',
        sessionId,
        content: update.content,
        // `messageId` is not part of the ACP `agent_message_chunk` schema, but
        // opencode includes it. Forward it so transports can split on message
        // boundaries; harmlessly undefined for agents that omit it.
        messageId: (update as { messageId?: string }).messageId,
      }
    case 'tool_call':
      return {
        type: 'tool_call',
        sessionId,
        toolCallId: update.toolCallId,
        title: update.title,
        kind: update.kind,
        status: update.status,
        rawInput: update.rawInput,
        locations: mapLocations(update.locations),
      }
    case 'tool_call_update':
      return {
        type: 'tool_call_update',
        sessionId,
        toolCallId: update.toolCallId,
        status: nullToUndef<ToolCallStatus>(update.status),
        kind: nullToUndef<ToolKind>(update.kind),
        content: nullToUndef<ToolCallContent[]>(update.content),
        rawInput: update.rawInput,
        rawOutput: update.rawOutput,
        locations: mapLocations(update.locations),
      }
    case 'plan':
      return { type: 'plan', sessionId, entries: update.entries }
    case 'available_commands_update': {
      const u = update as { availableCommands?: Array<{ name: string; description: string }> }
      return {
        type: 'available_commands',
        sessionId,
        commands: (u.availableCommands ?? []).map((c) => ({
          name: c.name,
          description: c.description,
        })),
      }
    }
    default:
      return null
  }
}

export function approvalDecisionToPermissionResponse(
  decision: ApprovalDecision,
): RequestPermissionResponse {
  if (decision.decision === 'cancel') {
    return { outcome: { outcome: 'cancelled' } }
  }
  return { outcome: { outcome: 'selected', optionId: decision.optionId } }
}

function nullToUndef<T>(v: T | null | undefined): T | undefined {
  return v ?? undefined
}

function mapLocations(
  locs: Array<{ path: string; line?: number | null }> | null | undefined,
): { path: string; line?: number }[] | undefined {
  if (!locs || locs.length === 0) return undefined
  return locs.map((l) => ({ path: l.path, line: l.line ?? undefined }))
}

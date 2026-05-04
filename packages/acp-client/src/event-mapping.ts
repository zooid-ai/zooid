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
        type: 'message_chunk',
        sessionId,
        content: update.content,
      }
    case 'tool_call':
      return {
        type: 'tool_call',
        sessionId,
        toolCallId: update.toolCallId,
        title: update.title,
        kind: update.kind,
        status: update.status,
      }
    case 'tool_call_update':
      return {
        type: 'tool_call_update',
        sessionId,
        toolCallId: update.toolCallId,
        status: nullToUndef<ToolCallStatus>(update.status),
        kind: nullToUndef<ToolKind>(update.kind),
        content: nullToUndef<ToolCallContent[]>(update.content),
      }
    case 'plan':
      return { type: 'plan', sessionId, entries: update.entries }
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

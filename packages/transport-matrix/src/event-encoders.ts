import type {
  PlanEvent,
  ToolCallEvent,
  ToolCallUpdateEvent,
} from '@zooid/acp-client'

export function toToolCallBody(evt: ToolCallEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {
    session_id: evt.sessionId,
    tool_call_id: evt.toolCallId,
    title: evt.title,
  }
  if (evt.kind !== undefined) out.kind = evt.kind
  if (evt.status !== undefined) out.status = evt.status
  return out
}

export function toUpdateBody(evt: ToolCallUpdateEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {
    session_id: evt.sessionId,
    tool_call_id: evt.toolCallId,
  }
  if (evt.status !== undefined) out.status = evt.status
  if (evt.kind !== undefined) out.kind = evt.kind
  if (evt.content !== undefined) out.content = evt.content
  return out
}

export function toPlanBody(evt: PlanEvent): Record<string, unknown> {
  return {
    session_id: evt.sessionId,
    entries: evt.entries,
  }
}

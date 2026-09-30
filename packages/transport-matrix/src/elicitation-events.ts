import type { ElicitationResolution, PendingElicitation } from '@zooid/core'

export const ElicitationEventType = {
  Request: 'dev.zooid.elicitation_request',
  Response: 'dev.zooid.elicitation_response',
  Resolved: 'dev.zooid.elicitation_resolved',
  Rejected: 'dev.zooid.elicitation_rejected',
} as const

const inThread = (root: string) => ({ 'm.relates_to': { rel_type: 'm.thread', event_id: root } })

export function toElicitationRequestBody(r: PendingElicitation): Record<string, unknown> {
  return {
    version: 1,
    request_id: r.requestId,
    session_id: r.sessionId,
    ...(r.toolCallId ? { tool_call_id: r.toolCallId } : {}),
    message: r.message,
    // The ACP schema travels untouched — property names and _meta included.
    requested_schema: r.requestedSchema,
    ...(r.meta ? { meta: r.meta } : {}),
    // Fallback for clients that can't render the form (and push previews).
    body: `❓ ${r.message}`,
    ...inThread(r.threadRoot),
  }
}

export function toElicitationResolvedBody(res: ElicitationResolution): Record<string, unknown> {
  return {
    version: 1,
    request_id: res.record.requestId,
    request_event_id: res.record.requestEventId,
    status: res.status,
    ...(res.content ? { content: res.content } : {}),
    ...(res.respondedBy ? { responded_by: res.respondedBy } : {}),
    ...(res.responseEventId ? { response_event_id: res.responseEventId } : {}),
    ...(res.reason ? { reason: res.reason } : {}),
    ...inThread(res.record.threadRoot),
  }
}

export function toElicitationRejectedBody(o: {
  record: PendingElicitation
  responseEventId: string
  reason: 'invalid' | 'stale'
  errors?: Record<string, string>
}): Record<string, unknown> {
  return {
    version: 1,
    request_id: o.record.requestId,
    request_event_id: o.record.requestEventId,
    response_event_id: o.responseEventId,
    reason: o.reason,
    ...(o.errors ? { errors: o.errors } : {}),
    ...inThread(o.record.threadRoot),
  }
}

export interface ParsedElicitationResponse {
  requestId: string
  requestEventId: string
  action: 'accept' | 'decline' | 'cancel'
  content?: unknown
  threadRoot: string
}

/** Envelope only. Any session_id in the content is ignored on purpose. */
export function parseElicitationResponse(evt: { content?: Record<string, unknown> }): ParsedElicitationResponse | null {
  const c = evt.content ?? {}
  const rel = c['m.relates_to'] as { rel_type?: string; event_id?: string } | undefined
  if (rel?.rel_type !== 'm.thread' || !rel.event_id) return null
  if (typeof c.request_id !== 'string' || typeof c.request_event_id !== 'string') return null
  if (c.action !== 'accept' && c.action !== 'decline' && c.action !== 'cancel') return null
  return {
    requestId: c.request_id,
    requestEventId: c.request_event_id,
    action: c.action,
    ...(c.action === 'accept' ? { content: c.content === undefined ? {} : c.content } : {}),
    threadRoot: rel.event_id,
  }
}

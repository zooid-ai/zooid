import { RequestError, type CreateElicitationRequest } from '@agentclientprotocol/sdk'
import type { ElicitationRequest, ElicitationSchema } from './types.js'

/**
 * Thrown for an elicitation Zooid will not present (wrong mode or scope, no
 * Matrix destination, unsupported schema). Answered as JSON-RPC -32602 so the
 * harness fails the question promptly instead of waiting forever.
 */
export class ElicitationUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ElicitationUnsupportedError'
  }
}

export function toElicitationRequest(params: CreateElicitationRequest): ElicitationRequest {
  const p = params as {
    mode?: string
    sessionId?: string
    toolCallId?: string | null
    message: string
    requestedSchema?: unknown
    _meta?: Record<string, unknown> | null
  }
  if (p.mode !== 'form') {
    throw new ElicitationUnsupportedError(`elicitation mode "${String(p.mode)}" is not supported (form only)`)
  }
  if (typeof p.sessionId !== 'string' || p.sessionId === '') {
    throw new ElicitationUnsupportedError('request-scoped elicitation is not supported; a sessionId is required')
  }
  if (!p.requestedSchema || typeof p.requestedSchema !== 'object') {
    throw new ElicitationUnsupportedError('form elicitation requires requestedSchema')
  }
  return {
    sessionId: p.sessionId,
    ...(p.toolCallId ? { toolCallId: p.toolCallId } : {}),
    message: p.message,
    requestedSchema: p.requestedSchema as ElicitationSchema,
    ...(p._meta ? { meta: p._meta } : {}),
  }
}

export function toRpcError(err: unknown): unknown {
  return err instanceof ElicitationUnsupportedError
    ? RequestError.invalidParams(undefined, err.message)
    : err
}

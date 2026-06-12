import { RequestError } from '@agentclientprotocol/sdk'

export type ErrorCode =
  | 'auth_missing'
  | 'auth_invalid'
  | 'model_rate_limit'
  | 'model_unavailable'
  | 'image_pull_failed'
  | 'mount_failed'
  | 'container_exit'
  | 'acp_protocol'
  | 'permission_denied'
  | 'media_failed'
  | 'internal'

export interface Classified {
  code: ErrorCode
  transient: boolean
  /** Verbatim ACP RequestError triple — forwarded into eco.zoon.error.acp_error. */
  acp_error?: { code: number; message: string; data?: unknown }
}

const PROTOCOL_CODES = new Set([-32700, -32600, -32601, -32602])

export function classify(err: unknown): Classified {
  if (err instanceof RequestError) {
    const acp_error = { code: err.code, message: err.message, data: err.data }
    if (PROTOCOL_CODES.has(err.code)) return { code: 'acp_protocol', transient: false, acp_error }
    if (err.code === -32603) return { code: 'internal', transient: false, acp_error }
    // -32002 (spec authRequired) → auth_missing
    if (err.code === -32002) return { code: 'auth_missing', transient: false, acp_error }
    // -32000…-32099 generic: classify by message
    const m = err.message
    if (/^auth(entication)? required$/i.test(m)) {
      return { code: 'auth_missing', transient: false, acp_error }
    }
    if (/\b(token|api ?key|credential)\b/i.test(m) && /\b(invalid|expired|revoked)\b/i.test(m)) {
      return { code: 'auth_invalid', transient: false, acp_error }
    }
    if (/\brate ?limit\b|\b429\b/i.test(m)) {
      return { code: 'model_rate_limit', transient: true, acp_error }
    }
    if (/\b5\d\d\b|\boverloaded\b|\bunavailable\b|\bunknown model\b/i.test(m)) {
      return { code: 'model_unavailable', transient: true, acp_error }
    }
    return { code: 'internal', transient: false, acp_error }
  }

  // Out-of-band errors (no RequestError → no acp_error).
  if (err instanceof Error) {
    const m = err.message
    if (/error while creating mount source path|mkdir .* permission denied/i.test(m)) {
      return { code: 'mount_failed', transient: false }
    }
    if (/^image prepull failed/i.test(m)) {
      return { code: 'image_pull_failed', transient: true }
    }
    if (/ACP connection closed/i.test(m)) {
      return { code: 'container_exit', transient: true }
    }
  }

  return { code: 'internal', transient: false }
}

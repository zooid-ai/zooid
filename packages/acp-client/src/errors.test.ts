import { describe, it, expect } from 'vitest'
import { RequestError } from '@agentclientprotocol/sdk'
import { classify } from './errors.js'

describe('classify — RequestError', () => {
  it('claude-agent-acp -32000 "Authentication required" → auth_missing', () => {
    const err = new RequestError(-32000, 'Authentication required', undefined)
    const r = classify(err)
    expect(r.code).toBe('auth_missing')
    expect(r.transient).toBe(false)
    expect(r.acp_error).toEqual({
      code: -32000,
      message: 'Authentication required',
      data: undefined,
    })
  })

  it('-32002 (spec-compliant authRequired) → auth_missing', () => {
    const err = RequestError.authRequired()
    expect(classify(err).code).toBe('auth_missing')
  })

  it('invalid/expired/revoked credential → auth_invalid', () => {
    expect(classify(new RequestError(-32000, 'API key invalid')).code).toBe('auth_invalid')
    expect(classify(new RequestError(-32000, 'token expired')).code).toBe('auth_invalid')
    expect(classify(new RequestError(-32000, 'credential revoked')).code).toBe('auth_invalid')
  })

  it('rate limit → model_rate_limit (transient)', () => {
    const r = classify(new RequestError(-32000, 'rate limit exceeded'))
    expect(r.code).toBe('model_rate_limit')
    expect(r.transient).toBe(true)
  })

  it('5xx / overloaded / unknown model → model_unavailable (transient)', () => {
    expect(classify(new RequestError(-32000, 'upstream 503')).code).toBe('model_unavailable')
    expect(classify(new RequestError(-32000, 'service overloaded')).code).toBe('model_unavailable')
    expect(classify(new RequestError(-32000, 'unknown model claude-5')).code).toBe('model_unavailable')
  })

  it('JSON-RPC standard codes → acp_protocol', () => {
    for (const code of [-32700, -32600, -32601, -32602]) {
      expect(classify(new RequestError(code, 'malformed')).code).toBe('acp_protocol')
    }
  })

  it('-32603 (internal JSON-RPC error) → internal', () => {
    expect(classify(new RequestError(-32603, 'internal')).code).toBe('internal')
  })

  it('preserves acp_error verbatim including data', () => {
    const err = new RequestError(-32000, 'something', { trace: 'abc' })
    expect(classify(err).acp_error).toEqual({
      code: -32000,
      message: 'something',
      data: { trace: 'abc' },
    })
  })

  it('unmatched -32000…-32099 message → internal (not auth-mis-fire)', () => {
    expect(classify(new RequestError(-32000, 'gobbledygook')).code).toBe('internal')
  })
})

describe('classify — out-of-band errors', () => {
  it('mount-failed engine error → mount_failed (non-transient)', () => {
    const err = new Error(
      "docker: Error response from daemon: error while creating mount source path '/home/zooid/.codex': mkdir /home/zooid/.codex: permission denied",
    )
    const r = classify(err)
    expect(r.code).toBe('mount_failed')
    expect(r.transient).toBe(false)
    expect(r.acp_error).toBeUndefined()
  })

  it('image pull failure → image_pull_failed (transient)', () => {
    const err = new Error(
      'image prepull failed for ghcr.io/zooid-ai/agent-codex:latest:\nmanifest unknown',
    )
    expect(classify(err).code).toBe('image_pull_failed')
    expect(classify(err).transient).toBe(true)
  })

  it('ACP stream closed → container_exit (transient)', () => {
    const err = new Error('ACP connection closed')
    expect(classify(err).code).toBe('container_exit')
    expect(classify(err).transient).toBe(true)
  })

  it('unmatched error → internal with String(err) preserved', () => {
    const r = classify(new Error('weird thing happened'))
    expect(r.code).toBe('internal')
    expect(r.transient).toBe(false)
  })

  it('non-Error thrown value → internal', () => {
    expect(classify('a bare string').code).toBe('internal')
    expect(classify(null).code).toBe('internal')
    expect(classify(undefined).code).toBe('internal')
  })
})

import { describe, it, expect } from 'vitest'
import { RequestError } from '@agentclientprotocol/sdk'
import {
  ElicitationUnsupportedError,
  toElicitationRequest,
  toRpcError,
} from './elicitation.js'

const schema = {
  type: 'object' as const,
  properties: { env: { type: 'string' as const, enum: ['staging', 'prod'] } },
  required: ['env'],
}

describe('toElicitationRequest', () => {
  it('maps a session-scoped form request, keeping schema and _meta intact', () => {
    const req = toElicitationRequest({
      mode: 'form',
      sessionId: 's1',
      toolCallId: 'tc1',
      message: 'Which environment?',
      requestedSchema: schema,
      _meta: { vendor: { x: 1 } },
    } as never)
    expect(req).toEqual({
      sessionId: 's1',
      toolCallId: 'tc1',
      message: 'Which environment?',
      requestedSchema: schema,
      meta: { vendor: { x: 1 } },
    })
  })

  it('omits toolCallId when the agent sends null', () => {
    const req = toElicitationRequest({
      mode: 'form', sessionId: 's1', toolCallId: null, message: 'q', requestedSchema: schema,
    } as never)
    expect(req).not.toHaveProperty('toolCallId')
  })

  it('rejects url mode', () => {
    expect(() =>
      toElicitationRequest({ mode: 'url', sessionId: 's1', message: 'm', url: 'https://x', elicitationId: 'e' } as never),
    ).toThrow(ElicitationUnsupportedError)
  })

  it('rejects request-scoped forms (no sessionId)', () => {
    expect(() =>
      toElicitationRequest({ mode: 'form', requestId: 7, message: 'm', requestedSchema: schema } as never),
    ).toThrow(/sessionId/)
  })

  it('rejects a form without requestedSchema', () => {
    expect(() =>
      toElicitationRequest({ mode: 'form', sessionId: 's1', message: 'm' } as never),
    ).toThrow(/requestedSchema/)
  })
})

describe('toRpcError', () => {
  it('turns ElicitationUnsupportedError into -32602 invalid params', () => {
    const out = toRpcError(new ElicitationUnsupportedError('nope'))
    expect(out).toBeInstanceOf(RequestError)
    expect((out as RequestError).code).toBe(-32602)
    expect((out as RequestError).message).toMatch(/nope/)
  })

  it('passes other errors through untouched', () => {
    const e = new Error('boom')
    expect(toRpcError(e)).toBe(e)
  })
})

// Session-level cleanup must work even when the harness doesn't emit a
// per-request cancellation notification of its own.
describe('session cancellation of pending questions', () => {
  it('cancels a waiting handler directly when the session is interrupted', async () => {
    const { AcpClient } = await import('./acp-client.js')
    const client = new AcpClient({
      agent: { id: 'a', command: '/bin/true' },
      onEvent: () => {},
      onApprovalRequest: async () => ({ decision: 'cancel' }),
      onElicitationRequest: (_req, signal) => new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve({ action: 'cancel' }), { once: true })
      }),
    })
    const internal = client as unknown as {
      onElicitation(params: unknown, signal: AbortSignal): Promise<unknown>
    }
    const pending = internal.onElicitation({ mode: 'form', sessionId: 's', message: 'q', requestedSchema: schema }, new AbortController().signal)
    await client.cancel('s')
    await expect(pending).resolves.toEqual({ action: 'cancel' })
  })
})

import { describe, it, expect } from 'vitest'
import {
  ElicitationEventType,
  parseElicitationResponse,
  toElicitationRejectedBody,
  toElicitationRequestBody,
  toElicitationResolvedBody,
} from './elicitation-events.js'

const record = {
  requestId: 'e1', agentName: 'architect', sessionId: 's1', sessionKey: '$root',
  roomId: '!r', threadRoot: '$root', toolCallId: 'tc1', message: 'Which env?',
  requestedSchema: {
    type: 'object' as const,
    properties: { question_0: { type: 'string' as const, oneOf: [{ const: 'a', title: 'A' }], _meta: { k: 1 } } },
  },
  meta: { vendor: true },
  state: 'pending' as const,
}

describe('elicitation event encoders', () => {
  it('encodes the request with a snake_case envelope and the ACP schema untouched', () => {
    expect(toElicitationRequestBody(record)).toEqual({
      version: 1,
      request_id: 'e1',
      session_id: 's1',
      tool_call_id: 'tc1',
      message: 'Which env?',
      requested_schema: record.requestedSchema,
      meta: { vendor: true },
      body: '❓ Which env?',
      'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
    })
  })

  it('omits tool_call_id and meta when absent', () => {
    const { toolCallId: _t, meta: _m, ...bare } = record
    const body = toElicitationRequestBody(bare)
    expect(body).not.toHaveProperty('tool_call_id')
    expect(body).not.toHaveProperty('meta')
  })

  it('encodes resolved with responder and reason', () => {
    expect(
      toElicitationResolvedBody({
        record: { ...record, requestEventId: '$ereq' },
        status: 'accepted', respondedBy: '@alice:x', responseEventId: '$resp',
      }),
    ).toEqual({
      version: 1,
      request_id: 'e1',
      request_event_id: '$ereq',
      status: 'accepted',
      responded_by: '@alice:x',
      response_event_id: '$resp',
      'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
    })
    expect(
      toElicitationResolvedBody({ record: { ...record, requestEventId: '$ereq' }, status: 'cancelled', reason: 'clear' }),
    ).toMatchObject({ status: 'cancelled', reason: 'clear' })
  })

  it('encodes rejected feedback', () => {
    expect(
      toElicitationRejectedBody({
        record: { ...record, requestEventId: '$ereq' },
        responseEventId: '$resp', reason: 'invalid', errors: { question_0: 'required' },
      }),
    ).toEqual({
      version: 1,
      request_id: 'e1',
      request_event_id: '$ereq',
      response_event_id: '$resp',
      reason: 'invalid',
      errors: { question_0: 'required' },
      'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
    })
  })

  it('exposes the four event types', () => {
    expect(ElicitationEventType).toEqual({
      Request: 'dev.zooid.elicitation_request',
      Response: 'dev.zooid.elicitation_response',
      Resolved: 'dev.zooid.elicitation_resolved',
      Rejected: 'dev.zooid.elicitation_rejected',
    })
  })
})

describe('parseElicitationResponse', () => {
  const evt = (content: Record<string, unknown>) => ({
    type: 'dev.zooid.elicitation_response',
    event_id: '$resp', room_id: '!r', sender: '@alice:x',
    content: { 'm.relates_to': { rel_type: 'm.thread', event_id: '$root' }, ...content },
  })

  it('parses accept with content', () => {
    expect(
      parseElicitationResponse(evt({ request_id: 'e1', request_event_id: '$ereq', action: 'accept', content: { a: 1 } })),
    ).toEqual({ requestId: 'e1', requestEventId: '$ereq', action: 'accept', content: { a: 1 }, threadRoot: '$root' })
  })

  it('parses decline and cancel without content', () => {
    expect(parseElicitationResponse(evt({ request_id: 'e1', request_event_id: '$ereq', action: 'decline' })))
      .toMatchObject({ action: 'decline' })
    expect(parseElicitationResponse(evt({ request_id: 'e1', request_event_id: '$ereq', action: 'cancel' })))
      .toMatchObject({ action: 'cancel' })
  })

  it('ignores a session_id supplied by the client', () => {
    const p = parseElicitationResponse(
      evt({ request_id: 'e1', request_event_id: '$ereq', action: 'decline', session_id: 'evil' }),
    )
    expect(p).not.toHaveProperty('sessionId')
  })

  it('returns null for malformed responses', () => {
    expect(parseElicitationResponse(evt({ request_event_id: '$ereq', action: 'accept' }))).toBeNull()
    expect(parseElicitationResponse(evt({ request_id: 'e1', action: 'accept' }))).toBeNull()
    expect(parseElicitationResponse(evt({ request_id: 'e1', request_event_id: '$e', action: 'maybe' }))).toBeNull()
    expect(parseElicitationResponse({ ...evt({ request_id: 'e1', request_event_id: '$e', action: 'decline' }), content: { request_id: 'e1', request_event_id: '$e', action: 'decline' } })).toBeNull() // no thread relation
  })

  it('treats accept without content as an empty answer object', () => {
    expect(
      parseElicitationResponse(evt({ request_id: 'e1', request_event_id: '$ereq', action: 'accept' })),
    ).toMatchObject({ action: 'accept', content: {} })
  })
})

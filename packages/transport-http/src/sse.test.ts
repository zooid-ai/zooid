import { describe, it, expect } from 'vitest'
import type { SessionEvent } from '@zooid/agentd-core'
import { serializeEvent, parseEventStream } from './sse.js'

describe('serializeEvent', () => {
  it('serializes a session.started frame', () => {
    const frame = serializeEvent({ type: 'session.started', session_id: '01JQXYZ' })
    expect(frame).toBe('data: {"type":"session.started","session_id":"01JQXYZ"}\n\n')
  })

  it('serializes a stdout frame', () => {
    const frame = serializeEvent({ type: 'stdout', chunks: ['hello', 'world'] })
    expect(frame).toBe('data: {"type":"stdout","chunks":["hello","world"]}\n\n')
  })

  it('serializes a session.ended frame with exit code', () => {
    const frame = serializeEvent({ type: 'session.ended', exit_code: 0 })
    expect(frame).toBe('data: {"type":"session.ended","exit_code":0}\n\n')
  })

  it('serializes a session.ended frame with reason', () => {
    const frame = serializeEvent({
      type: 'session.ended',
      exit_code: 1,
      reason: 'pre_start failed: exit 128',
    })
    expect(frame).toContain('"reason":"pre_start failed: exit 128"')
  })
})

describe('parseEventStream (test helper)', () => {
  it('round-trips a sequence of events', () => {
    const events: SessionEvent[] = [
      { type: 'session.started', session_id: 'abc' },
      { type: 'stdout', chunks: ['one', 'two'] },
      { type: 'session.ended', exit_code: 0 },
    ]
    const serialized = events.map(serializeEvent).join('')
    expect(parseEventStream(serialized)).toEqual(events)
  })
})

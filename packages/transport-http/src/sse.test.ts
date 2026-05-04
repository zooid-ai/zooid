import { describe, it, expect } from 'vitest'
import type { SessionEvent } from '@zooid/core'
import { serializeEvent, parseEventStream } from './sse.js'

describe('serializeEvent', () => {
  it('serializes a session.start frame', () => {
    const frame = serializeEvent({ type: 'session.start', session_id: '01JQXYZ' })
    expect(frame).toBe('data: {"type":"session.start","session_id":"01JQXYZ"}\n\n')
  })

  it('serializes a stdout frame', () => {
    const frame = serializeEvent({ type: 'stdout', chunks: ['hello', 'world'] })
    expect(frame).toBe('data: {"type":"stdout","chunks":["hello","world"]}\n\n')
  })

  it('serializes a turn.end frame with exit code', () => {
    const frame = serializeEvent({ type: 'turn.end', exit_code: 0 })
    expect(frame).toBe('data: {"type":"turn.end","exit_code":0}\n\n')
  })

  it('serializes a turn.end frame with reason', () => {
    const frame = serializeEvent({
      type: 'turn.end',
      exit_code: 1,
      reason: 'pre_turn failed: exit 128',
    })
    expect(frame).toContain('"reason":"pre_turn failed: exit 128"')
  })
})

describe('parseEventStream (test helper)', () => {
  it('round-trips a sequence of events', () => {
    const events: SessionEvent[] = [
      { type: 'session.start', session_id: 'abc' },
      { type: 'turn.start' },
      { type: 'stdout', chunks: ['one', 'two'] },
      { type: 'turn.end', exit_code: 0 },
    ]
    const serialized = events.map(serializeEvent).join('')
    expect(parseEventStream(serialized)).toEqual(events)
  })
})

import { describe, expect, it } from 'vitest'
import { buildPushPayload, MAX_BODY } from './payload.js'
import type { PushNotification } from './types.js'

const base: PushNotification = {
  event_id: '$evt:example.org',
  room_id: '!room:example.org',
  room_name: 'general',
  sender_display_name: 'Alice',
  type: 'm.room.message',
  content: { msgtype: 'm.text', body: 'hello there' },
  counts: { unread: 3 },
  devices: [],
}

describe('buildPushPayload', () => {
  it('carries the fields the service worker renders', () => {
    expect(buildPushPayload(base)).toEqual({
      event_id: '$evt:example.org',
      room_id: '!room:example.org',
      room_name: 'general',
      sender_display_name: 'Alice',
      type: 'm.room.message',
      body: 'hello there',
      unread: 3,
      sound: false,
    })
  })

  it('truncates a long body rather than shipping the whole message', () => {
    const long = 'x'.repeat(MAX_BODY + 50)
    const out = buildPushPayload({ ...base, content: { msgtype: 'm.text', body: long } })
    expect(out.body!.length).toBe(MAX_BODY)
    expect(out.body!.endsWith('…')).toBe(true)
  })

  it('omits body for an agent event that carries no prose', () => {
    const out = buildPushPayload({
      ...base,
      type: 'dev.zooid.turn.end',
      content: { produced_output: true },
    })
    expect(out.type).toBe('dev.zooid.turn.end')
    expect(out.body).toBeUndefined()
  })

  it('sets sound from the push rule tweak, not from the event type', () => {
    const device = { app_id: 'dev.zooid.web', pushkey: 'pk', tweaks: { sound: 'default' } }
    const out = buildPushPayload({ ...base, type: 'dev.zooid.turn.end', content: {} }, device)
    expect(out.sound).toBe(true)
  })

  it('tolerates a notification with no counts and no display name', () => {
    const out = buildPushPayload({
      event_id: '$e',
      room_id: '!r:example.org',
      type: 'm.room.message',
      content: { msgtype: 'm.text', body: 'hi' },
      devices: [],
    })
    expect(out.unread).toBe(0)
    expect(out.room_name).toBe('!r:example.org')
    expect(out.sender_display_name).toBeUndefined()
  })
})

import { describe, it, expect, vi } from 'vitest'
import { joinTriggerRooms } from './trigger-rooms.js'
import { loadZooidConfig } from '@zooid/core'

const yaml = `
runtime: local
transports:
  matrix:
    type: matrix
    homeserver: http://localhost:8448
    as_token: t
    hs_token: h
    user_namespace: '@.*:example.org'
agents:
  product:
    acp: { preset: opencode }
    matrix: { rooms: ["#product:example.org"] }
triggers:
  github:
    webhook: { provider: github, secret: "s" }
    as: "@hook:example.org"
    messages:
      - { room: "#product:example.org", mention: product, text: 'a' }
      - { room: "#ops:example.org", mention: product, text: 'b' }
  weekly:
    schedule: "0 6 * * 1"
    as: "@cron:example.org"
    room: "#product:example.org"
    mention: product
    text: 'c'
`

describe('joinTriggerRooms', () => {
  it('joins every declared room of every trigger, once per (bot, room)', async () => {
    const ensureBot = vi.fn(async () => {})
    await joinTriggerRooms({
      triggers: loadZooidConfig(yaml).triggers,
      resolveRoom: async (r: string) => r,
      ensureBot,
    })
    expect(ensureBot.mock.calls.sort()).toEqual(
      [
        ['@cron:example.org', '#product:example.org'],
        ['@hook:example.org', '#ops:example.org'],
        ['@hook:example.org', '#product:example.org'],
      ].sort(),
    )
  })

  it('reports a room it cannot join instead of throwing, so one bad room does not stop the daemon', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await joinTriggerRooms({
      triggers: loadZooidConfig(yaml).triggers,
      resolveRoom: async (r: string) => (r === '#ops:example.org' ? null : r),
      ensureBot: async () => {},
    })
    expect(warn.mock.calls.flat().join(' ')).toMatch(/#ops:example\.org/)
    warn.mockRestore()
  })
})

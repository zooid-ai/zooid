import { describe, it, expect } from 'vitest'
import { loadZooidConfig } from '@zooid/core'
import { ignoredHooksWarning } from './ignored-hooks.js'

describe('ignoredHooksWarning', () => {
  it('is null when no agent has hooks', () => {
    expect(ignoredHooksWarning({ a: { hooks: {} }, b: { hooks: {} } })).toBeNull()
  })

  it('is null when there are no agents', () => {
    expect(ignoredHooksWarning({})).toBeNull()
  })

  it('names each agent with its hook keys and says they are not executed', () => {
    const msg = ignoredHooksWarning({
      a: { hooks: { pre_turn: 'git pull' } },
      b: { hooks: { pre_turn: 'x', post_turn: 'y' } },
      c: { hooks: {} },
    })!
    expect(msg).toContain('a: pre_turn')
    expect(msg).toContain('b: pre_turn, post_turn')
    expect(msg).not.toContain('c:')
    expect(msg).toContain('does not execute')
    expect(msg).toContain('settings.json')
    expect(msg).toContain('opencode plugins')
  })

  it('works over a loaded config: workforce-wide hooks count, per-agent null-disable does not', () => {
    const config = loadZooidConfig(`
runtime: local
transports:
  http-local: { type: http }
hooks:
  pre_turn: "git pull"
agents:
  qa:
    acp: { preset: claude }
    http: { transport: http-local }
  quiet:
    acp: { preset: claude }
    http: { transport: http-local }
    hooks:
      pre_turn: null
`)
    const msg = ignoredHooksWarning(config.agents)!
    expect(msg).toContain('qa: pre_turn')
    expect(msg).not.toContain('quiet')
  })
})

import { describe, it, expect } from 'vitest'
import { HANDOFF_FIELD } from '@zooid/core'
import { buildHandoffContent, readHandoff, resolveHandoffTarget, type HandoffCandidate } from './handoff.js'

const room = '!r:hs'
const candidates: HandoffCandidate[] = [
  { userId: '@laptop.architect:hs', name: 'architect', workstation: 'laptop', rooms: [room] },
  { userId: '@laptop.cpo:hs', name: 'cpo', workstation: 'laptop', rooms: [room] },
  { userId: '@cloud.product:hs', name: 'product', workstation: 'cloud', rooms: [room] },
  { userId: '@cloud.scout:hs', name: 'scout', workstation: 'cloud', rooms: ['!elsewhere:hs'] },
  // Same agent name on two workstations: a bare name is ambiguous.
  { userId: '@laptop.ops:hs', name: 'ops', workstation: 'laptop', rooms: [room] },
  { userId: '@cloud.ops:hs', name: 'ops', workstation: 'cloud', rooms: [room] },
]

describe('buildHandoffContent', () => {
  it('is a visible mention of the callee carrying the structured call', () => {
    const c = buildHandoffContent({
      callId: 'call-1',
      caller: '@laptop.architect:hs',
      callee: '@cloud.product:hs',
      prompt: 'write the spec',
    })
    expect(c.msgtype).toBe('m.notice')
    expect(c.body).toBe('@cloud.product:hs write the spec')
    expect(c['m.mentions']).toEqual({ user_ids: ['@cloud.product:hs'] })
    expect(c[HANDOFF_FIELD]).toEqual({
      version: 1,
      call_id: 'call-1',
      caller: '@laptop.architect:hs',
      callee: '@cloud.product:hs',
    })
  })
})

describe('readHandoff', () => {
  const valid = { version: 1, call_id: 'c', caller: '@a:hs', callee: '@b:hs' }
  it('reads a well-formed handoff field', () => {
    expect(readHandoff({ [HANDOFF_FIELD]: valid })).toEqual(valid)
  })
  it.each([
    ['no field', {}],
    ['unknown version', { [HANDOFF_FIELD]: { ...valid, version: 2 } }],
    ['missing callee', { [HANDOFF_FIELD]: { ...valid, callee: undefined } }],
    ['non-string caller', { [HANDOFF_FIELD]: { ...valid, caller: 7 } }],
  ])('ignores %s', (_label, content) => {
    expect(readHandoff(content)).toBeUndefined()
  })
  it('tolerates undefined content', () => {
    expect(readHandoff(undefined)).toBeUndefined()
  })
})

describe('resolveHandoffTarget', () => {
  it('resolves a bare agent name', () => {
    const r = resolveHandoffTarget('product', room, candidates)
    expect(r).toEqual({ ok: true, target: candidates[2] })
  })
  it('resolves workstation.agent', () => {
    const r = resolveHandoffTarget('cloud.ops', room, candidates)
    expect(r.ok && r.target.userId).toBe('@cloud.ops:hs')
  })
  it('resolves a full MXID', () => {
    const r = resolveHandoffTarget('@laptop.cpo:hs', room, candidates)
    expect(r.ok && r.target.name).toBe('cpo')
  })
  it('accepts a leading @ on a name', () => {
    const r = resolveHandoffTarget('@product', room, candidates)
    expect(r.ok && r.target.userId).toBe('@cloud.product:hs')
  })
  it('refuses an ambiguous bare name and says how to disambiguate', () => {
    const r = resolveHandoffTarget('ops', room, candidates)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toMatch(/^ambiguous_agent: .*cloud\.ops.*laptop\.ops|^ambiguous_agent: .*laptop\.ops.*cloud\.ops/)
  })
  it('refuses an unknown agent and lists who is in the room', () => {
    const r = resolveHandoffTarget('nobody', room, candidates)
    expect(!r.ok && r.reason).toMatch(/^unknown_agent: /)
    expect(!r.ok && r.reason).toContain('product')
    expect(!r.ok && r.reason).not.toContain('scout')
  })
  it('refuses an agent that is not in this room', () => {
    const r = resolveHandoffTarget('scout', room, candidates)
    expect(!r.ok && r.reason).toMatch(/^not_in_room: /)
  })
})

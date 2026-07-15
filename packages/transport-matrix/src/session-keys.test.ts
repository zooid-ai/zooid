import { describe, it, expect } from 'vitest'
import { HANDOFF_KEY_SEP, composeHandoffKey, sessionKeyFor } from './session-keys.js'
import type { ThreadState } from './router.js'

const state = (handoffs: Record<string, string[]>): ThreadState => ({
  participants: [],
  rootMentions: [],
  callers: {},
  handoffs,
})

describe('composeHandoffKey', () => {
  it('joins threadRoot and callEventId with the separator', () => {
    expect(composeHandoffKey('$root', '$call')).toBe(`$root${HANDOFF_KEY_SEP}$call`)
  })
})

describe('sessionKeyFor', () => {
  it('returns the bare threadRoot when there is no thread state', () => {
    expect(sessionKeyFor('bebop', '$root', undefined)).toBe('$root')
  })

  it('returns the bare threadRoot when the agent has never been called', () => {
    expect(sessionKeyFor('bebop', '$root', state({}))).toBe('$root')
  })

  it('returns the arc key when the agent has been called', () => {
    expect(sessionKeyFor('bebop', '$root', state({ bebop: ['$c1'] }))).toBe('$root|$c1')
  })

  it('a re-delegation wins: the LAST call is the current arc (Option A)', () => {
    expect(sessionKeyFor('bebop', '$root', state({ bebop: ['$c1', '$c2'] }))).toBe('$root|$c2')
  })

  it("another agent's arcs do not leak onto this agent's key", () => {
    // parent called bebop; parent's OWN key stays thread-level.
    expect(sessionKeyFor('parent', '$root', state({ bebop: ['$c1'] }))).toBe('$root')
  })
})

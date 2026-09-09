import { describe, it, expect } from 'vitest'
import { compileMatch, evaluateMatch } from './match-expression.js'

const body = {
  action: 'closed',
  number: 42,
  pull_request: { merged: true },
  repository: { full_name: 'zooid-ai/zooid' },
}
const ctx = { event: 'pull_request', body, headers: { 'x-github-event': 'pull_request' }, output: '{}' }

describe('evaluateMatch', () => {
  it('is true when the predicate holds', () => {
    expect(
      evaluateMatch(compileMatch('event == "pull_request" && body.action == "closed" && body.pull_request.merged'), ctx),
    ).toBe(true)
  })

  it('is false when the predicate does not hold', () => {
    expect(evaluateMatch(compileMatch('body.action == "opened"'), ctx)).toBe(false)
  })

  it('reads headers', () => {
    expect(evaluateMatch(compileMatch('headers["x-github-event"] == "pull_request"'), ctx)).toBe(true)
  })

  // The library returns a CelError value for a missing field rather than
  // throwing or returning false. A merged-PR filter therefore errors on every
  // issues delivery, which is ordinary and must read as "no match".
  it('treats a missing field as no match, not an error and not a fire', () => {
    const m = compileMatch('body.pull_request.merged')
    expect(evaluateMatch(m, { ...ctx, body: { action: 'opened' } })).toBe(false)
  })

  it('supports has() so an operator can guard explicitly', () => {
    const m = compileMatch('has(body.pull_request) && body.pull_request.merged')
    expect(evaluateMatch(m, { ...ctx, body: { action: 'opened' } })).toBe(false)
    expect(evaluateMatch(m, ctx)).toBe(true)
  })

  // Fail closed: only an actual boolean true fires. A non-boolean result must
  // never be coerced.
  it('does not fire on a truthy non-boolean result', () => {
    expect(evaluateMatch(compileMatch('body.action'), ctx)).toBe(false)
    expect(evaluateMatch(compileMatch('body.number'), ctx)).toBe(false)
  })

  it('does not fire on an undeclared variable', () => {
    expect(evaluateMatch(compileMatch('nosuchthing == 1'), ctx)).toBe(false)
  })
})

describe('compileMatch', () => {
  it('rejects a syntax error at compile time, so a typo fails the daemon at boot', () => {
    expect(() => compileMatch('body.action ==')).toThrow()
  })

  it('accepts a valid expression', () => {
    expect(() => compileMatch('body.action == "opened"')).not.toThrow()
  })
})

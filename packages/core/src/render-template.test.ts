import { describe, it, expect } from 'vitest'
import { renderTemplate } from './render-template.js'

const ctx = {
  event: 'issues',
  body: { issue: { number: 23 }, repository: { full_name: 'zooid-ai/zooid' } },
  headers: {},
  output: '{\n  "issue": {}\n}',
}

describe('renderTemplate', () => {
  it('interpolates an expression', () => {
    expect(renderTemplate('Triage ${body.repository.full_name}#${body.issue.number}.', ctx)).toBe(
      'Triage zooid-ai/zooid#23.',
    )
  })

  it('leaves text with no placeholders alone', () => {
    expect(renderTemplate('A PR merged.', ctx)).toBe('A PR merged.')
  })

  // ${output} is not a special case: it is a bound variable like any other, so
  // a whole-payload dump still works for senders we control ([[ZOD081]] §2).
  it('still supports ${output}', () => {
    expect(renderTemplate('Payload:\n${output}', ctx)).toContain('"issue"')
  })

  // A bad placeholder must not take the message down, and must not silently
  // paste an error object into a room.
  it('renders an unresolvable placeholder as empty rather than throwing', () => {
    expect(renderTemplate('x${body.nope.deep}y', ctx)).toBe('xy')
  })

  it('does not re-scan substituted content, so a payload cannot inject a placeholder', () => {
    const evil = { ...ctx, body: { title: '${body.secret}' }, }
    expect(renderTemplate('${body.title}', evil)).toBe('${body.secret}')
  })
})

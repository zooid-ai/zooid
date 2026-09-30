import { describe, it, expect } from 'vitest'
import { unsupportedSchemaReasons, validateElicitationContent } from './elicitation-schema.js'

// The shape claude-agent-acp 0.79 sends for two AskUserQuestion questions.
const askSchema = {
  type: 'object',
  properties: {
    question_0: {
      type: 'string', title: 'Env', description: 'Which environment?',
      oneOf: [{ const: 'staging', title: 'staging' }, { const: 'prod', title: 'prod' }],
    },
    question_0_custom: {
      type: 'string', title: 'Other',
      _meta: { _askUserQuestionCustomAnswer: { questionId: 'question_0', isCustomAnswer: true } },
    },
    question_1: {
      type: 'array', title: 'Checks',
      items: { anyOf: [{ const: 'lint', title: 'Lint' }, { const: 'test', title: 'Test' }] },
    },
    question_1_custom: { type: 'string', title: 'Other' },
  },
} as const

const typed = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 2, maxLength: 5 },
    email: { type: 'string', format: 'email' },
    count: { type: 'integer', minimum: 1, maximum: 3 },
    ratio: { type: 'number', minimum: 0, maximum: 1 },
    ok: { type: 'boolean' },
    tags: { type: 'array', items: { type: 'string', enum: ['a', 'b', 'c'] }, minItems: 1, maxItems: 2 },
  },
  required: ['name', 'ok'],
} as const

describe('unsupportedSchemaReasons', () => {
  it('accepts the AskUserQuestion shape', () => {
    expect(unsupportedSchemaReasons(askSchema)).toEqual([])
  })
  it('accepts every primitive variant', () => {
    expect(unsupportedSchemaReasons(typed)).toEqual([])
  })
  it('names unsupported property types', () => {
    expect(
      unsupportedSchemaReasons({ type: 'object', properties: { o: { type: 'object' } } }),
    ).toEqual(['properties.o: unsupported type "object"'])
  })
  it('names custom multi-select item types', () => {
    expect(
      unsupportedSchemaReasons({ type: 'object', properties: { m: { type: 'array', items: { type: '_x' } } } }),
    ).toEqual(['properties.m: unsupported multi-select items'])
  })
  it('rejects required names that are not properties', () => {
    expect(
      unsupportedSchemaReasons({ type: 'object', properties: {}, required: ['ghost'] }),
    ).toEqual(['required: "ghost" is not a property'])
  })
  it('rejects a non-object root', () => {
    expect(unsupportedSchemaReasons({ type: 'string' })).toEqual(['root: type must be "object"'])
  })
})

describe('validateElicitationContent', () => {
  it('accepts a single choice plus a custom note and a multi-select', () => {
    const r = validateElicitationContent(askSchema as never, {
      question_0: 'prod', question_0_custom: 'after 5pm', question_1: ['lint', 'test'],
    })
    expect(r).toEqual({
      ok: true,
      content: { question_0: 'prod', question_0_custom: 'after 5pm', question_1: ['lint', 'test'] },
    })
  })
  it('accepts an empty answer when nothing is required', () => {
    expect(validateElicitationContent(askSchema as never, {})).toEqual({ ok: true, content: {} })
  })
  it('rejects an option outside oneOf', () => {
    const r = validateElicitationContent(askSchema as never, { question_0: 'dev' })
    expect(r).toEqual({ ok: false, errors: { question_0: 'must be one of: staging, prod' } })
  })
  it('rejects unknown fields', () => {
    const r = validateElicitationContent(askSchema as never, { question_9: 'x' })
    expect(r).toEqual({ ok: false, errors: { question_9: 'unknown field' } })
  })
  it('enforces required, including empty strings', () => {
    const r = validateElicitationContent(typed as never, { name: '' })
    expect(r).toEqual({ ok: false, errors: { name: 'required', ok: 'required' } })
  })
  it('enforces string length and format', () => {
    const r = validateElicitationContent(typed as never, { name: 'x', ok: true, email: 'nope' })
    expect(r).toEqual({
      ok: false,
      errors: { name: 'must be at least 2 characters', email: 'must be a valid email' },
    })
  })
  it('enforces integer and number bounds without coercing strings', () => {
    const r = validateElicitationContent(typed as never, { name: 'ab', ok: true, count: 1.5, ratio: '0.5' })
    expect(r).toEqual({
      ok: false,
      errors: { count: 'must be an integer', ratio: 'must be a number' },
    })
    const r2 = validateElicitationContent(typed as never, { name: 'ab', ok: true, count: 4, ratio: -1 })
    expect(r2).toEqual({ ok: false, errors: { count: 'must be ≤ 3', ratio: 'must be ≥ 0' } })
  })
  it('enforces boolean type', () => {
    const r = validateElicitationContent(typed as never, { name: 'ab', ok: 'yes' })
    expect(r).toEqual({ ok: false, errors: { ok: 'must be true or false' } })
  })
  it('enforces multi-select membership, bounds and uniqueness', () => {
    expect(validateElicitationContent(typed as never, { name: 'ab', ok: true, tags: ['z'] })).toEqual({
      ok: false, errors: { tags: 'must only contain: a, b, c' },
    })
    expect(validateElicitationContent(typed as never, { name: 'ab', ok: true, tags: ['a', 'b', 'c'] })).toEqual({
      ok: false, errors: { tags: 'choose at most 2' },
    })
    expect(validateElicitationContent(typed as never, { name: 'ab', ok: true, tags: ['a', 'a'] })).toEqual({
      ok: false, errors: { tags: 'must not repeat a choice' },
    })
  })
  it('rejects non-object content', () => {
    expect(validateElicitationContent(typed as never, 'x')).toEqual({
      ok: false, errors: { _: 'content must be an object' },
    })
  })
})

describe('literal field names', () => {
  it('preserves prototype-like property names as answer data', () => {
    const schema = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}')
    const content = JSON.parse('{"__proto__":"literal answer"}')
    const result = validateElicitationContent(schema, content)
    expect(result.ok).toBe(true)
    if (result.ok) expect(JSON.stringify(result.content)).toBe('{"__proto__":"literal answer"}')
  })
  it('fails unsupported string formats visibly', () => {
    expect(unsupportedSchemaReasons({ type: 'object', properties: { x: { type: 'string', format: '_vendor' } } })).toEqual(['properties.x: unsupported format "_vendor"'])
  })
})

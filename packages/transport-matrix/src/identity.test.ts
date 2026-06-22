import { describe, it, expect } from 'vitest'
import {
  isValidSlug,
  isValidAgentKey,
  agentMxid,
  splitAgentLocalpart,
  slugUserNamespace,
} from './identity.js'

describe('slug / agent grammar', () => {
  it('accepts dot-free lowercase-alnum-hyphen', () => {
    expect(isValidSlug('laptop')).toBe(true)
    expect(isValidSlug('ec2-prod')).toBe(true)
    expect(isValidAgentKey('docs')).toBe(true)
  })
  it('rejects dots (the slug/agent separator) and bad chars', () => {
    expect(isValidSlug('lap.top')).toBe(false) // dot is the boundary, never inside
    expect(isValidSlug('Laptop')).toBe(false) // strict ASCII lowercase
    expect(isValidSlug('lap_top')).toBe(false)
    expect(isValidSlug('')).toBe(false)
    expect(isValidAgentKey('a.b')).toBe(false)
  })
})

describe('agentMxid', () => {
  it('builds @{slug}.{agent}:server', () => {
    expect(agentMxid('laptop', 'assistant', 'zoon.eco')).toBe('@laptop.assistant:zoon.eco')
  })
  it('throws on invalid parts', () => {
    expect(() => agentMxid('lap.top', 'assistant', 'zoon.eco')).toThrow()
    expect(() => agentMxid('laptop', 'a.b', 'zoon.eco')).toThrow()
  })
})

describe('splitAgentLocalpart — split on FIRST dot', () => {
  it('recovers (slug, agent)', () => {
    expect(splitAgentLocalpart('laptop.assistant')).toEqual({ slug: 'laptop', agent: 'assistant' })
  })
  it('throws when there is no separator', () => {
    expect(() => splitAgentLocalpart('zooid')).toThrow()
  })
})

describe('slugUserNamespace', () => {
  it('emits an escaped-dot exclusive regex for the slug', () => {
    // The literal dot must be escaped so @{slug}.* does not also match @{slug}X*
    expect(slugUserNamespace('laptop', 'zoon.eco')).toBe('@laptop\\..*:zoon.eco')
  })
})

import { describe, it, expect } from 'vitest'
import {
  isValidWorkstation,
  isValidAgentKey,
  agentMxid,
  splitAgentLocalpart,
  workstationUserNamespace,
} from './identity.js'

describe('workstation / agent grammar', () => {
  it('accepts dot-free lowercase-alnum-hyphen', () => {
    expect(isValidWorkstation('laptop')).toBe(true)
    expect(isValidWorkstation('ec2-prod')).toBe(true)
    expect(isValidAgentKey('docs')).toBe(true)
  })
  it('rejects dots (the workstation/agent separator) and bad chars', () => {
    expect(isValidWorkstation('lap.top')).toBe(false) // dot is the boundary, never inside
    expect(isValidWorkstation('Laptop')).toBe(false) // strict ASCII lowercase
    expect(isValidWorkstation('lap_top')).toBe(false)
    expect(isValidWorkstation('')).toBe(false)
    expect(isValidAgentKey('a.b')).toBe(false)
  })
})

describe('agentMxid', () => {
  it('builds @{workstation}.{agent}:server', () => {
    expect(agentMxid('laptop', 'assistant', 'zoon.eco')).toBe('@laptop.assistant:zoon.eco')
  })
  it('throws on invalid parts', () => {
    expect(() => agentMxid('lap.top', 'assistant', 'zoon.eco')).toThrow()
    expect(() => agentMxid('laptop', 'a.b', 'zoon.eco')).toThrow()
  })
})

describe('splitAgentLocalpart — split on FIRST dot', () => {
  it('recovers (workstation, agent)', () => {
    expect(splitAgentLocalpart('laptop.assistant')).toEqual({
      workstation: 'laptop',
      agent: 'assistant',
    })
  })
  it('throws when there is no separator', () => {
    expect(() => splitAgentLocalpart('zooid')).toThrow()
  })
})

describe('workstationUserNamespace', () => {
  it('emits an escaped-dot exclusive regex for the workstation', () => {
    // The literal dot must be escaped so @{workstation}.* does not also match @{workstation}X*
    expect(workstationUserNamespace('laptop', 'zoon.eco')).toBe('@laptop\\..*:zoon.eco')
  })
})

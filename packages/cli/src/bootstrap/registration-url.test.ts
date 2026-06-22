import { describe, it, expect } from 'vitest'
import { deriveRegistrationUrl } from './registration-url.js'

describe('deriveRegistrationUrl', () => {
  it('port → co-located host.docker.internal shorthand', () => {
    expect(deriveRegistrationUrl({ port: 9099 })).toBe('http://host.docker.internal:9099')
  })
  it('advertise_url → verbatim', () => {
    expect(deriveRegistrationUrl({ advertise_url: 'http://10.0.1.5:9099' })).toBe('http://10.0.1.5:9099')
  })
  it('throws if both are present (caller should have rejected earlier, defense-in-depth)', () => {
    expect(() => deriveRegistrationUrl({ port: 9099, advertise_url: 'http://x:1' })).toThrow()
  })
})

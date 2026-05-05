import { describe, it, expect } from 'vitest'
import { renderRegistration, type MatrixTransportConfig } from './registration.js'

const baseConfig: MatrixTransportConfig = {
  id: 'zooid',
  url: 'http://daemon:8080',
  homeserver: 'https://matrix.example.com',
  asToken: 'as-secret',
  hsToken: 'hs-secret',
  senderLocalpart: 'zooid',
  userNamespace: '@.*:example.com',
}

describe('renderRegistration', () => {
  it('emits the six required AS fields', () => {
    const yaml = renderRegistration(baseConfig)
    expect(yaml).toContain('id: zooid')
    expect(yaml).toContain('url: http://daemon:8080')
    expect(yaml).toContain('as_token: as-secret')
    expect(yaml).toContain('hs_token: hs-secret')
    expect(yaml).toContain('sender_localpart: zooid')
    expect(yaml).toMatch(/namespaces:\s/)
  })

  it('marks the user namespace exclusive', () => {
    const yaml = renderRegistration(baseConfig)
    expect(yaml).toMatch(/users:\s*\n\s*-\s*exclusive:\s*true/)
    expect(yaml).toContain("regex: '@.*:example.com'")
  })

  it('emits empty aliases and rooms namespaces', () => {
    const yaml = renderRegistration(baseConfig)
    expect(yaml).toMatch(/aliases:\s*\[\]/)
    expect(yaml).toMatch(/rooms:\s*\[\]/)
  })

  it('disables rate limiting (AS calls bypass HS rate limits)', () => {
    const yaml = renderRegistration(baseConfig)
    expect(yaml).toContain('rate_limited: false')
  })
})

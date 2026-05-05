import { describe, expect, it } from 'vitest'
import { loadWorkforceConfig } from './config.js'

const minimal = `
runtime: docker

transports:
  matrix-local:
    type: matrix
    homeserver: http://localhost:8448
    as_token: as-x
    hs_token: hs-x
    sender_localpart: zooid
    user_namespace: '@.*:localhost'

agents:
  assistant:
    transport: matrix-local
    matrix_user_id: '@assistant:localhost'
    rooms: ['!general:localhost']
    trigger: mention
    workdir: .
    acp: { preset: claude }
`

describe('loadWorkforceConfig — new shape', () => {
  it('parses a single-matrix-transport workforce', () => {
    const c = loadWorkforceConfig(minimal)
    expect(c.transports['matrix-local']).toMatchObject({
      type: 'matrix',
      homeserver: 'http://localhost:8448',
      as_token: 'as-x',
      hs_token: 'hs-x',
      sender_localpart: 'zooid',
      user_namespace: '@.*:localhost',
    })
    expect(c.agents.assistant.transport).toBe('matrix-local')
    expect(c.agents.assistant.matrix_user_id).toBe('@assistant:localhost')
  })

  it('runtime defaults to docker when omitted', () => {
    const yaml = `
transports:
  http-only:
    type: http
    port: 8080
agents:
  one:
    transport: http-only
    workdir: .
    acp: { preset: claude }
`
    expect(loadWorkforceConfig(yaml).runtime).toBe('docker')
  })

  it('errors when transports is empty', () => {
    expect(() =>
      loadWorkforceConfig(`
transports: {}
agents:
  a:
    transport: x
    workdir: .
    acp: { preset: claude }
`),
    ).toThrow(/transports.*at least one/i)
  })

  it("errors when an agent's transport reference doesn't exist", () => {
    expect(() =>
      loadWorkforceConfig(`
transports:
  matrix-local:
    type: matrix
    homeserver: http://localhost:8448
    as_token: as-x
    hs_token: hs-x
    sender_localpart: zooid
    user_namespace: '@.*:localhost'
agents:
  oops:
    transport: ghost
    workdir: .
    acp: { preset: claude }
`),
    ).toThrow(/agents\.oops\.transport.*ghost.*not declared/i)
  })

  it('errors when a transport has an unknown type', () => {
    expect(() =>
      loadWorkforceConfig(`
transports:
  bad:
    type: smtp
agents:
  a:
    transport: bad
    workdir: .
    acp: { preset: claude }
`),
    ).toThrow(/transports\.bad\.type.*matrix.*http/i)
  })

  it('errors when matrix-only fields appear on a non-matrix-transport agent', () => {
    expect(() =>
      loadWorkforceConfig(`
transports:
  http-only:
    type: http
    port: 8080
agents:
  one:
    transport: http-only
    matrix_user_id: '@x:y'
    workdir: .
    acp: { preset: claude }
`),
    ).toThrow(/matrix_user_id.*only valid.*matrix/i)
  })

  it('errors when a matrix-transport agent omits matrix_user_id', () => {
    expect(() =>
      loadWorkforceConfig(`
transports:
  matrix-local:
    type: matrix
    homeserver: http://localhost:8448
    as_token: as-x
    hs_token: hs-x
    sender_localpart: zooid
    user_namespace: '@.*:localhost'
agents:
  oops:
    transport: matrix-local
    workdir: .
    acp: { preset: claude }
`),
    ).toThrow(/agents\.oops\.matrix_user_id.*required/i)
  })

  it('allows multiple transports of mixed types', () => {
    const yaml = `
transports:
  matrix-local:
    type: matrix
    homeserver: http://localhost:8448
    as_token: as-x
    hs_token: hs-x
    sender_localpart: zooid
    user_namespace: '@.*:localhost'
  http-direct:
    type: http
    port: 8080
agents:
  m:
    transport: matrix-local
    matrix_user_id: '@m:localhost'
    rooms: ['!a:localhost']
    workdir: .
    acp: { preset: claude }
  h:
    transport: http-direct
    workdir: .
    acp: { preset: claude }
`
    const c = loadWorkforceConfig(yaml)
    expect(Object.keys(c.transports)).toEqual(['matrix-local', 'http-direct'])
    expect(c.agents.m.transport).toBe('matrix-local')
    expect(c.agents.h.transport).toBe('http-direct')
  })
})
